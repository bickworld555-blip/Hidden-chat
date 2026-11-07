import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const appDirectory = new URL('../', import.meta.url);
const ngrok = spawn('ngrok', ['http', '5173', '--host-header=rewrite'], {
  cwd: appDirectory,
  stdio: 'inherit',
  windowsHide: true,
});
let app;
let stopping = false;

function stopProcesses() {
  if (stopping) return;
  stopping = true;
  app?.kill();
  ngrok.kill();
}

process.on('SIGINT', stopProcesses);
process.on('SIGTERM', stopProcesses);
ngrok.on('error', (error) => {
  console.error(`Could not start ngrok: ${error.message}`);
  console.error('Install ngrok, configure its auth token, then run npm run tunnel:ngrok again.');
  process.exitCode = 1;
});

async function getTunnel() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch('http://127.0.0.1:4040/api/tunnels');
      if (response.ok) {
        const { tunnels = [] } = await response.json();
        const tunnel = tunnels.find((item) => item.public_url?.startsWith('https://'));
        if (tunnel) return new URL(tunnel.public_url);
      }
    } catch { /* Wait for the local ngrok agent API to become ready. */ }
    await delay(350);
  }
  throw new Error('Timed out waiting for the ngrok HTTPS URL.');
}

try {
  const publicUrl = await getTunnel();
  console.log(`Relay public test URL: ${publicUrl.origin}`);
  console.log('This exposes the demo app publicly. Use test accounts only and stop the process when finished.');
  const origins = new Set((process.env.RELAY_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean));
  origins.add(publicUrl.origin);
  const hosts = new Set((process.env.VITE_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean));
  hosts.add(publicUrl.hostname);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  app = spawn(npm, ['run', 'dev'], {
    cwd: appDirectory,
    env: {
      ...process.env,
      PORT: process.env.PORT || '4174',
      RELAY_ALLOWED_ORIGINS: [...origins].join(','),
      VITE_ALLOWED_HOSTS: [...hosts].join(','),
      VITE_TUNNEL_HOST: publicUrl.hostname,
      VITE_HMR_CLIENT_PORT: '443',
    },
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  app.on('exit', (code) => {
    stopProcesses();
    process.exitCode = code ?? 0;
  });
  ngrok.on('exit', (code) => {
    if (!stopping) {
      console.error(`ngrok exited unexpectedly with code ${code}.`);
      stopProcesses();
      process.exitCode = code ?? 1;
    }
  });
} catch (error) {
  console.error(error.message);
  stopProcesses();
  process.exitCode = 1;
}
