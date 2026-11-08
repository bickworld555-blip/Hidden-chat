import { networkInterfaces } from 'node:os';
import { createChatServer } from './index.mjs';

// Starts unconditionally: Hostinger and similar hosts load the entry through a wrapper,
// so an "is this the main module" check would never call listen().
let service;
try {
  // The schema migration is transactional and never replaces an existing schema;
  // RELAY_AUTO_MIGRATE=false leaves schema changes to `npm run db:migrate`.
  service = createChatServer({ migrate: process.env.RELAY_AUTO_MIGRATE !== 'false' });
  const address = await service.listen();
  console.log(`Hidden Messenger API listening on ${address.address}:${address.port}`);
  const lanAddresses = Object.values(networkInterfaces()).flatMap((interfaces) => interfaces ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${address.port}`);
  for (const url of lanAddresses) console.log(`Hidden Messenger API LAN address: ${url}`);
} catch (error) {
  console.error('Hidden Messenger server failed to start:', error.message, error.code ? `(${error.code})` : '');
  await service?.db?.close?.().catch(() => {});
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await service.close(); process.exit(0); });
}
