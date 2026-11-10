// Ordering from a business's catalog inside a chat (src/orders.js): the buyer picks quantities and sends an order;
// the seller accepts or declines it and marks it paid, shipped and delivered. All of it is ordinary end-to-end
// encrypted chat messages; payment is arranged between the two (no payment provider is connected yet).
import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '../store.js';
import { Minus, Plus, ShoppingCart, X } from 'lucide-react';
import { listCatalog } from '../parityApi.js';
import { encodeOrder, encodeOrderStatus, formatMoney, orderStatusIn, orderStatusLabel, parseOrder } from '../orders.js';

export function OrderComposer({ sessionToken, sellerId, sellerName, onSend, onClose }) {
  const [items, setItems] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    listCatalog(sessionToken, sellerId).then((list) => setItems(list.filter((item) => !item.hidden))).catch((caught) => setError(caught.message));
  }, [sessionToken, sellerId]);
  const lines = useMemo(() => (items ?? []).map((item) => ({ item, qty: quantities[item.id] ?? 0 })), [items, quantities]);
  const total = lines.reduce((sum, line) => sum + Number(line.item.price || 0) * line.qty, 0);
  const currency = items?.[0]?.currency ?? '';
  const change = (id, delta) => setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(999, (current[id] ?? 0) + delta)) }));
  const content = encodeOrder(lines, note);
  return (
    <div className="hm-sheet" role="dialog" aria-label={`Order from ${sellerName}`}>
      <header><strong><ShoppingCart size={18} /> Order from {sellerName}</strong><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></header>
      {error && <p className="hm-error">{error}</p>}
      {items === null && !error && <p className="hm-muted">Loading the catalog…</p>}
      {items?.length === 0 && <p className="hm-muted">{sellerName} has no catalog items.</p>}
      <ul className="order-lines">
        {lines.map(({ item, qty }) => (
          <li key={item.id}>
            <span><strong>{item.name}</strong><small>{formatMoney(Number(item.price || 0), item.currency)}</small></span>
            <span className="order-qty">
              <button type="button" onClick={() => change(item.id, -1)} disabled={!qty} aria-label={`Fewer ${item.name}`}><Minus size={14} /></button>
              <output>{qty}</output>
              <button type="button" onClick={() => change(item.id, 1)} aria-label={`More ${item.name}`}><Plus size={14} /></button>
            </span>
          </li>
        ))}
      </ul>
      {items?.length > 0 && (
        <>
          <textarea className="hm-input" maxLength={500} placeholder="Note for the seller (address, size…)" value={note} onChange={(event) => setNote(event.target.value)} />
          <p className="order-total"><span>Total</span><strong>{formatMoney(Math.round(total * 100) / 100, currency)}</strong></p>
          <p className="hm-muted">Payment is arranged with the seller (for example cash on delivery or their payment link).</p>
          <button type="button" className="hm-primary" disabled={!content} onClick={() => { onSend(content); onClose(); }}>Send order</button>
        </>
      )}
    </div>
  );
}

export function OrderBubble({ message, mine, peerId, onStatus, children }) {
  const messages = useChatStore((state) => state.messages[peerId]);
  const order = parseOrder(message.content);
  const sellerId = mine ? message.receiverId : message.senderId;
  const status = orderStatusIn(messages, message.id, sellerId, message.senderId);
  if (!order) return null;
  const isSeller = !mine;
  const next = status === 'pending' ? ['accepted', 'declined'] : status === 'accepted' ? ['paid', 'shipped'] : status === 'paid' ? ['shipped'] : status === 'shipped' ? ['delivered'] : [];
  return (
    <div className="order-bubble">
      <strong className="order-title"><ShoppingCart size={16} /> Order · {orderStatusLabel(status)}</strong>
      <ul>
        {order.items.map((item) => <li key={item.id ?? item.name}><span>{item.qty} × {item.name}</span><span>{formatMoney(Math.round(item.price * item.qty * 100) / 100, order.currency)}</span></li>)}
      </ul>
      <p className="order-total"><span>Total</span><strong>{formatMoney(order.total, order.currency)}</strong></p>
      {order.note && <p className="order-note">{order.note}</p>}
      {isSeller && next.length > 0 && (
        <span className="order-actions">
          {next.map((value) => <button key={value} type="button" onClick={() => onStatus(encodeOrderStatus(message.id, value))}>{orderStatusLabel(value)}</button>)}
        </span>
      )}
      {mine && status === 'pending' && <span className="order-actions"><button type="button" onClick={() => onStatus(encodeOrderStatus(message.id, 'cancelled'))}>Cancel order</button></span>}
      {children}
    </div>
  );
}
