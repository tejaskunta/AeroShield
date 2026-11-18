/// <reference lib="webworker" />
/**
 * Tile worker: fetch a source tile, sharpen it once, hand back a GPU-ready bitmap.
 *
 * WHY A WORKER: sharpening every on-screen tile on the main thread (resample into
 * an enlarged canvas, read the pixels back, filter, write them) measured at 69% of
 * the map's load CPU and blocked the page for ~13 s, which is the lag an operator
 * felt on load and zoom. Here each z19 source photo is processed ONCE, at its native
 * 256 px, off the main thread; the result is an ImageBitmap the map reuses for every
 * zoom level, so drawing a tile becomes one cheap GPU blit.
 *
 * The unsharp mask uses replicated edges (index clamping), never an empty border:
 * a black margin is what drew pale lines along tile boundaries before.
 */
export type TileRequest = { id: number; url: string; amount: number }
export type TileResponse = { id: number; bitmap?: ImageBitmap; error?: string }

function unsharp(img: ImageData, amount: number): void {
  // 3x3 box blur, radius 1, edges replicated.
  const { width: w, height: h, data } = img
  const src = new Uint8ClampedArray(data)
  const at = (x: number, y: number, c: number) =>
    src[((Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) << 2) + c]!
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2
      for (let c = 0; c < 3; c++) {
        let s = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(x + dx, y + dy, c)
        const v = src[i + c]!
        data[i + c] = v + amount * (v - s / 9)
      }
    }
  }
}

self.onmessage = async (e: MessageEvent<TileRequest>) => {
  const { id, url, amount } = e.data
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bmp = await createImageBitmap(await res.blob())
    if (amount <= 0) {
      ;(self as unknown as Worker).postMessage({ id, bitmap: bmp } satisfies TileResponse, [bmp])
      return
    }
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bmp, 0, 0)
    bmp.close()
    const data = ctx.getImageData(0, 0, c.width, c.height)
    unsharp(data, amount)
    ctx.putImageData(data, 0, 0)
    const out = c.transferToImageBitmap()
    ;(self as unknown as Worker).postMessage({ id, bitmap: out } satisfies TileResponse, [out])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: String(err) } satisfies TileResponse)
  }
}
