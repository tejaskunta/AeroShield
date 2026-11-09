import { useCallback, useState } from 'react'
import type { KeyValueStore } from '@/lib/persistedState'
import { browserStore, persistedKey, readPersisted, writePersisted } from '@/lib/persistedState'

/**
 * `useState` that remembers its value across reloads.
 *
 * Only the initial read is lazy — the store is consulted once, in the initialiser,
 * rather than on every render, so a slow or hostile storage implementation cannot
 * appear in the render path more than once. Writes happen in the setter, so the
 * persisted value never lags the rendered one.
 *
 * The value is trusted as read: anything absent or malformed falls back to
 * `initial`, which means a user whose stored state is unusable gets the default
 * layout rather than a broken one. See `lib/persistedState.ts` for the reasoning
 * behind that, and for why nothing here can throw.
 *
 * Scope: this is for **UI layout state only** — is this panel open, is that box
 * collapsed. Mission data is simulated and re-seeded on every load by design, so
 * persisting anything from it would contradict the fixtures it comes from.
 */
export function usePersistedState<T>(
  id: string,
  initial: T,
  guard?: (value: unknown) => value is T,
  store: KeyValueStore | null = browserStore(),
): [T, (next: T) => void] {
  const key = persistedKey(id)

  const [value, setValue] = useState<T>(() => readPersisted(store, key, initial, guard))

  const set = useCallback(
    (next: T) => {
      writePersisted(store, key, next)
      setValue(next)
    },
    [store, key],
  )

  return [value, set]
}
