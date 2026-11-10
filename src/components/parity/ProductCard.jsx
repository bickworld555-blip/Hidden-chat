import { useEffect, useState } from 'react';
import { ShoppingBag } from 'lucide-react';
import { getCatalogItem } from '../../parityApi.js';
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
export function ProductCard({ itemId, sessionToken, children }) {
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
          </div>
        </>
      )}
      {children}
    </div>
  );
}
