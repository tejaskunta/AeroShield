import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Jetson live-feed origin for the dev proxy.
 *
 * ONE PLACE TO CHANGE IT. This used to be a second, separate setting: the app
 * read `VITE_JETSON_DIRECT_ORIGIN` from `frontend/.env.local` while the proxy
 * read `AEROSHIELD_JETSON_ORIGIN` from the shell. Changing the aircraft's
 * address meant editing both, and forgetting the second one failed silently —
 * the panel showed "No signal" while the value the operator had just corrected
 * was sitting in `.env.local`, visibly right. The proxy now reads the same
 * variable the app does, so a wrong address is wrong in one place.
 *
 * `AEROSHIELD_JETSON_ORIGIN` still wins if set, for a one-off run against a
 * different board without touching a tracked-adjacent file.
 *
 * The default is loopback because the feed arrives over `scripts/tunnel.ps1`
 * (`ssh -L 8080:127.0.0.1:8080`), the same SSH connection that carries
 * detections the other way. That makes the proxy target independent of whatever
 * address the phone hotspot gave the aircraft. `scripts/dev_mjpeg.py` listens on
 * the same port, so a rehearsal exercises exactly this path.
 */
const DEFAULT_JETSON_ORIGIN = 'http://127.0.0.1:8080'

/**
 * There used to be a build-time guard here that failed a production build without
 * `VITE_MAPBOX_TOKEN`. It is gone with the token.
 *
 * It existed because the imagery was a licensed raster behind a gitignored secret,
 * so a fresh clone silently served a coarser map — Google's built-in types capped at
 * zoom 20 against Mapbox's 22, a factor of four in ground scale — and two people on
 * the same commit described different maps with nothing on screen to explain why.
 *
 * Esri World Imagery needs no key, so there is no longer a configuration state in
 * which the map is quietly worse. Removing the guard rather than leaving it as a
 * no-op is deliberate: a check that can never fail is worse than no check, because
 * it reads as a guarantee.
 */

export default defineConfig(({ mode }) => {
  // Read the same .env files the app reads, so the proxy and the UI cannot
  // disagree about where the aircraft is. `loadEnv` is called with '' (not 'VITE_')
  // so AEROSHIELD_JETSON_ORIGIN in .env.local is honoured too.
  const env = loadEnv(mode, __dirname, '')
  const JETSON_ORIGIN =
    process.env.AEROSHIELD_JETSON_ORIGIN ??
    env.AEROSHIELD_JETSON_ORIGIN ??
    env.VITE_JETSON_DIRECT_ORIGIN ??
    DEFAULT_JETSON_ORIGIN

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
