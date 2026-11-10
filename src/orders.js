// Orders from a business's catalog, as chat messages (end-to-end encrypted like any other):
//   "order:{ items: [{ id, name, price, qty }], currency, total, note }"   sent by the buyer to the seller
//   "order-status:{ order: <order message id>, status, note }"             sent by the seller
// Payment is arranged between buyer and seller (cash on delivery, their payment link…); no payment is taken here.
export const ORDER_PREFIX = 'order:';
export const ORDER_STATUS_PREFIX = 'order-status:';
export const ORDER_STATUSES = ['accepted', 'declined', 'paid', 'shipped', 'delivered', 'cancelled'];
export const MAX_ORDER_ITEMS = 30;

const STATUS_LABELS = { pending: 'Waiting for the seller', accepted: 'Accepted', declined: 'Declined', paid: 'Paid', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
export const orderStatusLabel = (status) => STATUS_LABELS[status] ?? STATUS_LABELS.pending;

const money = (value) => Math.round(Number(value) * 100) / 100;

/** The order message for the chosen catalog items ({ item, qty }); null when nothing is chosen. */
export function encodeOrder(lines, note = '') {
  const items = lines.filter((line) => line?.item && Number.isInteger(line.qty) && line.qty > 0).slice(0, MAX_ORDER_ITEMS)
    .map(({ item, qty }) => ({ id: item.id, name: String(item.name ?? '').slice(0, 100), price: money(item.price ?? 0), qty: Math.min(qty, 999) }));
  if (!items.length) return null;
  const currency = String(lines.find((line) => line?.item)?.item.currency ?? '').slice(0, 8);
  const total = money(items.reduce((sum, item) => sum + item.price * item.qty, 0));
  return ORDER_PREFIX + JSON.stringify({ items, currency, total, note: String(note).slice(0, 500) });
}

export function parseOrder(content) {
  if (typeof content !== 'string' || !content.startsWith(ORDER_PREFIX)) return null;
  try {
    const order = JSON.parse(content.slice(ORDER_PREFIX.length));
    if (!Array.isArray(order?.items) || !order.items.length || order.items.length > MAX_ORDER_ITEMS) return null;
    const items = order.items.filter((item) => typeof item?.name === 'string' && Number.isFinite(item.price) && Number.isInteger(item.qty) && item.qty > 0);
    if (items.length !== order.items.length) return null;
    // The total is always recomputed: what the buyer's app claimed is not trusted.
    return { items, currency: typeof order.currency === 'string' ? order.currency : '', total: money(items.reduce((sum, item) => sum + item.price * item.qty, 0)), note: typeof order.note === 'string' ? order.note : '' };
  } catch {
    return null;
  }
}

export function encodeOrderStatus(orderMessageId, status, note = '') {
  if (!ORDER_STATUSES.includes(status) || !orderMessageId) return null;
  return ORDER_STATUS_PREFIX + JSON.stringify({ order: orderMessageId, status, note: String(note).slice(0, 300) });
}

export function parseOrderStatus(content) {
  if (typeof content !== 'string' || !content.startsWith(ORDER_STATUS_PREFIX)) return null;
  try {
    const value = JSON.parse(content.slice(ORDER_STATUS_PREFIX.length));
    return typeof value?.order === 'string' && ORDER_STATUSES.includes(value.status) ? { order: value.order, status: value.status, note: typeof value.note === 'string' ? value.note : '' } : null;
  } catch {
    return null;
  }
}

/**
 * An order's current status from the chat ("pending" until the seller answers): the seller's latest update, or
 * the buyer's cancellation while it is still pending. Updates from anyone else are ignored.
 */
export function orderStatusIn(messages, orderMessageId, sellerId, buyerId) {
  let status = 'pending';
  for (const message of messages ?? []) {
    const update = parseOrderStatus(message.content);
    if (update?.order !== orderMessageId) continue;
    if (message.senderId === sellerId && status !== 'cancelled') status = update.status;
    else if (message.senderId === buyerId && update.status === 'cancelled' && status === 'pending') status = 'cancelled';
  }
  return status;
}

export function formatMoney(amount, currency) {
  try {
    return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount) : String(amount);
  } catch {
    return `${amount} ${currency}`.trim();
  }
}

/** Chat-list and notification wording. */
export function orderPreview(content) {
  const order = parseOrder(content);
  if (order) return `🛒 Order · ${order.items.reduce((sum, item) => sum + item.qty, 0)} item${order.items.length === 1 && order.items[0].qty === 1 ? '' : 's'}`;
  const update = parseOrderStatus(content);
  return update ? `🛒 Order ${orderStatusLabel(update.status).toLowerCase()}` : null;
}
