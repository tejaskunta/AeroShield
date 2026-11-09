import { defineConfig } from 'vite'
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

export default defineConfig({
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
})
