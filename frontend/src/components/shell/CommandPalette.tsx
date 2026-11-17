import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  BarChart3, Box, Columns2, Crosshair, FileText, FlaskConical, Keyboard, Layers3, Map, Minus, Plus,
  Radar, Ruler, Scan, ScanSearch, Search, ShieldQuestion, Satellite, type LucideIcon,
} from 'lucide-react'
import { dispatchCommand, keyBelongsElsewhere, type Command } from '@/lib/commands'

/**
 * Command palette (Ctrl/⌘+K) and global shortcuts.
 *
 * Every screen and every map action in one searchable list, so an operator never
 * hunts for a button mid-flight. Map actions jump to Mission Control first, then
 * run there. Shortcuts are listed next to each action and on `?`.
 */
interface Action {
  id: string
  label: string
  group: 'Go to' | 'Map' | 'Tools'
  icon: LucideIcon
  keys?: string
  run: () => void
}

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl K', 'Command palette'],
  ['1 – 5', 'Mission · Detections · Analytics · Copilot · Reports'],
  ['V', 'Toggle 2D / 3D'],
  ['L', 'Toggle overlay / split camera'],
  ['F', 'Fit block and drone'],
  ['D', 'Follow the drone'],
  ['+  −', 'Zoom'],
  ['N', 'Jump to the newest detection'],
  ['M', 'Measure distance'],
  ['T', 'Test detection'],
  ['Esc', 'Close / deselect'],
  ['?', 'This list'],
]

export function CommandLayer() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const [help, setHelp] = useState(false)

  const onMission = pathname.startsWith('/mission')
  const mapCmd = (cmd: Command) => () => {
    if (!onMission) {
      navigate('/mission')
      // Let Mission Control mount and subscribe before the command fires.
      setTimeout(() => dispatchCommand(cmd), 350)
    } else dispatchCommand(cmd)
  }

  const actions: Action[] = useMemo(
    () => [
      { id: 'go-mission', label: 'Mission control', group: 'Go to', icon: Map, keys: '1', run: () => navigate('/mission') },
      { id: 'go-det', label: 'Detections', group: 'Go to', icon: ScanSearch, keys: '2', run: () => navigate('/detections') },
      { id: 'go-ana', label: 'Analytics', group: 'Go to', icon: BarChart3, keys: '3', run: () => navigate('/analytics') },
      { id: 'go-cop', label: 'Safety copilot', group: 'Go to', icon: ShieldQuestion, keys: '4', run: () => navigate('/copilot') },
      { id: 'go-rep', label: 'Mission reports', group: 'Go to', icon: FileText, keys: '5', run: () => navigate('/reports') },
      { id: 'v-2d', label: 'Flat 2D map', group: 'Map', icon: Layers3, keys: 'V', run: mapCmd({ type: 'view', value: '2d' }) },
      { id: 'v-3d', label: '3D view (terrain, buildings, drone altitude)', group: 'Map', icon: Box, keys: 'V', run: mapCmd({ type: 'view', value: '3d' }) },
      { id: 'lay', label: 'Toggle camera: overlay / side by side', group: 'Map', icon: Columns2, keys: 'L', run: mapCmd({ type: 'layout', value: 'toggle' }) },
      { id: 'fit', label: 'Fit block and drone', group: 'Map', icon: Scan, keys: 'F', run: mapCmd({ type: 'fit' }) },
      { id: 'follow', label: 'Follow the drone', group: 'Map', icon: Crosshair, keys: 'D', run: mapCmd({ type: 'follow' }) },
      { id: 'zin', label: 'Zoom in', group: 'Map', icon: Plus, keys: '+', run: mapCmd({ type: 'zoom', dir: 1 }) },
      { id: 'zout', label: 'Zoom out', group: 'Map', icon: Minus, keys: '−', run: mapCmd({ type: 'zoom', dir: -1 }) },
      { id: 'sat', label: 'Imagery: satellite', group: 'Map', icon: Satellite, run: mapCmd({ type: 'basemap', value: 'satellite' }) },
      { id: 'street', label: 'Imagery: street map', group: 'Map', icon: Map, run: mapCmd({ type: 'basemap', value: 'roadmap' }) },
      { id: 'latest', label: 'Jump to the newest detection', group: 'Tools', icon: Radar, keys: 'N', run: mapCmd({ type: 'latest' }) },
      { id: 'measure', label: 'Measure distance', group: 'Tools', icon: Ruler, keys: 'M', run: mapCmd({ type: 'measure' }) },
      { id: 'test', label: 'Test detection: inject a landmine image', group: 'Tools', icon: FlaskConical, keys: 'T', run: mapCmd({ type: 'test' }) },
      { id: 'keys', label: 'Keyboard shortcuts', group: 'Tools', icon: Keyboard, keys: '?', run: () => setHelp(true) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, onMission],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        return
      }
      if (open || help || e.ctrlKey || e.metaKey || e.altKey || keyBelongsElsewhere(e)) return
      const screens = ['/mission', '/detections', '/analytics', '/copilot', '/reports']
      if (/^[1-5]$/.test(e.key)) return navigate(screens[Number(e.key) - 1]!)
      if (e.key === '?') return setHelp(true)
      if (!onMission) return
      const map: Record<string, Command> = {
        v: { type: 'view', value: 'toggle' },
        l: { type: 'layout', value: 'toggle' },
        f: { type: 'fit' },
        d: { type: 'follow' },
        n: { type: 'latest' },
        m: { type: 'measure' },
        t: { type: 'test' },
        '+': { type: 'zoom', dir: 1 },
        '=': { type: 'zoom', dir: 1 },
        '-': { type: 'zoom', dir: -1 },
      }
      const cmd = map[e.key.toLowerCase()]
      if (cmd) {
        e.preventDefault()
        dispatchCommand(cmd)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, help, onMission, navigate])

  return (
    <>
      {open && <Palette actions={actions} onClose={() => setOpen(false)} />}
      {help && <Help onClose={() => setHelp(false)} />}
    </>
  )
}

function Palette({ actions, onClose }: { actions: Action[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => input.current?.focus(), [])

  const list = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return actions.filter((a) => terms.every((t) => `${a.label} ${a.group}`.toLowerCase().includes(t)))
  }, [actions, q])
  useEffect(() => setI(0), [q])

  const run = (a: Action | undefined) => {
    if (!a) return
    onClose()
    a.run()
  }

  let lastGroup = ''
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[1100] flex items-start justify-center bg-black/55 pt-[14vh] backdrop-blur-[2px] animate-rise-in"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-white/10 bg-ink-raised shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-4">
          <Search size={15} className="text-paper-faint" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)) }
              else if (e.key === 'Enter') run(list[i])
            }}
            placeholder="Go to a screen or run a map action…"
            className="h-12 flex-1 bg-transparent text-[0.875rem] text-paper placeholder:text-paper-faint focus:outline-none"
            aria-label="Search commands"
          />
          <kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-paper-faint">Esc</kbd>
        </div>
        <ul className="max-h-[52vh] overflow-y-auto py-1.5" role="listbox">
          {list.length === 0 && <li className="px-4 py-6 text-center text-[0.8125rem] text-paper-faint">No matching command</li>}
          {list.map((a, idx) => {
            const head = a.group !== lastGroup ? a.group : null
            lastGroup = a.group
            const Icon = a.icon
            return (
              <li key={a.id}>
                {head && <div className="px-4 pb-1 pt-2.5 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-paper-faint">{head}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === i}
                  onMouseMove={() => setI(idx)}
                  onClick={() => run(a)}
                  className={`mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-3 rounded-md px-2.5 py-2 text-left text-[0.8125rem] transition-colors ${idx === i ? 'bg-signal/[0.12] text-paper' : 'text-paper-dim'}`}
                >
                  <Icon size={15} className={idx === i ? 'text-signal' : 'text-paper-faint'} aria-hidden />
                  <span className="flex-1">{a.label}</span>
                  {a.keys && <kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-paper-faint">{a.keys}</kbd>}
                </button>
              </li>
            )
          })}
        </ul>
        <div className="flex items-center gap-4 border-t border-white/[0.07] px-4 py-2 text-[0.6875rem] text-paper-faint">
          <span>↑↓ to move</span>
          <span>Enter to run</span>
          <span className="ml-auto">? for all shortcuts</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Help({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === '?') && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-[1100] grid place-items-center bg-black/55 backdrop-blur-[2px] animate-rise-in"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[min(460px,calc(100vw-2rem))] rounded-lg border border-white/10 bg-ink-raised p-5 shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
        <h2 className="mb-3 flex items-center gap-2 text-[0.9375rem] font-semibold text-paper">
          <Keyboard size={15} className="text-signal" aria-hidden /> Keyboard shortcuts
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="contents">
              <dt><kbd className="inline-block min-w-[2.75rem] rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-center font-mono text-[0.6875rem] text-paper">{k}</kbd></dt>
              <dd className="self-center text-[0.8125rem] text-paper-dim">{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>,
    document.body,
  )
}
