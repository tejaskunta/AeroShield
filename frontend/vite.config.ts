import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Jetson live-feed origin for the dev proxy.
 *
 * Kept in step with the default in `src/lib/config.ts`. Override with
 * VITE_JETSON_STREAM_URL=http://<host>:<port>/stream when the Jetson moves — that
 * variable is read by the app; this one only exists so the proxy knows where to
 * forward, and is read at config time (before any Vite env inlining happens).
 */
const JETSON_ORIGIN = process.env.AEROSHIELD_JETSON_ORIGIN ?? 'http://10.11.101.241:8080'

/**
 * Fail a production build that has no imagery token.
 *
 * This is a guard against a specific, already-observed failure: `VITE_MAPBOX_TOKEN`
 * lives in the gitignored `frontend/.env.local`, so a fresh clone or a second laptop
 * silently falls back to Google's raster imagery, which caps at zoom 20 instead of 22
 * — 7.0 px/m against 28.1 px/m. Two people on the same commit saw maps differing by a
 * factor of four in ground scale and had no way to tell that was the cause.
 *
 * Left as a hard failure rather than a warning because a warning is exactly what the
 * runtime fallback already effectively was, and it went unnoticed. `npm run dev` is
 * deliberately exempt so the console can still be run and demoed with no keys at all.
 *
 * Set AEROSHIELD_ALLOW_KEYLESS_BUILD=1 for a keyless demo build, or pass
 * VITE_MAPBOX_TOKEN directly in the environment.
 */
function assertImageryToken(mode: string, root: string) {
  if (mode !== 'production') return
  if (process.env.AEROSHIELD_ALLOW_KEYLESS_BUILD === '1') return

  const env = loadEnv(mode, root, 'VITE_')
  const token = (process.env.VITE_MAPBOX_TOKEN ?? env.VITE_MAPBOX_TOKEN ?? '').trim()
  if (token) return

  throw new Error(
    [
      'VITE_MAPBOX_TOKEN is not set, so this build would serve degraded imagery.',
      '',
      'The imagery basemaps would fall back to Google and cap at zoom 20 (7.0 px/m)',
      'instead of zoom 22 (28.1 px/m) — a quarter of the ground scale, with nothing',
      'in the UI to say so. The token lives in the gitignored frontend/.env.local,',
      'which is why a fresh clone hits this.',
      '',
      'Fix one of:',
      '  - add VITE_MAPBOX_TOKEN=<token> to frontend/.env.local (see .env.example)',
      '  - export VITE_MAPBOX_TOKEN=<token> in the build environment',
      '  - for a keyless demo build: AEROSHIELD_ALLOW_KEYLESS_BUILD=1 npm run build',
    ].join('\n'),
  )
}

export default defineConfig(({ mode }) => {
  assertImageryToken(mode, __dirname)

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      port: 5173,
      // Mission data is simulated (see plan), but two backend routes do exist today:
      // POST /api/detect and GET /health. Proxying them means the Detection Center's
      // backend check works without adding CORS middleware to FastAPI. The mission
      // socket and telemetry also live here, which is why /api carries `ws: true`.
      proxy: {
        /**
         * `ws: true` IS REQUIRED, not optional tidying.
         *
         * `/api/ws/missions/{id}` is a real WebSocket behind this prefix. Vite only
         * forwards an Upgrade handshake when the proxy entry says `ws: true`; without
         * it the connection is treated as a plain HTTP GET, the browser gets a normal
         * response instead of a 101, and `new WebSocket(...)` fires `onerror`
         * immediately. The dashboard then silently stays on its polling fallback —
         * which works, which is exactly why the bug would go unnoticed for a long
         * time. Setting it changes nothing for the existing REST calls.
         */
        '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true, ws: true },
        '/health': { target: 'http://127.0.0.1:8000', changeOrigin: true },
        /**
         * Live camera feed. Set VITE_JETSON_STREAM_URL=/jetson/stream to route the
         * MJPEG through here: it keeps the feed same-origin (so a future canvas
         * readback for client-side overlays is not tainted) and works when only the
         * dev machine can reach the Jetson, not the browser.
         *
         * Buffering is disabled deliberately. An MJPEG stream is an endless
         * multipart response; anything that waits to fill a buffer before flushing
         * means the operator sees a still frame and concludes the feed is frozen.
         */
        '/jetson': {
          target: JETSON_ORIGIN,
          changeOrigin: true,
          ws: false,
          /**
           * Strip the prefix *and the query string*.
           *
           * The app appends `?t=<attempt>` to force a fresh request — an MJPEG URL is
           * a perpetual connection, so re-rendering an `<img>` with an unchanged
           * `src` is a no-op and the retry button would do nothing. That cache-buster
           * is for the browser's benefit only. `jetson/stream.py` compares the raw
           * `self.path` against `/stream` and calls `send_error(404)` for anything
           * else, so forwarding `?t=1` verbatim makes every retry a 404. Dropping it
           * here keeps both behaviours: the browser still issues a genuinely new
           * request, and the server still sees the path it expects.
           */
          rewrite: (p) => p.replace(/^\/jetson/, '').split('?')[0] ?? '',
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Connection', 'keep-alive')
            })
          },
        },
      },
    },
  }
})
