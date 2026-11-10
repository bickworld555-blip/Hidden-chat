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

const configuredHosts = (process.env.VITE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const tunnelHost = process.env.VITE_TUNNEL_HOST?.trim().toLowerCase();
const allowedHosts = [...new Set(['localhost', '127.0.0.1', '.ngrok-free.app', ...configuredHosts, ...(tunnelHost ? [tunnelHost] : [])])];

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), androidCsp(mode)],
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
