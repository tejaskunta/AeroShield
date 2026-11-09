/**
 * Register the TypeScript resolver hook.
 *
 * Node's `--import` flag evaluates a module in the main thread; it does not install
 * module-customization hooks by itself. Installing them means calling `register()`
 * from `node:module`, which hands the hook to a separate loader thread. Keeping that
 * call in its own file means the hook module is never asked to register itself, which
 * would recurse when the loader thread loads it.
 *
 * Usage:
 *   node --experimental-strip-types --import ./scripts/register.mjs --test src/lib/*.test.ts
 */

import { register } from 'node:module'

register('./ts-resolve.mjs', import.meta.url)
