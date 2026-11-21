import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { bundledCsp } from './scripts/configure-android.mjs';

// The APK's bundled build (scripts/build-android-web.mjs, mode 'android') carries a strict Content-Security-Policy:
// scripts only from the APK, network only to the app's server and its map/place services.
function androidCsp(mode) {
  return {
    name: 'hidden-android-csp',
    transformIndexHtml(html) {
      if (mode !== 'android') return html;
      const policy = bundledCsp(process.env.ANDROID_APP_URL);
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

// /admin is its own page (admin.html → src/admin/). In development, serve it at /admin like the server does.
function adminPage() {
  return {
    name: 'hidden-admin-page',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (/^\/admin(?:\/[^.?]*)?(?:\?.*)?$/.test(request.url ?? '')) request.url = '/admin.html';
        next();
      });
    },
  };
}

// The messenger (src/App.jsx) is imported only once the device's settings are loaded (src/main.jsx), but its code can
// be fetched and compiled meanwhile: modulepreload does that without running it, so the import that follows finds it
// ready instead of starting from nothing (the chat list waited for it on every cold start).
function preloadApp() {
  return {
    name: 'hidden-preload-app',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle || !/(^|[\\/])index\.html$/.test(ctx.filename ?? '')) return html;
        // The chunk holding src/App.jsx (merged chunks have no facade module, so its module list is what names it).
        const isApp = (id) => String(id ?? '').replace(/\\/g, '/').endsWith('/src/App.jsx');
        const app = Object.values(ctx.bundle).find((chunk) => chunk.type === 'chunk' && (isApp(chunk.facadeModuleId) || (chunk.moduleIds ?? Object.keys(chunk.modules ?? {})).some(isApp)));
        if (!app) return html;
        const tags = [app.fileName, ...app.imports]
          .filter((file) => !html.includes(`/${file}"`))
          .map((file) => `<link rel="modulepreload" crossorigin href="/${file}">`);
        return tags.length ? html.replace('</head>', `  ${tags.join('\n    ')}\n  </head>`) : html;
      },
    },
  };
}

const configuredHosts = (process.env.VITE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const tunnelHost = process.env.VITE_TUNNEL_HOST?.trim().toLowerCase();
const allowedHosts = [...new Set(['localhost', '127.0.0.1', '.ngrok-free.app', ...configuredHosts, ...(tunnelHost ? [tunnelHost] : [])])];

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), androidCsp(mode), adminPage(), preloadApp()],
  // The web build has two pages: the app and the standalone admin page. The APK bundle has the app and its
  // background page (run on push with no app screen: android BackgroundHost.java, src/background/main.js).
  build: mode === 'android'
    ? { rollupOptions: { input: { main: 'index.html', background: 'background.html' } } }
    : { rollupOptions: { input: { main: 'index.html', admin: 'admin.html' } } },
  server: {
    host: true,
    strictPort: true,
    allowedHosts,
    hmr: tunnelHost ? { host: tunnelHost, protocol: 'wss', clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) || 443 } : undefined,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4174', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:4174', ws: true, changeOrigin: false },
    },
  },
}));
