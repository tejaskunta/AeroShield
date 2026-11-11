/**
 * Print inks — the `sheet` palette as literals.
 *
 * A tailwind class cannot reach an SVG `stroke` attribute or a dynamic `style`
 * object, so the report plate needs the values in JavaScript. They are declared
 * once here rather than inlined at each call site: the round-trip cost of the
 * same red drifting into three slightly different reds is exactly what the
 * palette exists to prevent, and a hex repeated in JSX cannot be audited.
 *
 * These MUST stay in step with `theme.extend.colors.sheet` in
 * `tailwind.config.ts`. They are the same list, expressed twice because Tailwind
 * cannot export its config to runtime. If you change one, change both.
 *
 * Note these are NOT the console colours. `RISK_HEX` is tuned to sit on `ink`
 * (#131A21); on the cream sheet it reads muddy and low-contrast, so paper gets
 * its own darker ink. A hazard mark on a printed report is still a hazard mark —
 * same semantics, different value chosen for the surface it is printed on.
 */
export const SHEET_HEX = {
  sheet: '#F2EFE7',
  raised: '#FAF8F2',
  edge: '#DDD8CB',
  rule: '#C9C3B5',
  ink: '#1A1F24',
  dim: '#4A5560',
  faint: '#5F6973',
  mute: '#A8A296',
  hazard: '#B31E26',
  hazardFill: '#F6E3E4',
  caution: '#846317',
  cautionDeep: '#856213',
  cleared: '#3A7261',
  hazardDeep: '#8C1A21',
} as const