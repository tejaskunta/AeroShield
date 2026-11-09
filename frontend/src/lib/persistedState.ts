/**
 * Persisted UI state — the pure half.
 *
 * Deliberately knows nothing about React and touches no global at module scope: the
 * storage object is passed in. That is what lets `persistedState.test.ts` exercise
 * every failure path under plain Node, where there is no DOM, no jsdom, and no
 * `localStorage` — the same constraint `config.ts` already works under.
 *
 * The whole point of this module is that **nothing it does may throw.** Collapse
 * state is a convenience. An operator in a privacy-mode browser, or on a machine
 * where storage has hit its quota, should get a dashboard that simply forgets how
 * they left the panels — not a white screen and not an error they cannot act on.
 * So every read has a fallback and every write is best-effort.
 */

/** The slice of the Web Storage API this module needs. Narrow on purpose. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Namespaced so a key from another app on the same origin cannot collide. */
const NAMESPACE = 'aeroshield:ui:'

export function persistedKey(id: string): string {
  return NAMESPACE + id
}

/**
 * The browser's `localStorage`, or `null` if it cannot be used.
 *
 * Two distinct failures are folded into that `null`: `window` may not exist at all
 * (Node, SSR), and merely *reading* `window.localStorage` throws outright in some
 * privacy modes. Both mean the same thing to a caller — no persistence available —
 * so both are handled in one place.
 */
export function browserStore(): KeyValueStore | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/** Type predicate for the boolean collapse flags. See `readPersisted`'s `guard`. */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/**
 * Read a persisted value, falling back on anything unexpected.
 *
 * `guard` matters more than it looks. Without one, a stored `null`, `"false"`, or a
 * value left behind by an older build would be handed back as if it were valid —
 * and because `JSON.parse` happily returns `null`, a truthiness check downstream
 * would read a panel as collapsed when the record is simply corrupt. Callers pass a
 * predicate so the boundary is explicit rather than implied by the type argument,
 * which TypeScript erases at runtime anyway.
 */
export function readPersisted<T>(
  store: KeyValueStore | null,
  key: string,
  fallback: T,
  guard?: (value: unknown) => value is T,
): T {
  if (!store) return fallback

  let raw: string | null
  try {
    raw = store.getItem(key)
  } catch {
    return fallback
  }

  // Absent is the normal first-run case, not an error.
  if (raw === null) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Truncated or hand-edited record. Unusable, so treat it as absent.
    return fallback
  }

  if (guard && !guard(parsed)) return fallback
  return parsed as T
}

/**
 * Write a value, or quietly do nothing.
 *
 * Failures swallowed here include quota-exceeded, storage disabled mid-session, and
 * a circular structure reaching `JSON.stringify`. There is no useful recovery and
 * no useful message, so there is no throw: the in-memory state stays correct, and
 * only the persistence is lost.
 */
export function writePersisted<T>(store: KeyValueStore | null, key: string, value: T): void {
  if (!store) return

  try {
    store.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}
