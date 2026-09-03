import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DEV_PORT = frontend port (defaults to 5173 — change with FE_PORT=...).
// DEV_BACKEND = backend origin (defaults to http://localhost:6767 — change
//                with FE_BACKEND=http://localhost:3767 when running alongside
//                another project that owns 6767).
const DEV_PORT = parseInt(process.env.FE_PORT || '5173', 10);
const DEV_BACKEND = process.env.FE_BACKEND || 'http://localhost:6767';

// v1.87.7 — redirect `/csfaq` (no trailing slash) to `/csfaq/` so users
// who type the app URL without the trailing slash land on the SPA
// instead of Vite's plain-text "did you mean to visit /csfaq/"
// 404. The proxy rules in `server.proxy` (matched by path prefix)
// still win for /csfaq/api/*, /csfaq/uploads/*, etc. — this only
// fires for the bare /csfaq route, which has no API or static
// counterpart.
function csfaqBaseRedirect(): Plugin {
  return {
    name: 'csfaq-base-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/csfaq') {
          res.writeHead(308, { Location: '/csfaq/' });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

// Offline Mode (PWA) — vite-plugin-pwa generates the service worker and
// manifest at build time, but registration in the browser is gated behind
// the `offlineMode` feature flag (see src/offline/registerOfflineServiceWorker.ts).
// injectRegister: false means the plugin does NOT auto-inject a registration
// script into index.html — we call registerSW() ourselves, only when the
// flag is on, so the feature is genuinely off (no service worker at all)
// when the flag is disabled.
const offlinePwaPlugin = VitePWA({
  registerType: 'prompt',
  injectRegister: false,
  // Lets the service worker run under `pnpm dev` too (normally PWA
  // features only activate in a production build). Handy for local
  // testing without a full build+preview cycle every time.
  devOptions: {
    enabled: true,
    type: 'module',
  },
  manifest: {
    name: 'Yaksha FAQ Portal',
    short_name: 'Yaksha FAQ',
    description: 'Semantic search-powered FAQ and community board for internship students.',
    start_url: '/csfaq/',
    scope: '/csfaq/',
    display: 'standalone',
    background_color: '#0b0b0f',
    theme_color: '#0b0b0f',
    icons: [
      { src: '/logo.jpg', sizes: '1024x1024', type: 'image/jpeg' },
      { src: '/logo.jpg', sizes: '1024x1024', type: 'image/jpeg', purpose: 'maskable' },
    ],
  },
  workbox: {
    skipWaiting: true,
    clientsClaim: true,
    // Lets users reload a previously-visited FAQ page (or the app shell)
    // while offline instead of getting the browser's default offline error.
    navigateFallback: '/csfaq/index.html',
    navigateFallbackDenylist: [/^\/csfaq\/api\//, /^\/csfaq\/admin/],
    runtimeCaching: [
      {
        // FAQ list, categories, recent, paginated, and individual FAQ detail
        // pages — the data this feature is actually about caching.
        urlPattern: /\/csfaq\/api\/faq(\/[^?]*)?(\?.*)?$/,
        handler: 'StaleWhileRevalidate',
        method: 'GET',
        options: {
          cacheName: 'faq-api-cache',
          expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
          cacheableResponse: { statuses: [0, 200] },
        },
      },
      {
        // The FAQ page can't render without knowing the active program
        // (batches) and which experimental features are on (feature-flags).
        // Both are small, low-churn, and needed to make a cached FAQ page
        // actually usable offline rather than stuck on an empty state.
        urlPattern: /\/csfaq\/api\/(batches|feature-flags)(\/[^?]*)?(\?.*)?$/,
        handler: 'StaleWhileRevalidate',
        method: 'GET',
        options: {
          cacheName: 'faq-context-cache',
          expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
          cacheableResponse: { statuses: [0, 200] },
        },
      },
    ],
  },
});

export default defineConfig({
  base: '/csfaq/',
  plugins: [react(), csfaqBaseRedirect(), offlinePwaPlugin],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: DEV_PORT,
    proxy: {
      // API calls go to the backend
      '/csfaq/api':     { target: DEV_BACKEND, changeOrigin: true },
      // v1.69 — publicBasePath fix: onboarding resources (SVG, PDF, PPTX,
      // video, etc.) are stored at /csfaq/uploads/... in Mongo. In dev the
      // backend runs on DEV_BACKEND, so asset fetches from the Vite dev
      // server need to be forwarded there. Without this rule the browser
      // requests /csfaq/uploads/... from Vite directly → 404. In production
      // the backend serves everything at /csfaq/ so no proxy is needed.
      '/csfaq/uploads': { target: DEV_BACKEND, changeOrigin: true },
      '/uploads':       { target: DEV_BACKEND, changeOrigin: true },
    },
  },
  optimizeDeps: {
    exclude: ['@xenova/transformers'],
  },
  worker: {
    format: 'es',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    isolate: true,
  },
});