import type { Config } from 'tailwindcss'

/**
 * AeroShield design tokens — "Ordnance Survey After Dark".
 *
 * The governing rule of this palette: chrome is colourless, and saturated colour
 * means hazard state ONLY. There is deliberately no brand accent colour. If you
 * find yourself wanting to paint a button `hazard`, stop — a red control would
 * lie about severity. Controls are outlined in `rule` with `paper` text.
 *
 * Hazard colours are derived from the IMAS minefield marking convention
 * (red = hazard side, white = cleared side) rather than generic UI warning hues.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // --- chrome (colourless) ---------------------------------------
        ink: {
          DEFAULT: '#131A21', // app base — deep blue-slate, a chart at dusk
          deep: '#0E141A', // recessed wells, map backdrop, scroll troughs
          raised: '#1B2530', // panel surface
          hover: '#22303D', // panel hover / selected row
        },
        rule: {
          DEFAULT: '#2C3A47', // hairlines, borders, survey grid, coverage hatch
          bright: '#3E5060', // emphasised border, focus ring track
        },
        /*
         * The text tiers are declared so that the SMALLEST one still clears
         * 4.5:1, because a tier that fails is not a tier — it is text the
         * operator is expected to read and cannot.
         *
         * `faint` was #5C6873 and scored 2.36 on `ink`: at 10px, used as real
         * label text in 62 places, that was the single worst surface in the
         * app. Raising it alone would have landed it one hex digit from `dim`
         * (#8C97A1) and collapsed a three-step hierarchy into two, so `dim`
         * moved up with it. Both keep their hue; the steps between
         * paper → dim → faint stay visible (ΔL 0.18 and 0.11).
         */
        paper: {
          DEFAULT: '#E8E4DA', // primary text + readouts — warm bone, never #FFF
          dim: '#A9B3BD', // labels, secondary text
          faint: '#8A97A2', // disabled, axis ticks, placeholder
        },

        // --- hazard semantics (the only saturated colour) --------------
        /*
         * Hazard carries the only meaning in this palette, so it is declared at
         * two values rather than one — because a single value cannot do both
         * jobs.
         *
         * `DEFAULT` is the alarm red used as a FILL and a STROKE: status dots,
         * meter segments, map borders, where the bar is 3:1. #D7262F scored
         * 2.70 on `ink-hover`, so it did not even clear the graphics threshold; 
         * it is lifted just far enough to clear 3:1 on all four chrome surfaces
         * and is still the same signal red, not a pastel.
         *
         * `lit` exists because that red cannot also be TEXT. 10px type needs
         * 4.5:1, and no red that still reads as alarm reaches it without being
         * lightened past recognition. So hazard text is a deliberately lighter
         * tint of the same hue: `text-hazard-lit`, never `text-hazard`. Painting
         * copy in `DEFAULT` is the bug this token prevents.
         */
        hazard: {
          DEFAULT: '#DC3840', // confirmed hazard — IMAS marker red (fills, dots, strokes)
          soft: '#3A1418', // hazard fill at low alpha, on ink
          lit: '#E67277', // hazard as TEXT — 4.5:1 on every chrome surface
        },
        caution: {
          DEFAULT: '#C9922C', // unverified / low confidence — field-marker ochre
          soft: '#33260F',
        },
        cleared: {
          // #4E9E86 scored 4.21 as text on `ink-hover`. It clears 3:1 as a fill
          // either way, so rather than split the token the green was nudged one
          // shade lighter: the difference is imperceptible, and now a single
          // value is safe for both a dot and a label.
          DEFAULT: '#51A48B', // cleared / safe — instrument patina, not acid green
          soft: '#122A24',
        },

        /*
         * --- the printed sheet (report preview only) -------------------
         *
         * The report preview is the one surface in this app that is NOT the dark
         * console: it renders a cream sheet with dark ink, because that is what
         * the exported PDF looks like. The console palette cannot be reused there
         * — `paper` is bone (#E8E4DA) and would be invisible on cream, and the
         * screen hazard hues are tuned for an ink background.
         *
         * These values were already in use as raw hex (14 distinct values, 24
         * occurrences) which is exactly the drift the palette exists to prevent:
         * an undeclared colour cannot be audited, and two shades a hex apart is
         * how a printed report stops looking like one document. Declaring them
         * makes the relationship explicit — the print inks are the SAME semantics
         * at a darker value chosen for contrast on cream, not a second opinion
         * about what hazard means.
         */
        sheet: {
          DEFAULT: '#F2EFE7', // the page itself
          raised: '#FAF8F2', // inset blocks, table zebra
          edge: '#DDD8CB', // hairlines and rules on paper
          rule: '#C9C3B5', // heavier dividers, table borders
          ink: '#1A1F24', // body text — near-black, never #000
          dim: '#4A5560', // labels, secondary
          faint: '#5F6973', // axis ticks, footnotes
          mute: '#A8A296', // disabled, watermark
          // hazard semantics, re-inked for paper contrast
          hazard: '#B31E26', // was the same signal, darker for cream
          'hazard-fill': '#F6E3E4',
          'hazard-deep': '#8C1A21', // deeper red: struck-out / voided marks
          /*
           * These four were darkened after an audit: on the cream page the
           * original values scored 2.74 (caution), 3.81 (faint), 3.91 (cleared)
           * and 4.27 (caution-deep) — all below the 4.5:1 that body text on a
           * printed report needs, and the report is the artifact a human signs.
           * Hue and saturation are untouched; only lightness moved.
           */
          caution: '#846317',
          'caution-deep': '#856213',
          cleared: '#3A7261',
        },
      },

      fontFamily: {
        // condensed grotesque — map-label energy, thrifty in a dense telemetry dock
        display: ['Arial Narrow', 'system-ui', 'sans-serif'],
        // a public-standards face, apt for a humanitarian tool's prose
        body: ['system-ui', 'sans-serif'],
        // anything read digit-by-digit or copied into Mission Planner
        mono: ['ui-monospace', 'monospace'],
      },

      fontSize: {
        // eyebrow / panel headers — small, tracked out, uppercase
        eyebrow: ['0.625rem', { lineHeight: '1', letterSpacing: '0.14em' }],
        label: ['0.6875rem', { lineHeight: '1.2', letterSpacing: '0.06em' }],
        readout: ['1.375rem', { lineHeight: '1', letterSpacing: '-0.01em' }],
        'readout-lg': ['2.25rem', { lineHeight: '0.95', letterSpacing: '-0.02em' }],

        /*
         * The console's small-text scale.
         *
         * These exist because they were already being used — 161 times, as
         * arbitrary `text-[10px]` / `text-[11px]` / `text-[9px]` / `text-[8px]`
         * utilities. Four declared sizes and an undeclared second scale of six
         * more is not a type system, it is drift: two elements meant to match
         * would drift a pixel apart and nobody would notice until a screenshot
         * disagreed with the design.
         *
         * `tiny` is the FLOOR. Nothing in this console is set below 10px. The
         * axis ticks and unit suffixes that used to run at 8-9px were unreadable
         * on a laptop panel, and on a safety readout an unreadable label is
         * indistinguishable from a wrong one — the operator cannot audit a number
         * whose own units they cannot read.
         *
         * Report-preview sizes of 15/17/19px are deliberately NOT part of this
         * scale: that surface renders a printed document, where a page-relative
         * type hierarchy is correct and the console's density does not apply.
         */
        tiny: ['0.625rem', { lineHeight: '1.35' }], // 10px — floor
        small: ['0.6875rem', { lineHeight: '1.35' }], // 11px
        compact: ['0.8125rem', { lineHeight: '1.4' }], // 13px
        /*
         * Screen titles. Every screen's `<h1>` is this size, and they were all
         * expressing it as `text-[15px]` — the same value agreed on independently
         * four times. Declaring it keeps the next screen from picking 14 or 16.
         */
        title: ['0.9375rem', { lineHeight: '1.2', letterSpacing: '0.12em' }], // 15px
        /*
         * Display sizes — the counters (18px) and the report masthead/stat values
         * (17/19px). Small enough that they read as "large text" rather than
         * readouts, which is why they are here and not above. All three were
         * arbitrary sizes that happened to differ by a pixel or two; declared so
         * they are recognisably one family.
         */
        'display-sm': ['1.0625rem', { lineHeight: '1.1' }], // 17px
        display: ['1.125rem', { lineHeight: '1', letterSpacing: '-0.01em' }], // 18px
        'display-lg': ['1.1875rem', { lineHeight: '1.1', letterSpacing: '0.16em' }], // 19px
      },

      // Instrument-panel radii: nearly square, never pill-shaped.
      borderRadius: {
        DEFAULT: '2px',
        sm: '1px',
        md: '3px',
        lg: '4px',
      },

      spacing: {
        rail: '3.5rem', // 56px nav rail
        dock: '20rem', // 320px right dock
        status: '2.75rem', // 44px status rail
        /*
         * The camera column on Mission Control.
         *
         * A CLAMPED fixed width, not a percentage. It was `w-[38%]`, and a
         * percentage in a flex row resolves against the whole row — including the
         * 320px dock — so the camera came out 587px wide beside a 637px map. The
         * map is the context the whole screen is built around; at near-parity with
         * one camera picture it stops reading as the primary view.
         *
         * The clamp gives the picture an 288px floor (below that the detector's
         * boxes stop being legible) and a 384px ceiling (past that it is just
         * eating survey area), and hands every remaining pixel to the map.
         *
         * The floor is 18rem rather than 20rem on purpose: at the 1024px `lg`
         * breakpoint the row is only 968px, and after the 320px dock a 20rem
         * camera would leave the map under 330px. 18rem buys the map another 32px
         * exactly where it is scarcest, and the picture is still legible.
         */
        camera: 'clamp(18rem, 26vw, 24rem)',
        /*
         * The map's floor. Paired with `camera` so the two cannot drift into each
         * other again: the canvas claims at least half the row before the camera
         * is given anything, and the `flex-1` map absorbs the remainder.
         */
        canvas: '32rem', // 512px minimum map width
      },

      backgroundImage: {
        // The signature coverage hatch — 45° survey hatching.
        'survey-hatch':
          'repeating-linear-gradient(45deg, rgba(62,80,96,0.55) 0 1px, transparent 1px 6px)',
        // Faint chart grid for empty wells and panel backdrops.
        'chart-grid':
          'linear-gradient(rgba(44,58,71,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(44,58,71,0.5) 1px, transparent 1px)',
      },

      keyframes: {
        // A single sonar ping when a detection arrives — fires once, not looped.
        ping: {
          '0%': { transform: 'scale(0.4)', opacity: '0.9' },
          '100%': { transform: 'scale(2.6)', opacity: '0' },
        },
        // Instruments spinning up on first paint.
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'sweep-dash': {
          '0%': { strokeDashoffset: '24' },
          '100%': { strokeDashoffset: '0' },
        },
      },
      animation: {
        ping: 'ping 1.4s cubic-bezier(0, 0, 0.2, 1) 1',
        'rise-in': 'rise-in 260ms ease-out both',
        'slide-in-right': 'slide-in-right 200ms ease-out both',
        'sweep-dash': 'sweep-dash 900ms linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
