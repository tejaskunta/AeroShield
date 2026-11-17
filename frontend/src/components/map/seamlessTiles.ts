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
  /**
   * Unsharp-mask strength (0 = off). Imagery only: it strengthens edges that are
   * in the photo and adds none that are not. Needs CORS on the tile server (Esri
   * and OSM both send `Access-Control-Allow-Origin: *`); if pixel access is ever
   * refused the tile is drawn unsharpened rather than failing.
   */
  sharpen?: number
}

/**
 * Unsharp mask in place: out = in + amount * (in - blur(in)), box blur of radius r.
 *
 * Measured on the survey block, Esri's z19 photo is the sharpest capture in its
 * own archive (Wayback, 158 releases, variance-of-Laplacian), so no source swap
 * helps; what does help is not letting the upscale soften it further. The blur
 * radius follows the upscale factor so the mask acts on the photo's real edges,
 * not on interpolation steps.
 */
function unsharp(img: ImageData, r: number, amount: number): void {
  const { width: w, height: h, data } = img
  const src = new Float32Array(w * h * 3)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    src[j] = data[i]!
    src[j + 1] = data[i + 1]!
    src[j + 2] = data[i + 2]!
  }
  const tmp = new Float32Array(src.length)
  const blur = new Float32Array(src.length)
  const n = 2 * r + 1
  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0
      for (let k = -r; k <= r; k++) acc += src[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + c]!
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = acc / n
        const add = Math.min(w - 1, x + r + 1)
        const sub = Math.max(0, x - r)
        acc += src[(y * w + add) * 3 + c]! - src[(y * w + sub) * 3 + c]!
      }
    }
  }
  // Vertical pass.
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0
      for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c]!
      for (let y = 0; y < h; y++) {
        blur[(y * w + x) * 3 + c] = acc / n
        const add = Math.min(h - 1, y + r + 1)
        const sub = Math.max(0, y - r)
        acc += tmp[(add * w + x) * 3 + c]! - tmp[(sub * w + x) * 3 + c]!
      }
    }
  }
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    for (let c = 0; c < 3; c++) {
      const v = src[j + c]! + amount * (src[j + c]! - blur[j + c]!)
      data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v
    }
  }
}

const cache = new Map<string, Promise<HTMLImageElement>>()

function loadImage(url: string, cors: boolean): Promise<HTMLImageElement> {
  const key = cors ? `cors|${url}` : url
  let p = cache.get(key)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      // CORS only when the pixels are read back (sharpening); drawing alone is fine
      // with a tainted canvas.
      if (cors) img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => {
        cache.delete(key)
        reject(new Error(`tile failed: ${url}`))
      }
      img.src = url
    })
    cache.set(key, p)
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
    const zSrc = coords.z - dz
    const f = 2 ** dz
    const px = Math.floor(coords.x / f)
    const py = Math.floor(coords.y / f)
    const subs = o.subdomains ?? ''
    const urlFor = (x: number, y: number) =>
      L.Util.template(o.url, { x, y, z: zSrc, s: subs ? subs[Math.abs(x + y) % subs.length] : '' })

    const amount = o.sharpen ?? 0
    const S = 256 // source tile size in pixels
    const src = S / f // source pixels per output tile
    const sx = (coords.x - px * f) * src // this tile's origin inside its parent
    const sy = (coords.y - py * f) * src
    const k = canvas.width / src // output pixels per source pixel
    const r = Math.max(1, Math.round(k * 0.5))
    // Margin (output px) drawn around the tile from REAL neighbouring pixels: room
    // for the sharpening kernel, plus a bleed so even a half-step zoom cannot open
    // a gap. Where the margin crosses the edge of the parent z19 image, the
    // neighbouring parent is loaded and drawn there. Leaving it empty was the seam:
    // the empty (black) margin made the edge pixels darker after resampling, or
    // brighter after sharpening, along every z19 boundary.
    const m = amount > 0 ? 2 * r + 2 : Math.max(2, Math.ceil(k))
    const ms = m / k
    const rx0 = sx - ms
    const ry0 = sy - ms
    const rx1 = sx + src + ms
    const ry1 = sy + src + ms
    const need: Array<{ gx: number; gy: number }> = []
    for (let gy = Math.floor(ry0 / S); gy <= Math.floor((ry1 - 1e-6) / S); gy++)
      for (let gx = Math.floor(rx0 / S); gx <= Math.floor((rx1 - 1e-6) / S); gx++) need.push({ gx, gy })

    Promise.all(
      need.map(({ gx, gy }) =>
        loadImage(urlFor(px + gx, py + gy), amount > 0).then(
          (img) => ({ gx, gy, img }),
          () => ({ gx, gy, img: null as HTMLImageElement | null }),
        ),
      ),
    ).then((parts) => {
      // The tile's own parent must exist; neighbours are best-effort.
      if (!parts.find((p) => p.gx === 0 && p.gy === 0)?.img) return done(new Error('tile failed'), canvas)
      const ctx = canvas.getContext('2d')
      const big = document.createElement('canvas')
      big.width = canvas.width + 2 * m
      big.height = canvas.height + 2 * m
      const bctx = big.getContext('2d')
      if (!ctx || !bctx) return done(undefined, canvas)
      bctx.imageSmoothingEnabled = true
      bctx.imageSmoothingQuality = 'high'
      for (const { gx, gy, img } of parts) {
        if (!img) continue
        // Intersection of the needed rectangle with this parent, in parent-0 space.
        const ix0 = Math.max(rx0, gx * S)
        const iy0 = Math.max(ry0, gy * S)
        const ix1 = Math.min(rx1, (gx + 1) * S)
        const iy1 = Math.min(ry1, (gy + 1) * S)
        if (ix1 <= ix0 || iy1 <= iy0) continue
        bctx.drawImage(
          img,
          ix0 - gx * S, iy0 - gy * S, ix1 - ix0, iy1 - iy0,
          (ix0 - rx0) * k, (iy0 - ry0) * k, (ix1 - ix0) * k, (iy1 - iy0) * k,
        )
      }
      if (amount > 0) {
        try {
          const data = bctx.getImageData(0, 0, big.width, big.height)
          // Stronger once the photo is being stretched; light at native zoom.
          unsharp(data, r, dz > 0 ? amount : amount * 0.6)
          bctx.putImageData(data, 0, 0)
        } catch {
          // Pixel access refused (no CORS): keep the unsharpened draw.
        }
      }
      ctx.drawImage(big, m, m, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
      done(undefined, canvas)
    })
    return canvas
  },
}) as unknown as new (opts: SeamlessOptions) => L.GridLayer

export function seamlessTileLayer(opts: SeamlessOptions): L.GridLayer {
  return new SeamlessTileLayer(opts)
}
