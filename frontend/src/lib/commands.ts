import { useEffect, useRef } from 'react'

/**
 * Console-wide commands, from the command palette and keyboard shortcuts.
 *
 * A tiny event bus rather than lifted state: the palette lives in the shell and
 * the map controls live in Mission Control, and threading a dozen callbacks through
 * the router to connect them would couple two things that only need to talk.
 */
export type Command =
  | { type: 'view'; value: '2d' | '3d' | 'toggle' }
  | { type: 'layout'; value: 'overlay' | 'split' | 'toggle' }
  | { type: 'fit' }
  | { type: 'follow' }
  | { type: 'zoom'; dir: 1 | -1 }
  | { type: 'measure' }
  | { type: 'test' }
  | { type: 'latest' }
  | { type: 'basemap'; value: 'satellite' | 'hybrid' | 'roadmap' }

const EVENT = 'aeroshield:command'

export function dispatchCommand(cmd: Command): void {
  window.dispatchEvent(new CustomEvent<Command>(EVENT, { detail: cmd }))
}

export function useCommand(handler: (cmd: Command) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const on = (e: Event) => ref.current((e as CustomEvent<Command>).detail)
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
}

/** True when a key press belongs to a text field or an open dialog, not to us. */
export function keyBelongsElsewhere(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return true
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
}
