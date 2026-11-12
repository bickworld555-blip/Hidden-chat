// Local-first delivery: once a message is saved on this device (its attachment included) the server is told, and
// deletes the message when every device it was meant for has done the same (server/deliveryQueue.mjs). A message
// this device cannot read yet (still sealed, or waiting for a key) is never acknowledged: the server's copy is the
// only one until it can be decrypted.
import { isEnvelope, parseRouting, routingFor } from './e2e/envelope.js';
import { apiFetch } from './api.js';
import { storeMediaLocally } from './media.js';

const acknowledged = new Set();
const MAX_REMEMBERED = 20000;

/** The attachment a message needs kept on this device before it is acknowledged (view once items are not kept). */
export function attachmentToKeep(content) {
  if (typeof content !== 'string') return null;
  const route = parseRouting(routingFor(content));
  if (!route || route.once || (route.kind !== 'media' && route.kind !== 'voice')) return null;
  return route.mediaId ?? null;
}

/** Whether this saved message may be acknowledged (it is readable here). */
export function acknowledgeable(message) {
  return Boolean(message?.id) && !message.e2eError && !isEnvelope(message.content) && !acknowledged.has(message.id);
}

async function send(messageIds, eventIds, { client, sessionToken }) {
  if (messageIds.length === 0 && eventIds.length === 0) return true;
  if (client?.send && client.send({ type: 'queue:ack', messageIds, eventIds }) !== false) return true;
  if (!sessionToken) return false;
  try {
    const response = await apiFetch('/api/v1/queue/ack', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds, eventIds }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Called after messages were written to this device's store. Attachments are fetched into the device's own
 * store first; a message whose attachment could not be kept yet is acknowledged later (when it is opened, or on the
 * next save).
 */
export async function acknowledgeSaved(messages, context) {
  const ready = [];
  for (const message of messages) {
    if (!acknowledgeable(message)) continue;
    const mediaId = attachmentToKeep(message.content);
    if (mediaId && !(await storeMediaLocally(mediaId, context.sessionToken))) continue;
    ready.push(message.id);
  }
  for (let start = 0; start < ready.length; start += 200) {
    const batch = ready.slice(start, start + 200);
    if (await send(batch, [], context)) for (const id of batch) acknowledged.add(id);
  }
  if (acknowledged.size > MAX_REMEMBERED) acknowledged.clear();
  return ready.length;
}

/** Queued events (receipts, plays, deletions) this device has applied. */
export function acknowledgeEvents(eventIds, context) {
  return send([], eventIds.filter((id) => typeof id === 'string'), context);
}

export function resetAcknowledgedForTests() {
  acknowledged.clear();
}
