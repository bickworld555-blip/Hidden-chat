// The three-dot menu at the right of a tab's header (Calls, Updates, Tools), like the one on Chats.
import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

export default function TabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <span className="wa-header-menu-wrap tab-menu" ref={ref}>
      <button type="button" className="wa-icon-btn" onClick={() => setOpen((value) => !value)} aria-label="Menu" aria-expanded={open}><MoreVertical size={20} /></button>
      {open && (
        <div className="wa-sel-dropdown wa-header-dropdown" role="menu" onClick={() => setOpen(false)}>
          {items.filter(Boolean).map((item) => <button key={item.label} type="button" role="menuitem" onClick={item.onClick}>{item.label}</button>)}
        </div>
      )}
    </span>
  );
}
