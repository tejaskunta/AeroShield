import L from 'leaflet'
import type { TileRequest, TileResponse } from './tileWorker'

/**
 * SeamlessTileLayer — raster tiles past their native zoom, without seams.
 *
 * WHY: Leaflet's own answer to "zoom past the imagery" (`maxNativeZoom`) keeps the
 * z19 <img> tiles and CSS-scales their whole container, ~2-8x here. On a real GPU
 * each tile is then composited as its own stretched layer, and the edges between
 * them land on fractional device pixels; Chrome blends those edge texels and the
 * operator sees a pale line along every tile boundary across the imagery. A 1 px
 * CSS overlap did not survive that in a real browser.
 *
 * WHAT THIS DOES INSTEAD: tiles are requested at the map's own zoom, and each one is
 * a <canvas> cut from its z19 ancestor and resampled by the browser's high-quality
 * scaler (`imageSmoothingQuality = 'high'`) at the screen's pixel density. There is
 * no large CSS scale left — at most the 2^0.5 of a half-step zoom — so there is no
 * stretched seam to show. Each canvas also draws one source pixel of bleed past its
 * edges, so even that small scale cannot open a gap. And a high-quality resample
 * of the z19 photo looks visibly less blocky than a GPU bilinear stretch.
 *
 * It does not add detail. Past z19 the picture is the z19 photo, drawn well; the
 * real detail at z21-23 is the drone photo overlay.
 */
interface SeamlessOptions extends L.GridLayerOptions {
  url: string
  nativeZoom: number
  subdomains?: string
  className?: string
  /**
   * Unsharp-mask strength (0 = off), applied once per source tile in a worker.
   * Imagery only: it strengthens edges that are in the photo and adds none that
   * are not. Needs CORS on the tile server (Esri and OSM send it).
   */
  sharpen?: number
}

/* ---------------------------------------------------------------------------
 * Source tiles, decoded and (for imagery) sharpened ONCE in a worker, cached as
 * ImageBitmaps and reused by every zoom level. Doing that work per on-screen tile
 * on the main thread blocked the page for ~13 s on load (measured: 69% of load
 * CPU), which was the lag on load and zoom.
 * ------------------------------------------------------------------------- */
let worker: Worker | null | undefined
let seq = 0
const waiting = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>()

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw new Error('unsupported')
    worker = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<TileResponse>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      if (e.data.bitmap) w.resolve(e.data.bitmap)
      else w.reject(new Error(e.data.error ?? 'tile failed'))
    }
  } catch {
    worker = null
  }
  return worker
}

/** Main-thread fallback (no worker support): decode only, no sharpening. */
function decodeOnMain(url: string): Promise<ImageBitmap | HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`tile failed: ${url}`))
    img.src = url
  })
}

type Source = ImageBitmap | HTMLImageElement
const cache = new Map<string, Promise<Source>>()
const CACHE_MAX = 300

function loadSource(url: string, amount: number): Promise<Source> {
  const key = `${amount}|${url}`
  const hit = cache.get(key)
  if (hit) {
    // LRU touch.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const w = getWorker()
  const p: Promise<Source> = w
    ? new Promise<ImageBitmap>((resolve, reject) => {
        const id = ++seq
        waiting.set(id, { resolve, reject })
        w.postMessage({ id, url, amount } satisfies TileRequest)
      })
    : decodeOnMain(url)
  p.catch(() => cache.delete(key))
  cache.set(key, p)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string
    const old = cache.get(oldest)
    cache.delete(oldest)
    old?.then((b) => ('close' in b ? b.close() : undefined)).catch(() => {})
  }
  return p
}

export const SeamlessTileLayer = L.GridLayer.extend({
  createTile(this: L.GridLayer & { options: SeamlessOptions }, coords: L.Coords, done: L.DoneCallback) {
    const size = this.getTileSize()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(size.x * dpr)
    canvas.height = Math.round(size.y * dpr)

    const o = this.options
    const dz = Math.max(0, coords.z - o.nativeZoom)
    const f = 2 ** dz
    const px = Math.floor(coords.x / f)
    const py = Math.floor(coords.y / f)
    const subs = o.subdomains ?? ''
    const url = L.Util.template(o.url, {
      x: px, y: py, z: coords.z - dz, s: subs ? subs[Math.abs(px + py) % subs.length] : '',
    })

    loadSource(url, o.sharpen ?? 0).then(
      (img) => {
        const ctx = canvas.getContext('2d')
        if (!ctx) return done(undefined, canvas)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        // This tile is one square of its z19 parent: a single GPU blit of that
        // region, upscaled. The 1 px CSS overlap (index.css) covers the joins; the
        // container is never scaled more than a half-step zoom's 1.41x.
        const S = img.width
        const src = S / f
        ctx.drawImage(img, (coords.x - px * f) * src, (coords.y - py * f) * src, src, src, 0, 0, canvas.width, canvas.height)
        done(undefined, canvas)
      },
      (err: Error) => done(err, canvas),
    )
    return canvas
  },
}) as unknown as new (opts: SeamlessOptions) => L.GridLayer

export function seamlessTileLayer(opts: SeamlessOptions): L.GridLayer {
  return new SeamlessTileLayer(opts)
}
