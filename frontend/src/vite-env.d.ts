/**
 * Vite's client types (`import.meta.env`) are NOT pulled in automatically here:
 * tsconfig.json pins `"types": ["node"]`, which suppresses the ambient
 * `vite/client` include. So the one env var this app reads is declared by hand —
 * a file that lies about the shape it returns is worse than one that admits it is
 * a fixture, and the same honesty applies to types.
 */
interface ImportMetaEnv {
  /**
   * Dashboard-scoped API key (detections:read + review) sent as X-API-Key.
   * Set in `frontend/.env.local`. With it unset, `lib/api.ts` keeps every call on
   * its fixture fallback, so the zero-key classroom demo still runs.
   */
  readonly VITE_DASHBOARD_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
