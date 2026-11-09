import { useSyncExternalStore } from 'react'
import type { Detection } from '@/types'
import { fetchDetectionImage } from '@/lib/api'

/**
 * The store of detection frame images, as object URLs.
 *
 * ### Why this is not just `<img src={...}>`
 *
 * The image route (`GET /api/detections/{id}/image`) sits behind
 * `SCOPE_DETECTIONS_READ`, and an `<img>` cannot send an `X-API-Key` header. So
 * the bytes have to travel through `fetch` and be handed to the DOM as a blob
 * URL — which means the URL is *ours to manage*, and a blob URL that is never
 * revoked pins its bytes for the life of the document.
 *
 * ### Why a module-level store rather than per-component state
 *
 * One detection is drawn in several places at once: the contact sheet thumbnail,
 * the map callout, the adjudication panel, and now the ticker. Four components
 * fetching the same 20 KB JPEG four times would be four authenticated requests
 * per detection per view change, and four independent blob URLs to leak. Keying
 * by detection id means the first component to ask pays for the fetch and the
 * rest read the answer.
 *
 * ### Why `useSyncExternalStore`
 *
 * The fetch is shared mutable state read during render, which is exactly the
 * shape React's concurrent rendering can tear. Reading it through
 * `useSyncExternalStore` makes each component's view of the store consistent,
 * and the snapshot it reads is a single `string | null | undefined` — a value
 * that compares by identity, so no memoisation is needed to avoid re-renders.
 *
 * ### The three states, and why `undefined` and `null` are different
 *
 * - `undefined` — nobody has asked yet. Render the placeholder, do not fetch.
 * - `null` — asked, and there is no image (404, no `image_path`, no key, network
 *   error). Render the placeholder and stop asking; retrying a 404 on every
 *   render is how a quiet page becomes a request storm.
 * - `string` — the object URL. Render it.
 */

/** Bounded so a long mission cannot accumulate unbounded pinned memory. */
const MAX_CACHED = 120

/**
 * Cache key includes the variant, so the frame and its Grad-CAM heatmap are
 * separate entries — they are different bytes from different routes.
 */
const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()
const listeners = new Set<() => void>()

function keyOf(id: string, variant: 'frame' | 'gradcam'): string {
  return `${variant}:${id}`
}

function emit(): void {
  for (const l of listeners) l()
}

/**
 * Evict the oldest entries once over the cap, revoking as we go.
 *
 * A `Map` iterates in insertion order, so the first keys are the oldest — which
 * is the right thing to drop: the operator has moved on from them. Revoking is
 * not optional, it is the whole reason this bookkeeping exists.
 */
function evict(): void {
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next()
    if (oldest.done === true) return
    const k = oldest.value
    const url = cache.get(k)
    cache.delete(k)
    if (typeof url === 'string') URL.revokeObjectURL(url)
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/**
 * Start the fetch for one frame if it has not been started.
 *
 * Deliberately fire-and-forget: the UI already has something to draw (the
 * placeholder), so there is nothing to await. Progress arrives as a store
 * notification.
 */
function request(id: string, variant: 'frame' | 'gradcam'): void {
  const k = keyOf(id, variant)
  if (cache.has(k) || inflight.has(k)) return

  const p = fetchDetectionImage(id, variant)
    .then((url) => {
      cache.set(k, url)
      evict()
      return url
    })
    .catch(() => {
      cache.set(k, null)
      return null
    })
    .finally(() => {
      inflight.delete(k)
      emit()
    })

  inflight.set(k, p)
}

/**
 * The image for a detection, if there is one.
 *
 * `source: 'simulated'` returns `undefined` without touching the network: the
 * keyless demo has no backend and must not start firing authenticated requests
 * at a server that is not there. That is the guard that keeps the fallback
 * intact — see `lib/simulation.ts`.
 *
 * Three states, and the difference matters:
 * - `undefined` — not asked yet. Render the placeholder.
 * - `null` — asked, there is no image. Render the placeholder, stop asking.
 *   Retrying a 404 on every render is how a quiet page becomes a request storm.
 * - `string` — an object URL. Render it.
 */
export function useDetectionImage(
  detection: Detection,
  variant: 'frame' | 'gradcam' = 'frame',
): string | null | undefined {
  const id = detection.id
  const real = detection.source === 'backend'
  const k = keyOf(id, variant)

  // The third argument is the server-rendering snapshot; this app does not
  // server-render, but the contract requires it and returning the same value
  // keeps the two paths from disagreeing.
  const snapshot = useSyncExternalStore(
    subscribe,
    () => cache.get(k),
    () => cache.get(k),
  )

  // Starting traffic during render is the wrong habit, so the first render
  // returns `undefined` (placeholder) and schedules the fetch. Deferring via
  // `queueMicrotask` also means a render React throws away leaves no fetch
  // behind with no subscriber to receive its result.
  if (real && snapshot === undefined && variant === 'frame') {
    queueMicrotask(() => request(id, 'frame'))
  }
  if (real && snapshot === undefined && variant === 'gradcam' && detection.gradCamUri !== null) {
    // Grad-CAM only exists when the backend said it does; asking for a heatmap
    // the drone never produced would be a guaranteed 404 per detection.
    queueMicrotask(() => request(id, 'gradcam'))
  }

  return snapshot
}

/** Test seam: drop every cached URL and revoke it. */
export function clearDetectionFrameCache(): void {
  for (const url of cache.values()) {
    if (typeof url === 'string') URL.revokeObjectURL(url)
  }
  cache.clear()
  inflight.clear()
  emit()
}