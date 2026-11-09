import { useId, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { usePersistedState } from '@/hooks/usePersistedState'
import { isBoolean } from '@/lib/persistedState'

/**
 * Panel — the dock plate every readout sits on.
 *
 * A panel is a hairlined rectangle with a tracked-out eyebrow header. No shadow,
 * no rounding beyond 2px, no gradient: it should read as sheet metal, not as a
 * floating card. `flush` drops the body padding for panels holding a map or table.
 *
 * `collapsible` folds a panel down to a single icon tile so an operator can clear
 * the dock and give the map the vertical room instead. Collapse is chrome, not
 * status: the icon keeps its position either way, and the body simply leaves.
 *
 * Folding all the way to an icon rather than to a title bar is the point. A
 * header-only panel is still a full-width strip of the dock, so it saves the body
 * but not the space that matters — the vertical run the operator was trying to
 * reclaim. A 32 px tile costs one grid cell and gives the map everything else.
 * It relies on `icon` to say which panel it is; without one it falls back to a
 * chevron, which is still a usable target but not self-describing.
 *
 * Two deliberate choices:
 *
 *   - The body is hidden with the `hidden` attribute rather than unmounted, so
 *     `aria-controls` always resolves to a real element. A disclosure whose
 *     target disappears is worse than no disclosure at all. This holds in the
 *     folded branch too, which keeps an (inert) body mounted beside the icon.
 *   - There is NO height animation. A panel that slid shut would animate the map
 *     resizing underneath it, which reads as the instrument moving on its own.
 *
 * Fold state is persisted per `collapseId`, so a panel the operator put away
 * stays away across a reload. Both the loading and the loaded branch of a panel
 * must pass the SAME `collapseId`; otherwise the fold resets the instant the real
 * data arrives.
 */
export function Panel({
  title,
  aside,
  children,
  flush = false,
  className = '',
  collapsible = false,
  collapseId,
  icon: Icon,
}: {
  title?: string
  /** Right-aligned slot in the header — a count, a toggle, a status dot. */
  aside?: ReactNode
  children: ReactNode
  flush?: boolean
  className?: string
  /** Allow the panel to fold down to a single icon tile. Needs a `title`. */
  collapsible?: boolean
  /** Stable identity for the stored fold state. Defaults to the title. */
  collapseId?: string
  /**
   * The panel's own glyph, shown in the header and alone in the folded tile.
   * Without it a folded panel is an unlabelled square, which is a puzzle rather
   * than a control — so pass one for anything meant to be folded.
   */
  icon?: LucideIcon
}) {
  const bodyId = useId()
  const canCollapse = collapsible && Boolean(title)
  const [collapsed, setCollapsed] = usePersistedState(
    collapseId ?? title ?? '',
    false,
    isBoolean,
  )

  /*
   * Folded: one 32 px tile, and nothing else.
   *
   * `w-fit` is load-bearing. The dock is a flex column, so a plain block here
   * would stretch to the full width and reproduce exactly the header strip this
   * branch exists to avoid.
   *
   * The body stays mounted but `hidden`, so `aria-controls` on the tile still
   * resolves. Nothing inside a hidden subtree is focusable or announced.
   */
  if (canCollapse && collapsed) {
    return (
      /*
       * `data-collapsed` is read by the dock's CSS, not by this component.
       *
       * A folded panel shrinks itself to 32 px, but the dock around it is a
       * fixed-width column, so the operator was left with a small icon sitting in
       * a full-width plate — the size was retained by the box, not by the panel.
       * The dock uses this attribute to notice that nothing inside it is open and
       * narrow itself to an icon rail. That decision has to be made in CSS, not
       * here: it depends on siblings, and a component cannot see its siblings.
       */
      <section className="w-fit" data-collapsed="true">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-controls={bodyId}
          aria-label={`Expand ${title}`}
          title={`Expand ${title}`}
          className="grid size-8 place-items-center border border-rule bg-ink-raised text-paper-dim transition-colors hover:border-rule-bright hover:bg-ink-hover hover:text-paper focus-visible:ring-2 focus-visible:ring-paper/70"
        >
          {Icon ? (
            <Icon size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} className="rotate-90" aria-hidden />
          )}
        </button>
        <div id={bodyId} hidden>
          {children}
        </div>
      </section>
    )
  }

  return (
    <section className={`border border-rule bg-ink-raised ${className}`} data-collapsed="false">
      {title && (
        <header className="flex h-8 items-center justify-between gap-2 border-b border-rule px-3">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* The same glyph the folded tile shows, so the two states read as
                one control rather than two different things. */}
            {Icon && <Icon size={12} className="shrink-0 text-paper-faint" aria-hidden />}
            <h2 className="eyebrow truncate">{title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {aside}
            {/*
             * Folds to the icon tile.
             *
             * The chevron points up, back along the run of the dock, because
             * collapsing pulls the panel toward its own header. The old control was
             * a 16 px glyph with no hit area — under every pointer-size guideline,
             * and the reason the control was easy to miss entirely. 24 px is the
             * smallest size that reads as a button.
             */}
            {canCollapse && (
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                aria-expanded
                aria-controls={bodyId}
                aria-label={`Collapse ${title}`}
                title="Collapse to icon"
                className="-mr-1.5 grid size-6 place-items-center text-paper-faint transition-colors hover:bg-ink-hover hover:text-paper focus-visible:ring-2 focus-visible:ring-paper/70"
              >
                <ChevronRight size={13} className="-rotate-90" aria-hidden />
              </button>
            )}
          </div>
        </header>
      )}
      <div id={bodyId} className={flush ? '' : 'p-3'}>
        {children}
      </div>
    </section>
  )
}
