// This app's wire version, sent with every API request (header) and the realtime connection (subprotocol). The
// server refuses older versions (server/clientGate.mjs) so apps from before end-to-end-only, queue-based delivery
// can no longer send or receive. Raise it only when older apps must be cut off.
export const CLIENT_PROTOCOL = 2;
export const CLIENT_HEADER = 'X-HM-Client';
export const CLIENT_SUBPROTOCOL = `relay.client.${CLIENT_PROTOCOL}`;
