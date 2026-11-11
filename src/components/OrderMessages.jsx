// Ordering from a business's catalog inside a chat (src/orders.js): the buyer picks quantities and sends an order;
// the seller accepts or declines it and marks it paid, shipped and delivered. All of it is ordinary end-to-end
// encrypted chat messages; payment is arranged between the two (no payment provider is connected yet).
import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '../store.js';
import { Minus, Plus, ShoppingCart, X } from 'lucide-react';
import { listCatalog, listCollections } from '../parityApi.js';
import { cartCount, clearCart, setCartQuantity, useCart } from '../cart.js';
import { encodeOrder, encodeOrderStatus, formatMoney, orderStatusIn, orderStatusLabel, parseOrder } from '../orders.js';

// The cart for one business: its catalog (by collection), quantities kept on this device until the order is sent.
export function OrderComposer({ sessionToken, sellerId, sellerName, onSend, onClose }) {
  const [items, setItems] = useState(null);
  const [collections, setCollections] = useState([]);
  const quantities = useCart(sellerId);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    listCatalog(sessionToken, sellerId).then((list) => setItems(list.filter((item) => !item.hidden))).catch((caught) => setError(caught.message));
    listCollections(sessionToken, sellerId).then(setCollections).catch(() => setCollections([]));
  }, [sessionToken, sellerId]);
  const lines = useMemo(() => (items ?? []).map((item) => ({ item, qty: quantities[item.id] ?? 0 })), [items, quantities]);
  // Sections: each collection in order, then everything not in one.
  const sections = useMemo(() => {
    const byId = new Map(lines.map((line) => [line.item.id, line]));
    const grouped = collections.map((collection) => ({ id: collection.id, name: collection.name, lines: collection.itemIds.map((id) => byId.get(id)).filter(Boolean) })).filter((section) => section.lines.length);
    const used = new Set(grouped.flatMap((section) => section.lines.map((line) => line.item.id)));
    const rest = lines.filter((line) => !used.has(line.item.id));
    return [...grouped, ...(rest.length ? [{ id: 'rest', name: grouped.length ? 'More items' : '', lines: rest }] : [])];
  }, [lines, collections]);
  const total = lines.reduce((sum, line) => sum + Number(line.item.price || 0) * line.qty, 0);
  const currency = items?.[0]?.currency ?? '';
  const change = (id, delta) => setCartQuantity(sellerId, id, Math.min(999, (quantities[id] ?? 0) + delta));
  const content = encodeOrder(lines, note);
  const count = cartCount(quantities);
  return (
    <div className="hm-sheet" role="dialog" aria-label={`Cart for ${sellerName}`}>
      <header><strong><ShoppingCart size={18} /> {count ? `Your cart · ${count}` : `Shop ${sellerName}`}</strong><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></header>
      {error && <p className="hm-error">{error}</p>}
      {items === null && !error && <p className="hm-muted">Loading the catalog…</p>}
      {items?.length === 0 && <p className="hm-muted">{sellerName} has no catalog items.</p>}
      {sections.map((section) => (
        <section key={section.id} className="order-section">
          {section.name && <h3 className="hm-section">{section.name}</h3>}
      <ul className="order-lines">
        {section.lines.map(({ item, qty }) => (
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
        </section>
      ))}
      {items?.length > 0 && (
        <>
          <textarea className="hm-input" maxLength={500} placeholder="Note for the seller (address, size…)" value={note} onChange={(event) => setNote(event.target.value)} />
          <p className="order-total"><span>Total</span><strong>{formatMoney(Math.round(total * 100) / 100, currency)}</strong></p>
          <p className="hm-muted">Payment is arranged with the seller (for example cash on delivery or their payment link).</p>
          <div className="hm-row-actions">
            {count > 0 && <button type="button" onClick={() => clearCart(sellerId)}>Empty cart</button>}
            <button type="button" className="hm-primary" disabled={!content} onClick={() => { onSend(content); clearCart(sellerId); onClose(); }}>Send order</button>
          </div>
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
