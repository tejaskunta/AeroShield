/**
 * Deterministic pseudo-random numbers.
 *
 * Fixtures and the flight simulator both need randomness, but both also need it to
 * be *the same randomness on every load*. A scene that reshuffles under you is
 * useless to design against — a layout bug becomes unreproducible, and a screenshot
 * cannot be compared with the run before it. So neither of them may use
 * `Math.random()`.
 *
 * mulberry32 is a 32-bit generator with a single-word state: small, fast, and good
 * enough for fixtures and a simulated pilot's hand. It is not cryptographic and must
 * never be used for anything that needs to be unpredictable.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}