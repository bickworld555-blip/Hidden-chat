import { useEffect } from 'react';
import { Ban, Flag, ShieldAlert, UserPlus, X } from 'lucide-react';
import { formatAccountNumber } from '../accountNumber.js';
import Avatar from './Avatar.jsx';
export { dismissUnknown, isUnknownSender, readDismissed } from '../unknownSender.js';

// Unknown sender (WhatsApp's notice for a chat with someone not in your contacts): who they are as far as the app
// knows (their own name, @username and ID), with Add and Block at hand, and Safety tools. Shown at the top of a chat
// with someone who wrote to you and is not saved (ChatWindow decides); Add or Block makes it go away.

export function UnknownSenderCard({ chat, onAdd, onBlock, onSafety, onDismiss }) {
  const own = chat.profileName || chat.name || (chat.username ? `@${chat.username}` : '');
  return (
    <section className="unknown-sender" aria-label="Not in your contacts">
      <button type="button" className="unknown-sender-close" onClick={onDismiss} aria-label="Hide this notice"><X size={16} /></button>
      <Avatar name={own} initials={chat.initials ?? own.slice(0, 2).toUpperCase()} color={chat.color} image={chat.avatar} />
      <strong className="unknown-sender-name">{own}</strong>
      <span className="unknown-sender-meta">
        {chat.username && <span>@{chat.username}</span>}
        {chat.number && <span>ID {formatAccountNumber(chat.number)}</span>}
      </span>
      <span className="unknown-sender-note">Not in your contacts</span>
      <button type="button" className="unknown-sender-safety" onClick={onSafety}><ShieldAlert size={15} aria-hidden="true" /> Safety tools</button>
      <div className="unknown-sender-actions">
        <button type="button" className="unknown-sender-block" onClick={onBlock}><Ban size={18} aria-hidden="true" /> Block</button>
        <button type="button" className="unknown-sender-add" onClick={onAdd}><UserPlus size={18} aria-hidden="true" /> Add</button>
      </div>
    </section>
  );
}

// Safety tools: what to keep in mind with someone you don't know, and Block / Report.
export function SafetyToolsSheet({ chat, onBlock, onReport, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const own = chat.profileName || chat.name || (chat.username ? `@${chat.username}` : 'this person');
  return (
    <div className="safety-sheet-backdrop" onClick={onClose}>
      <div className="safety-sheet" role="dialog" aria-modal="true" aria-label="Safety tools" onClick={(event) => event.stopPropagation()}>
        <span className="safety-sheet-grip" aria-hidden="true" />
        <h3><ShieldAlert size={20} aria-hidden="true" /> Safety tools</h3>
        <ul className="safety-sheet-tips">
          <li><strong>{own}</strong> is not in your contacts. Their name and photo are chosen by them and not checked by Hidden Messenger{chat.verified ? '' : ' (no verified tick)'}.</li>
          <li>Be careful with links, money requests and anyone asking for a code, a password or your ID card. Hidden Messenger never asks for these in a chat.</li>
          <li>Messages are end-to-end encrypted: only you and they can read them. A report tells Hidden Messenger who they are and why (no messages are sent), and blocks them.</li>
        </ul>
        <button type="button" className="safety-sheet-action danger" onClick={onBlock}><Ban size={20} aria-hidden="true" /><span><strong>Block contact</strong><small>They can't message or call you</small></span></button>
        <button type="button" className="safety-sheet-action danger" onClick={onReport}><Flag size={20} aria-hidden="true" /><span><strong>Report contact</strong><small>Tell Hidden Messenger about spam or abuse; they are blocked too</small></span></button>
        <button type="button" className="safety-sheet-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
