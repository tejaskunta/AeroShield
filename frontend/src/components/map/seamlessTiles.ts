import L from 'leaflet'

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
}

const cache = new Map<string, Promise<HTMLImageElement>>()

function loadImage(url: string): Promise<HTMLImageElement> {
  let p = cache.get(url)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      // Not read back, only drawn, so a tainted canvas is fine and no CORS is needed.
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => {
        cache.delete(url)
        reject(new Error(`tile failed: ${url}`))
      }
      img.src = url
    })
    cache.set(url, p)
    // Bounded: a long session must not hold every tile it ever saw.
    if (cache.size > 400) cache.delete(cache.keys().next().value as string)
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
    const s = subs ? subs[Math.abs(px + py) % subs.length] : ''
    const url = L.Util.template(o.url, { x: px, y: py, z: coords.z - dz, s })

    loadImage(url).then(
      (img) => {
        const ctx = canvas.getContext('2d')
        if (!ctx) return done(undefined, canvas)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        const src = img.naturalWidth / f // source pixels per output tile
        const sx = (coords.x - px * f) * src
        const sy = (coords.y - py * f) * src
        // One source pixel of bleed on every side, clamped to the image.
        const b = 1
        const x0 = Math.max(0, sx - b)
        const y0 = Math.max(0, sy - b)
        const x1 = Math.min(img.naturalWidth, sx + src + b)
        const y1 = Math.min(img.naturalHeight, sy + src + b)
        const k = canvas.width / src
        ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k)
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
