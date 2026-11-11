import { useEffect, useState } from 'react';
import { ShoppingBag } from 'lucide-react';
import { getCatalogItem } from '../../parityApi.js';
import { setCartQuantity, useCart } from '../../cart.js';
import { useChatStore } from '../../store.js';
import { apiFetch } from '../../api.js';

export const PRODUCT_PREFIX = 'product:';
export const productContent = (itemId) => `${PRODUCT_PREFIX}${itemId}`;
export const parseProductContent = (content) => (typeof content === 'string' && content.startsWith(PRODUCT_PREFIX) ? content.slice(PRODUCT_PREFIX.length) || null : null);

export function formatPrice(price, currency) {
  if (!price) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(price));
  } catch {
    return `${price} ${currency}`;
  }
}

/** A catalog image (the endpoint needs the session, so it is fetched and shown as a blob URL). */
export function CatalogImage({ path, sessionToken, alt = '', className = 'hm-catalog-image' }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!path || !sessionToken) return undefined;
    let objectUrl = '';
    let active = true;
    apiFetch(path, { headers: { Authorization: `Bearer ${sessionToken}` } })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, sessionToken]);
  return url ? <img className={className} src={url} alt={alt} /> : <span className={`${className} is-placeholder`} aria-hidden="true"><ShoppingBag size={28} /></span>;
}

/** A shared catalog item inside a chat bubble. */
// Add to cart (cart.js), on products from someone else's catalog; the cart icon in the chat header sends the order.
function AddToCart({ sellerId, itemId }) {
  const cart = useCart(sellerId);
  const qty = cart[itemId] ?? 0;
  return qty ? (
    <span className="order-qty hm-add-to-cart" role="group" aria-label="In your cart">
      <button type="button" onClick={() => setCartQuantity(sellerId, itemId, qty - 1)} aria-label="One fewer">−</button>
      <output>{qty} in cart</output>
      <button type="button" onClick={() => setCartQuantity(sellerId, itemId, qty + 1)} aria-label="One more">+</button>
    </span>
  ) : <button type="button" className="hm-add-to-cart-button" onClick={() => setCartQuantity(sellerId, itemId, 1)}>Add to cart</button>;
}

export function ProductCard({ itemId, sessionToken, children }) {
  const viewerId = useChatStore((state) => state.userId);
  const [item, setItem] = useState(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let active = true;
    getCatalogItem(sessionToken, itemId).then((value) => active && setItem(value)).catch(() => active && setMissing(true));
    return () => { active = false; };
  }, [itemId, sessionToken]);
  return (
    <div className="hm-product-card">
      {missing ? <p className="hm-product-missing"><ShoppingBag size={18} aria-hidden="true" /> This item is no longer available.</p> : (
        <>
          <CatalogImage path={item?.image} sessionToken={sessionToken} alt={item?.name ?? ''} />
          <div className="hm-product-copy">
            <strong>{item?.name ?? 'Loading…'}</strong>
            {item?.price && <span className="hm-product-price">{formatPrice(item.price, item.currency)}</span>}
            {item?.description && <p>{item.description}</p>}
            {item?.link && <a href={item.link} target="_blank" rel="noopener noreferrer">View on website</a>}
            {item?.owner && <small>From {item.owner.name}’s catalog</small>}
            {item?.owner && item.owner.id !== viewerId && <AddToCart sellerId={item.owner.id} itemId={item.id} />}
          </div>
        </>
      )}
      {children}
    </div>
  );
}
