import { useEffect, useState } from 'react'

/**
 * Track the user's reduced-motion preference, live.
 *
 * Decorative motion (detection pings, instrument spin-ups, marching dashes) is
 * gated on this returning false. Positional updates — the drone moving, coverage
 * filling — are NOT gated: an operator still needs to see the mission progress.
 * The CSS media query handles the same at the stylesheet level; this hook is for
 * the cases JS has to branch on (e.g. whether to mount a one-shot ping element).
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return reduced
}
