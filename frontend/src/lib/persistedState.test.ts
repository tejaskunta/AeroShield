import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  browserStore,
  isBoolean,
  persistedKey,
  readPersisted,
  writePersisted,
  type KeyValueStore,
} from './persistedState.ts'

/**
 * The persistence layer's failure modes, pinned.
 *
 * These test the half of `usePersistedState` that is plain functions, which is the
 * half that can be tested at all — the harness runs `src/lib/*.test.ts` under Node
 * with no DOM. That is exactly why the storage object is a parameter: it lets a
 * fake stand in for `localStorage` and lets the hostile cases be exercised directly
 * instead of argued about.
 *
 * The cases below are the ones that actually break dashboards. A throwing storage
 * (privacy mode), a corrupt record (an older build's schema), and a stored `false`
 * being read as falsy are all things that present as "the panel forgot" or "the app
 * crashed", and none of them are hypothetical.
 */

/** A minimal in-memory store, plus hooks to make it misbehave on demand. */
function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    throwOnRead: false,
    throwOnWrite: false,
    getItem(key: string): string | null {
      if (this.throwOnRead) throw new Error('SecurityError')
      return data.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      if (this.throwOnWrite) throw new Error('QuotaExceededError')
      data.set(key, value)
    },
  }
}

test('keys are namespaced so another app cannot collide', () => {
  assert.equal(persistedKey('coverage'), 'aeroshield:ui:coverage')
  assert.ok(persistedKey('coverage').startsWith('aeroshield:ui:'))
})

test('a value round-trips through the store', () => {
  const store = fakeStore()
  writePersisted(store, persistedKey('coverage'), false)
  assert.equal(readPersisted(store, persistedKey('coverage'), true), false)
})

test('false survives the round-trip — not confused with absence', () => {
  // The whole reason `null` must be distinguished from a stored false. Both are
  // falsy and both come back from `getItem` as a string, so only an explicit
  // null check upstream keeps a collapsed panel from springing open.
  const store = fakeStore()
  writePersisted(store, 'k', false)
  assert.equal(readPersisted(store, 'k', true), false)
})

test('an absent key yields the fallback', () => {
  const store = fakeStore()
  assert.equal(readPersisted(store, 'never-written', true), true)
  assert.equal(readPersisted(store, 'never-written', 'default'), 'default')
})

test('corrupt JSON yields the fallback and does not throw', () => {
  const store = fakeStore({ k: '{"truncated": ' })
  assert.equal(readPersisted(store, 'k', true), true)
})

test('a guard rejects a wrong-typed record rather than trusting it', () => {
  // `JSON.parse('null')` succeeds and returns null. Without a guard that null is
  // handed to the caller as a valid boolean and every downstream truthiness test
  // reads it as "collapsed".
  const nullRecord = fakeStore({ k: 'null' })
  assert.equal(readPersisted(nullRecord, 'k', true, isBoolean), true)

  const wrongType = fakeStore({ k: '"yes"' })
  assert.equal(readPersisted(wrongType, 'k', false, isBoolean), false)

  const rightType = fakeStore({ k: 'false' })
  assert.equal(readPersisted(rightType, 'k', true, isBoolean), false)
})

test('a storage that throws on read falls back', () => {
  const store = fakeStore({ k: 'true' })
  store.throwOnRead = true
  assert.equal(readPersisted(store, 'k', false), false)
})

test('a storage that throws on write does not throw at the call site', () => {
  const store = fakeStore()
  store.throwOnWrite = true
  assert.doesNotThrow(() => writePersisted(store, 'k', true))
})

test('a null store is inert in both directions', () => {
  // What `browserStore()` returns under Node, and in a browser that refuses access.
  assert.equal(readPersisted(null, 'k', 'fallback'), 'fallback')
  assert.doesNotThrow(() => writePersisted(null, 'k', 'value'))
})

test('browserStore returns null under Node rather than throwing', () => {
  assert.equal(browserStore(), null)
})

test('the store interface is satisfied by a plain object', () => {
  // Confirms the exported type stays minimal — no dependency on the full Storage
  // surface, which would make the fake above need `length` and `clear`.
  const minimal: KeyValueStore = fakeStore()
  writePersisted(minimal, 'k', 1)
  assert.equal(readPersisted(minimal, 'k', 0), 1)
})
