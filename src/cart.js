// Shopping carts, one per business, on this device: { [itemId]: quantity }. Filled from the business's catalog
// (the cart sheet, OrderMessages.jsx), sent as an order message, then emptied.
import { useSyncExternalStore } from 'react';
import { deviceStorage } from './deviceStorage.js';

const key = (sellerId) => `hm:cart:${sellerId}`;
const listeners = new Set();
const cache = new Map();

export function getCart(sellerId) {
  if (!sellerId) return {};
  if (!cache.has(sellerId)) {
    let value = {};
    try { value = JSON.parse(deviceStorage.getItem(key(sellerId)) ?? '{}') ?? {}; } catch { value = {}; }
    cache.set(sellerId, value && typeof value === 'object' ? value : {});
  }
  return cache.get(sellerId);
}

function save(sellerId, cart) {
  const clean = Object.fromEntries(Object.entries(cart).filter(([, qty]) => Number.isInteger(qty) && qty > 0).map(([id, qty]) => [id, Math.min(qty, 999)]));
  cache.set(sellerId, clean);
  try { if (Object.keys(clean).length) deviceStorage.setItem(key(sellerId), JSON.stringify(clean)); else deviceStorage.removeItem(key(sellerId)); } catch { /* private mode */ }
  for (const listener of listeners) listener();
}

export const setCartQuantity = (sellerId, itemId, qty) => save(sellerId, { ...getCart(sellerId), [itemId]: Math.max(0, qty) });
export const clearCart = (sellerId) => save(sellerId, {});
export const cartCount = (cart) => Object.values(cart ?? {}).reduce((sum, qty) => sum + qty, 0);

const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const useCart = (sellerId) => useSyncExternalStore(subscribe, () => getCart(sellerId), () => ({}));
