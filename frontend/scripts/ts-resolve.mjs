/**
 * A Node module resolver for the frontend's TypeScript sources.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────
 *
 * `geo.ts` and `simulation.ts` are pure — no DOM, no React, no Maps API — and the
 * accuracy of the projection maths is the thing most worth testing. Node 24 can run
 * TypeScript directly via `--experimental-strip-types`, so no test runner and no
 * transpiler need to be installed to check them. But Node's resolver is stricter than
 * Vite's in two ways that this codebase relies on:
 *
 *   1. ESM requires a file extension. `mockData.ts` says `from './geo'`, which Vite
 *      resolves and Node does not.
 *   2. The `@/` alias is declared in `tsconfig.json` and in `vite.config.ts`, and Node
 *      knows nothing about either.
 *
 * This hook supplies just those two rules, reading the alias out of the real tsconfig
 * so the two cannot drift. It deliberately does not try to be a general bundler: it
 * resolves files that exist and defers everything else.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { existsSync, statSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolvePath(here, '..')

/** Read the `@/*` alias target straight from tsconfig, so it has one source of truth. */
function aliasTargets() {
  try {
    const raw = readFileSync(resolvePath(projectRoot, 'tsconfig.json'), 'utf8')
    // tsconfig.json here has no comments, so a plain parse is safe. Stripping a
    // trailing-comma-and-comment style is not worth the risk of corrupting it.
    const cfg = JSON.parse(raw)
    const baseUrl = cfg.compilerOptions?.baseUrl ?? '.'
    const out = []
    for (const [key, targets] of Object.entries(cfg.compilerOptions?.paths ?? {})) {
      const prefix = key.replace(/\*$/, '')
      const target = Array.isArray(targets) ? targets[0] : targets
      if (typeof target === 'string') {
        out.push({ prefix, target: target.replace(/\*$/, ''), baseUrl })
      }
    }
    return out
  } catch {
    // Falling back to the hard-coded mapping keeps tests runnable if tsconfig is
    // edited into something non-JSON; a silent no-alias would be a confusing failure.
    return [{ prefix: '@/', target: './src/', baseUrl: '.' }]
  }
}

const ALIASES = aliasTargets()

const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.mjs']

/** Resolve a specifier to a real file on disk, or return null to defer to Node. */
function resolveSpecifier(specifier, parentURL) {
  let base = null

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = resolvePath(dirname(fileURLToPath(parentURL)), specifier)
  } else {
    for (const { prefix, target, baseUrl } of ALIASES) {
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length)
        base = resolvePath(projectRoot, baseUrl, target.replace(/^\.\//, ''), rest)
        break
      }
    }
  }

  if (!base) return null

  // Exact hit, including an explicit `.ts` extension.
  if (existsSync(base) && statSync(base).isFile()) return base

  for (const suffix of CANDIDATES) {
    const candidate = base + suffix
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }

  return null
}

/**
 * The module format Node must be told to use for a given file.
 *
 * This has to name the *TypeScript* format rather than plain `module`. Returning
 * `'module'` for a `.ts` file makes Node parse it as JavaScript, and the first line
 * of `geo.ts` — `import type { LatLng, MissionGrid } from '@/types'` — is then a hard
 * `SyntaxError: Unexpected token '{'`, because a type-only import is not valid
 * JavaScript. `'module-typescript'` is the format that engages `--experimental-strip-types`.
 */
function formatFor(file) {
  return file.endsWith('.tsx') || file.endsWith('.ts')
    ? 'module-typescript'
    : 'module'
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('node:') || specifier.startsWith('data:')) {
    return nextResolve(specifier, context)
  }

  const found = resolveSpecifier(specifier, context.parentURL)
  if (found) {
    return { url: pathToFileURL(found).href, shortCircuit: true, format: formatFor(found) }
  }

  return nextResolve(specifier, context)
}
