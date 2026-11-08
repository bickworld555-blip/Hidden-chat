import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const configuredHosts = (process.env.VITE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const tunnelHost = process.env.VITE_TUNNEL_HOST?.trim().toLowerCase();
const allowedHosts = [...new Set(['localhost', '127.0.0.1', '.ngrok-free.app', ...configuredHosts, ...(tunnelHost ? [tunnelHost] : [])])];

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
});