import { ArrowLeft, X } from 'lucide-react';
import { useBackHandler } from '../../backStack.js';

/** A full-screen panel (like the group and account screens): back walks `onBack`, else closes. */
export default function Panel({ title, subtitle, onClose, onBack, actions, children, label, inline = false }) {
  useBackHandler(!inline || Boolean(onBack), () => (onBack ? onBack() : onClose()));
  if (inline) {
    return (
      <section className="hm-panel hm-panel-inline" aria-label={label ?? title}>
        <header className="hm-panel-header">
          {onBack && <button type="button" className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeft size={20} /></button>}
          <span className="hm-panel-title"><h2>{title}</h2>{subtitle && <small>{subtitle}</small>}</span>
          {actions}
        </header>
        <div className="hm-panel-body">{children}</div>
      </section>
    );
  }
  return (
    <div className="hm-panel-overlay" role="dialog" aria-modal="true" aria-label={label ?? title}>
      <div className="hm-panel">
        <header className="hm-panel-header">
          <button type="button" className="icon-button" onClick={onBack ?? onClose} aria-label="Back"><ArrowLeft size={20} /></button>
          <span className="hm-panel-title"><h2>{title}</h2>{subtitle && <small>{subtitle}</small>}</span>
          {actions}
          {onBack && <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>}
        </header>
        <div className="hm-panel-body">{children}</div>
      </div>
    </div>
  );
}

export function Notice({ error, notice }) {
  if (error) return <p className="hm-error" role="alert">{error}</p>;
  if (notice) return <p className="hm-notice" role="status">{notice}</p>;
  return null;
}
