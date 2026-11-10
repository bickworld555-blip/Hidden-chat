import { useEffect, useState } from 'react';
import { ShoppingBag, X } from 'lucide-react';
import { listCatalog } from '../../parityApi.js';
import { CatalogImage, formatPrice } from './ProductCard.jsx';

/** Pick one of your catalog items to share in a chat. */
export default function CatalogPicker({ sessionToken, userId, onSend, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    listCatalog(sessionToken, userId).then((list) => setItems(list.filter((item) => !item.hidden))).catch((caught) => setError(caught.message));
  }, [sessionToken, userId]);
  return (
    <div className="wa-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="hm-sheet" role="dialog" aria-modal="true" aria-label="Share from your catalog" onClick={(event) => event.stopPropagation()}>
        <header className="hm-sheet-head">
          <h3>Share from your catalog</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        {error && <p className="hm-error" role="alert">{error}</p>}
        {!items && !error && <p className="hm-muted">Loading…</p>}
        {items?.length === 0 && (
          <p className="hm-empty"><ShoppingBag size={28} aria-hidden="true" /><br />Your catalog is empty. Add items in Tools → Business tools → Catalog.</p>
        )}
        <ul className="hm-catalog-list">
          {items?.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onSend(item.id)} aria-label={`Share ${item.name}`}>
                <CatalogImage path={item.image} sessionToken={sessionToken} alt="" className="hm-catalog-thumb" />
                <span><strong>{item.name}</strong>{item.price && <small>{formatPrice(item.price, item.currency)}</small>}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
