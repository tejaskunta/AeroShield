import { useEffect, useMemo, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { CustomLayerInterface, GeoJSONSource, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as THREE from 'three'
import type { Detection, LatLng, MissionProgress, Telemetry } from '@/types'
import { MISSION } from '@/lib/mockData'
import { ESRI_LABELS_URL, ESRI_WORLD_IMAGERY_URL, FIT_MAX_ZOOM, MAX_LIVE_MAP_ZOOM } from '@/lib/config'
import { cellBounds, gridBounds, gridCenter, offsetM, parseCellId, validCoordinate } from '@/lib/geo'
import { riskOf } from '@/lib/risk'
import { detectionGlyphHtml, pinSize } from '@/components/map/markerGlyphs'
import type { Basemap } from '@/components/map/basemaps'
import type { LayerState } from '@/components/map/LayerToggles'
import type { FollowMode } from '@/components/map/useMapHooks'
import type { DroneOverlayMeta } from '@/components/map/DroneImageryLayer'
import type { MapControls, MapViewState } from '@/components/map/viewTypes'

/**
 * LiveMap3D — the tilted, rotatable view. MapLibre GL, loaded only when opened.
 *
 * Everything here is keyless and free, so the 3D view has no billing to break:
 *   imagery    Esri World Imagery (same tiles as 2D; real to z19 here)
 *   terrain    AWS "terrarium" elevation tiles (Mapzen), exaggeration 1
 *   buildings  OpenFreeMap vector tiles (OpenMapTiles schema), extruded by height
 *
 * It is a second view of the same mission, not a second source of truth: the same
 * detections, selection, layers and drone overlay are passed in as for 2D, and the
 * pins are drawn from the same glyph markup so a hazard looks identical in both.
 *
 * The drone is a procedural three.js model in a custom layer, placed at its reported
 * altitude with a vertical tether and a ground shadow, so height reads as height.
 * It is drawn DRONE_SCALE times real size: a ~0.5 m airframe is a few pixels at the
 * working zoom, and an object you cannot see cannot be tracked. The chrome says so.
 */
export const DRONE_SCALE = 4
const PITCH = 58
const BEARING = -18

const OSM_TILES = ['a', 'b', 'c'].map((s) => `https://${s}.tile.openstreetmap.org/{z}/{x}/{y}.png`)

function buildStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      esri: { type: 'raster', tiles: [ESRI_WORLD_IMAGERY_URL], tileSize: 256, maxzoom: 19 },
      labels: { type: 'raster', tiles: [ESRI_LABELS_URL], tileSize: 256, maxzoom: 19 },
      osm: { type: 'raster', tiles: OSM_TILES, tileSize: 256, maxzoom: 19 },
      terrain: {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
      },
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#070a0e' } },
      // Same haze correction as 2D: Esri's photo over the block is flat and washed out.
      { id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-contrast': 0.12, 'raster-saturation': 0.15 } },
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.6, 'raster-brightness-max': 0.7 } },
      { id: 'labels', type: 'raster', source: 'labels', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9 } },
      {
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'ofm',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#b9c4cf',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.2,
          'fill-extrusion-vertical-gradient': true,
        },
      },
    ],
    terrain: { source: 'terrain', exaggeration: 1 },
  }
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

function gridLines(): GeoJSON.FeatureCollection {
  const g = MISSION.grid
  const feats: GeoJSON.Feature[] = []
  const W = g.cols * g.cellSizeM
  const H = g.rows * g.cellSizeM
  for (let c = 0; c <= g.cols; c++) {
    const a = offsetM(g.origin, c * g.cellSizeM, 0)
    const b = offsetM(g.origin, c * g.cellSizeM, H)
    feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } })
  }
  for (let r = 0; r <= g.rows; r++) {
    const a = offsetM(g.origin, 0, r * g.cellSizeM)
    const b = offsetM(g.origin, W, r * g.cellSizeM)
    feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } })
  }
  return { type: 'FeatureCollection', features: feats }
}

function coveredCells(ids: readonly string[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const id of ids) {
    const c = parseCellId(id)
    if (!c) continue
    const [[s, w], [n, e]] = cellBounds(MISSION.grid, c.col, c.row)
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    })
  }
  return { type: 'FeatureCollection', features }
}

function trackLine(points: readonly LatLng[]): GeoJSON.FeatureCollection {
  const coords = points.filter(validCoordinate).map((p) => [p.lon, p.lat])
  if (coords.length < 2) return EMPTY
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] }
}

/** A small quadcopter in metres: x east, y north, z up. Nose is +y. */
function makeDrone(): { root: THREE.Group; rotors: THREE.Mesh[]; tether: THREE.Line; shadow: THREE.Mesh } {
  const root = new THREE.Group()
  const model = new THREE.Group()
  model.scale.setScalar(DRONE_SCALE)
  root.add(model)

  // Light hull, dark arms: reads against both bright ground and dark foliage.
  const body = new THREE.MeshStandardMaterial({ color: 0x1b222b, metalness: 0.3, roughness: 0.5 })
  const trim = new THREE.MeshStandardMaterial({ color: 0xf2f5f8, metalness: 0.1, roughness: 0.45 })
  const accent = new THREE.MeshStandardMaterial({ color: 0x5cc8f5, emissive: 0x5cc8f5, emissiveIntensity: 0.9 })

  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.06), trim)
  model.add(hull)
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.15, 0.025), trim)
  lid.position.z = 0.04
  model.add(lid)
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), accent)
  nose.position.set(0, 0.115, 0.01)
  model.add(nose)

  const rotors: THREE.Mesh[] = []
  const rotorMat = new THREE.MeshBasicMaterial({ color: 0xe9edf1, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    const ang = Math.atan2(sy, sx)
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.022, 0.018), body)
    arm.position.set(Math.cos(ang) * 0.12, Math.sin(ang) * 0.12, 0.005)
    arm.rotation.z = ang
    model.add(arm)
    const tip = { x: Math.cos(ang) * 0.22, y: Math.sin(ang) * 0.22 }
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.035, 14), trim)
    motor.rotation.x = Math.PI / 2
    motor.position.set(tip.x, tip.y, 0.02)
    model.add(motor)
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.11, 28), rotorMat)
    disc.position.set(tip.x, tip.y, 0.042)
    model.add(disc)
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.004), trim)
    blade.position.set(tip.x, tip.y, 0.044)
    model.add(blade)
    rotors.push(blade)
  }

  // Tether and shadow live outside the scaled model: they are measured in real metres.
  const tether = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineDashedMaterial({ color: 0x5cc8f5, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.8 }),
  )
  tether.computeLineDistances()
  root.add(tether)
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55 * DRONE_SCALE * 0.5, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
  )
  root.add(shadow)
  return { root, rotors, tether, shadow }
}

type DroneState = { lon: number; lat: number; altM: number; headingDeg: number } | null

function makeDroneLayer(getState: () => DroneState): CustomLayerInterface {
  let renderer: THREE.WebGLRenderer
  let scene: THREE.Scene
  let camera: THREE.Camera
  let drone: ReturnType<typeof makeDrone>
  let mapRef: maplibregl.Map
  return {
    id: 'drone-3d',
    type: 'custom',
    renderingMode: '3d',
    onAdd(map, gl) {
      mapRef = map
      camera = new THREE.Camera()
      scene = new THREE.Scene()
      scene.add(new THREE.AmbientLight(0xffffff, 1.4))
      const sun = new THREE.DirectionalLight(0xffffff, 2.2)
      sun.position.set(-1, 1.5, 3)
      scene.add(sun)
      drone = makeDrone()
      scene.add(drone.root)
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })
      renderer.autoClear = false
    },
    // MapLibre 4 passes the projection matrix; 5 passes an options object. Accept both.
    render(_gl, arg: unknown) {
      const st = getState()
      if (!st) return
      const a = arg as { defaultProjectionData?: { mainMatrix: number[] }; modelViewProjectionMatrix?: number[] } | number[]
      const matrix = Array.isArray(a) || ArrayBuffer.isView(a) ? (a as number[]) : a.defaultProjectionData?.mainMatrix ?? a.modelViewProjectionMatrix
      if (!matrix) return

      const ground =
        (mapRef as unknown as { queryTerrainElevation?: (l: [number, number]) => number | null }).queryTerrainElevation?.([st.lon, st.lat]) ?? 0
      const alt = Math.max(0.2, st.altM)
      const mc = maplibregl.MercatorCoordinate.fromLngLat([st.lon, st.lat], ground + alt)
      const u = mc.meterInMercatorCoordinateUnits()

      drone.tether.scale.set(1, 1, alt)
      drone.shadow.position.z = -alt + 0.02
      drone.root.rotation.z = -(st.headingDeg * Math.PI) / 180
      // Blades at a fixed 45°: spinning them meant repainting the whole 3D map every
      // frame, which keeps a field laptop's GPU busy for nothing.
      for (const r of drone.rotors) r.rotation.z = Math.PI / 4

      const m = new THREE.Matrix4().fromArray(matrix as number[])
      const l = new THREE.Matrix4().makeTranslation(mc.x, mc.y, mc.z).scale(new THREE.Vector3(u, -u, u))
      camera.projectionMatrix = m.multiply(l)
      renderer.resetState()
      renderer.render(scene, camera)
    },
  }
}

export default function LiveMap3D({
  telemetry,
  progress,
  detections,
  selectedId,
  onSelect,
  onMapClick,
  basemap,
  layers,
  follow,
  refitKey,
  droneOverlay,
  initialView,
  onControls,
  onBearing,
}: {
  telemetry: Telemetry | null
  progress: MissionProgress | null
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMapClick?: (p: LatLng) => void
  basemap: Basemap
  layers: LayerState
  follow: FollowMode
  refitKey: number
  droneOverlay: DroneOverlayMeta | null
  initialView?: MapViewState | null
  onControls?: (c: MapControls | null) => void
  onBearing?: (deg: number) => void
}) {
  const holder = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const loaded = useRef(false)
  const droneState = useRef<DroneState>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const droneMarker = useRef<maplibregl.Marker | null>(null)
  const droneLabel = useRef<HTMLSpanElement | null>(null)
  const droneLabelMarker = useRef<maplibregl.Marker | null>(null)
  const cb = useRef({ onSelect, onMapClick, onBearing })
  cb.current = { onSelect, onMapClick, onBearing }

  const extent = useMemo(() => {
    const [[s, w], [n, e]] = gridBounds(MISSION.grid)
    const box = { s, w, n, e }
    progress?.track.forEach((p) => {
      if (!validCoordinate(p)) return
      box.s = Math.min(box.s, p.lat)
      box.n = Math.max(box.n, p.lat)
      box.w = Math.min(box.w, p.lon)
      box.e = Math.max(box.e, p.lon)
    })
    return box
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.track.length])

  // Create once.
  useEffect(() => {
    if (!holder.current || mapRef.current) return
    const c = gridCenter(MISSION.grid)
    const map = new maplibregl.Map({
      container: holder.current,
      style: buildStyle(),
      center: initialView ? [initialView.lon, initialView.lat] : [c.lon, c.lat],
      zoom: initialView ? Math.min(initialView.zoom, FIT_MAX_ZOOM) : 20.3,
      pitch: PITCH,
      bearing: BEARING,
      minZoom: 15,
      maxZoom: MAX_LIVE_MAP_ZOOM,
      maxPitch: 75,
      attributionControl: false,
    })
    mapRef.current = map

    map.on('load', () => {
      loaded.current = true
      map.addSource('grid', { type: 'geojson', data: gridLines() })
      map.addSource('coverage', { type: 'geojson', data: EMPTY })
      map.addSource('track', { type: 'geojson', data: EMPTY })
      map.addLayer({ id: 'coverage', type: 'fill', source: 'coverage', paint: { 'fill-color': '#e9edf1', 'fill-opacity': 0.1 } })
      map.addLayer({ id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#e9edf1', 'line-opacity': 0.45, 'line-width': 1 } })
      map.addLayer({
        id: 'track',
        type: 'line',
        source: 'track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#5cc8f5', 'line-width': 2.5, 'line-opacity': 0.9 },
      })
      map.addLayer(makeDroneLayer(() => droneState.current))
      // Sync everything that may have arrived before the style finished loading.
      map.fire('aeroshield:sync')
    })

    map.on('click', (e) => {
      cb.current.onMapClick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng })
    })
    map.on('rotate', () => cb.current.onBearing?.(map.getBearing()))

    onControls?.({
      zoomIn: () => map.zoomIn(),
      zoomOut: () => map.zoomOut(),
      flyTo: (lat, lon) => map.easeTo({ center: [lon, lat], duration: 600 }),
      resetNorth: () => map.easeTo({ bearing: 0, pitch: 0, duration: 600 }),
      getView: () => {
        const ctr = map.getCenter()
        return { lat: ctr.lat, lon: ctr.lng, zoom: map.getZoom() }
      },
    })

    // The drone's ground mark: a pulsing accent ring under it and a label chip, so it
    // can be found at a glance; the 3D tether rises from this ring to the airframe.
    const el = document.createElement('div')
    el.className = 'aeroshield-drone3d'
    el.innerHTML = '<span class="aeroshield-drone3d__pulse"></span><span class="aeroshield-drone3d__ring"></span>'
    droneMarker.current = new maplibregl.Marker({ element: el, pitchAlignment: 'map', rotationAlignment: 'map' })
    // The label is a separate, screen-aligned marker: on the flat ring it rendered
    // skewed into the ground plane and was hard to read.
    const label = document.createElement('span')
    label.className = 'aeroshield-drone3d__label'
    droneLabel.current = label
    droneLabelMarker.current = new maplibregl.Marker({ element: label, anchor: 'bottom', offset: [0, -34] })

    return () => {
      onControls?.(null)
      droneMarker.current?.remove()
      droneMarker.current = null
      droneLabelMarker.current?.remove()
      droneLabelMarker.current = null
      markers.current.forEach((m) => m.remove())
      markers.current = []
      map.remove()
      mapRef.current = null
      loaded.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Basemap + layer visibility, and data, re-applied once the style is ready.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      if (!loaded.current) return
      const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
      vis('esri', basemap !== 'roadmap')
      vis('osm', basemap === 'roadmap')
      vis('labels', basemap === 'hybrid')
      vis('grid', layers.grid)
      vis('coverage', layers.coverage)
      vis('track', layers.track)
      ;(map.getSource('coverage') as GeoJSONSource | undefined)?.setData(coveredCells(progress?.coveredCells ?? []))
      ;(map.getSource('track') as GeoJSONSource | undefined)?.setData(trackLine(progress?.track ?? []))
    }
    apply()
    map.on('aeroshield:sync', apply)
    return () => {
      map.off('aeroshield:sync', apply)
    }
  }, [basemap, layers, progress, progress?.track.length, progress?.coveredCells.length])

  // Drone photo overlay as an image source pinned to its bounds.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      if (!loaded.current) return
      if (map.getLayer('drone-photo')) map.removeLayer('drone-photo')
      if (map.getSource('drone-photo')) map.removeSource('drone-photo')
      if (!droneOverlay || !layers.drone) return
      const [[s, w], [n, e]] = droneOverlay.bounds
      map.addSource('drone-photo', {
        type: 'image',
        url: `/overlay/${droneOverlay.image}?v=${encodeURIComponent(droneOverlay.capturedAt)}`,
        coordinates: [[w, n], [e, n], [e, s], [w, s]],
      })
      map.addLayer({ id: 'drone-photo', type: 'raster', source: 'drone-photo' }, 'buildings')
    }
    apply()
    map.on('aeroshield:sync', apply)
    return () => {
      map.off('aeroshield:sync', apply)
    }
  }, [droneOverlay, layers.drone])

  // Drone position for the custom layer.
  useEffect(() => {
    droneState.current = telemetry && validCoordinate(telemetry.position)
      ? { lon: telemetry.position.lon, lat: telemetry.position.lat, altM: telemetry.altitudeM, headingDeg: telemetry.headingDeg }
      : null
    const map = mapRef.current
    const st = droneState.current
    if (map && droneMarker.current) {
      if (st) {
        droneMarker.current.setLngLat([st.lon, st.lat]).addTo(map)
        droneLabelMarker.current?.setLngLat([st.lon, st.lat]).addTo(map)
        if (droneLabel.current) droneLabel.current.textContent = `Drone · ${st.altM.toFixed(1)} m up`
      } else {
        droneMarker.current.remove()
        droneLabelMarker.current?.remove()
      }
    }
    map?.triggerRepaint()
    if (follow === 'follow' && telemetry && validCoordinate(telemetry.position)) {
      mapRef.current?.easeTo({ center: [telemetry.position.lon, telemetry.position.lat], duration: 400 })
    }
  }, [telemetry, follow])

  // Fit block (+ track) on request, keeping the tilt.
  useEffect(() => {
    const map = mapRef.current
    if (!map || follow !== 'fit') return
    if (refitKey === 0 && initialView) return
    map.fitBounds([[extent.w, extent.s], [extent.e, extent.n]], {
      padding: { top: 90, bottom: 260, left: 60, right: 120 },
      maxZoom: FIT_MAX_ZOOM,
      pitch: PITCH,
      bearing: map.getBearing(),
      duration: refitKey === 0 ? 0 : 700,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refitKey, follow])

  // Detection pins: same glyphs as 2D.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markers.current.forEach((m) => m.remove())
    markers.current = []
    if (!layers.detections) return
    for (const d of detections) {
      if (!validCoordinate(d.position)) continue
      const selected = d.id === selectedId
      const size = pinSize(selected)
      const el = document.createElement('div')
      el.className = 'aeroshield-pin-icon'
      el.style.width = `${size}px`
      el.style.height = `${size}px`
      el.style.cursor = 'pointer'
      el.innerHTML = detectionGlyphHtml(riskOf(d), d.review.state, selected)
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        cb.current.onSelect(d.id)
      })
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([d.position.lon, d.position.lat]).addTo(map))
    }
  }, [detections, selectedId, layers.detections])

  // The holder is sized by its parent, not by `absolute inset-0` on itself:
  // MapLibre's stylesheet sets `.maplibregl-map { position: relative }`, which
  // overrides the inset and collapses the canvas to zero height (a black map).
  return (
    <div className="absolute inset-0">
      <div ref={holder} className="h-full w-full" aria-label="3D mission map" />
    </div>
  )
}
