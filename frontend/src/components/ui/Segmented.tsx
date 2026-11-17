/**
 * Segmented — a small radio group drawn as one glass pill.
 *
 * Used for the map's view (2D | 3D), basemap and tracking switches. A real
 * `radiogroup` with `radio` children, so it is announced and arrow-navigable as
 * one control rather than as unrelated buttons.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className = '',
}: {
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ value: T; label: string; title?: string }>
  label: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const pad = size === 'sm' ? 'px-2.5 py-1 text-[0.75rem]' : 'px-3 py-1.5 text-[0.8125rem]'
  return (
    <div role="radiogroup" aria-label={label} className={`glass inline-flex gap-0.5 p-1 ${className}`}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`rounded-md font-medium transition-colors ${pad} ${on
              ? 'bg-white/[0.10] text-paper shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
              : 'text-paper-faint hover:bg-white/[0.05] hover:text-paper-dim'
              }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
