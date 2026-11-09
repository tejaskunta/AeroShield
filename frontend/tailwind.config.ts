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
        paper: {
          DEFAULT: '#E8E4DA', // primary text + readouts — warm bone, never #FFF
          dim: '#8C97A1', // labels, secondary text
          faint: '#5C6873', // disabled, axis ticks, placeholder
        },

        // --- hazard semantics (the only saturated colour) --------------
        hazard: {
          DEFAULT: '#D7262F', // confirmed hazard — IMAS marker red
          soft: '#3A1418', // hazard fill at low alpha, on ink
        },
        caution: {
          DEFAULT: '#C9922C', // unverified / low confidence — field-marker ochre
          soft: '#33260F',
        },
        cleared: {
          DEFAULT: '#4E9E86', // cleared / safe — instrument patina, not acid green
          soft: '#122A24',
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
        ticker: '2.5rem', // 40px detection feed
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
