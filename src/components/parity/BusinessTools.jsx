// WhatsApp Business tools: catalog, chat labels, quick replies, and away / greeting messages.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Clock, Hand, ImagePlus, MessageSquareText, Pencil, Plus, ShoppingBag, Tag, Trash2, Zap } from 'lucide-react';
import * as api from '../../parityApi.js';
import { refreshLabels, refreshQuickReplies, useAccountData } from '../../accountData.js';
import { LABEL_PALETTE, labelColor } from '../../labels.js';
import { CatalogImage, formatPrice } from './ProductCard.jsx';
import Panel, { Notice } from './Panel.jsx';

const SECTIONS = [
  { id: 'catalog', label: 'Catalog', detail: 'Show products and services', icon: ShoppingBag },
  { id: 'labels', label: 'Labels', detail: 'Organise chats and customers', icon: Tag },
  { id: 'quick', label: 'Quick replies', detail: 'Type / in a chat to reuse messages', icon: Zap },
  { id: 'away', label: 'Away message', detail: 'Reply automatically when you’re away', icon: Clock },
  { id: 'greeting', label: 'Greeting message', detail: 'Welcome new customers', icon: Hand },
];

export default function BusinessTools({ token, userId, onClose }) {
  const [section, setSection] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  const current = SECTIONS.find((item) => item.id === section);
  const feedback = { onError: (message) => { setNotice(''); setError(message); }, onNotice: (message) => { setError(''); setNotice(message); } };
  return (
    <Panel title={current?.label ?? 'Business tools'} onClose={onClose} onBack={section ? () => { setSection(null); setError(''); } : undefined}>
      <Notice error={error} notice={notice} />
      {!section && (
        <ul className="hm-menu-list">
          {SECTIONS.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => setSection(item.id)}>
                <item.icon size={22} aria-hidden="true" />
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {section === 'catalog' && <CatalogManager token={token} userId={userId} {...feedback} />}
      {section === 'labels' && <LabelsManager token={token} {...feedback} />}
      {section === 'quick' && <QuickRepliesManager token={token} {...feedback} />}
      {(section === 'away' || section === 'greeting') && <AutoMessage kind={section} token={token} {...feedback} />}
    </Panel>
  );
}

// A picked photo shown before saving; its object URL is released when it changes or the form closes.
function PhotoPreview({ file }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url ? <img src={url} alt="" className="hm-catalog-image" /> : null;
}

const EMPTY_ITEM = { name: '', description: '', price: '', currency: 'USD', link: '', hidden: false };

function CatalogManager({ token, userId, onError, onNotice }) {
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(null);
  const fileRef = useRef(null);
  const load = useCallback(() => api.listCatalog(token, userId).then(setItems).catch((caught) => onError(caught.message)), [token, userId, onError]);
  useEffect(() => { load(); }, [load]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const body = { ...editing.form, price: editing.form.price.trim(), currency: editing.form.price.trim() ? editing.form.currency : '' };
      const saved = editing.id ? await api.updateCatalogItem(token, editing.id, body) : await api.createCatalogItem(token, body);
      if (photo) await api.uploadCatalogImage(token, saved.id, photo);
      setEditing(null);
      setPhoto(null);
      onNotice(editing.id ? 'Item updated.' : 'Item added to your catalog.');
      await load();
    } catch (caught) {
      onError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    const set = (field) => (event) => setEditing((current) => ({ ...current, form: { ...current.form, [field]: field === 'hidden' ? event.target.checked : event.target.value } }));
    return (
      <form className="hm-form" onSubmit={save}>
        <button type="button" className="hm-photo-pick" onClick={() => fileRef.current?.click()}>
          {photo ? <PhotoPreview file={photo} /> : editing.image ? <CatalogImage path={editing.image} sessionToken={token} /> : <span className="hm-catalog-image is-placeholder"><ImagePlus size={28} /></span>}
          <span>{photo || editing.image ? 'Change photo' : 'Add photo'}</span>
        </button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(event) => { const [file] = event.target.files ?? []; event.target.value = ''; if (file) setPhoto(file); }} />
        <label>Item name<input value={editing.form.name} maxLength={120} onChange={set('name')} required /></label>
        <div className="hm-inline-fields">
          <label>Price (optional)<input value={editing.form.price} inputMode="decimal" pattern="\d{1,9}(\.\d{1,2})?" onChange={set('price')} placeholder="0.00" /></label>
          <label>Currency<input value={editing.form.currency} maxLength={3} onChange={set('currency')} placeholder="USD" /></label>
        </div>
        <label>Description<textarea value={editing.form.description} maxLength={2000} rows={3} onChange={set('description')} /></label>
        <label>Link (optional)<input value={editing.form.link} type="url" maxLength={500} onChange={set('link')} placeholder="https://" /></label>
        <label className="hm-check-row"><input type="checkbox" checked={editing.form.hidden} onChange={set('hidden')} /> <span>Hide this item from customers</span></label>
        <div className="hm-row-actions">
          <button type="button" onClick={() => { setEditing(null); setPhoto(null); }}>Cancel</button>
          <button type="submit" className="groups-primary" disabled={busy || !editing.form.name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    );
  }
  return (
    <>
      <button type="button" className="groups-new" onClick={() => setEditing({ form: { ...EMPTY_ITEM } })}><span className="groups-new-icon"><Plus size={22} /></span><strong>Add new item</strong></button>
      {items === null && <p className="hm-muted hm-padded">Loading…</p>}
      {items?.length === 0 && <p className="hm-empty">Your catalog is empty. Customers see your items in your contact info, and you can share them in chats.</p>}
      <ul className="hm-catalog-list">
        {items?.map((item) => (
          <li key={item.id}>
            <CatalogImage path={item.image} sessionToken={token} alt="" className="hm-catalog-thumb" />
            <span><strong>{item.name}</strong><small>{[item.price && formatPrice(item.price, item.currency), item.hidden && 'Hidden'].filter(Boolean).join(' · ')}</small></span>
            <button type="button" className="icon-button" aria-label={`Edit ${item.name}`} onClick={() => setEditing({ id: item.id, image: item.image, form: { name: item.name, description: item.description, price: item.price, currency: item.currency || 'USD', link: item.link, hidden: item.hidden } })}><Pencil size={16} /></button>
            <button type="button" className="icon-button" aria-label={`Delete ${item.name}`} onClick={() => api.deleteCatalogItem(token, item.id).then(load).then(() => onNotice('Item deleted.')).catch((caught) => onError(caught.message))}><Trash2 size={16} /></button>
          </li>
        ))}
      </ul>
    </>
  );
}

function LabelsManager({ token, onError, onNotice }) {
  const labels = useAccountData((state) => state.labels);
  const [form, setForm] = useState(null);
  async function save(event) {
    event.preventDefault();
    try {
      if (form.id) await api.updateLabel(token, form.id, { name: form.name, color: form.color });
      else await api.createLabel(token, { name: form.name, color: form.color });
      await refreshLabels();
      setForm(null);
      onNotice('Label saved.');
    } catch (caught) {
      onError(caught.message);
    }
  }
  return (
    <>
      {form ? (
        <form className="hm-form" onSubmit={save}>
          <label>Label name<input value={form.name} maxLength={40} onChange={(event) => setForm({ ...form, name: event.target.value })} required autoFocus /></label>
          <fieldset className="hm-color-grid"><legend>Colour</legend>
            {LABEL_PALETTE.map((color, index) => (
              <button type="button" key={color} className={form.color === index ? 'is-active' : ''} style={{ background: color }} aria-label={`Colour ${index + 1}`} aria-pressed={form.color === index} onClick={() => setForm({ ...form, color: index })} />
            ))}
          </fieldset>
          <div className="hm-row-actions"><button type="button" onClick={() => setForm(null)}>Cancel</button><button type="submit" className="groups-primary" disabled={!form.name.trim()}>Save</button></div>
        </form>
      ) : <button type="button" className="groups-new" onClick={() => setForm({ name: '', color: labels.length % LABEL_PALETTE.length })}><span className="groups-new-icon"><Plus size={22} /></span><strong>New label</strong></button>}
      {labels.length === 0 && !form && <p className="hm-empty">Use labels to find chats and customers quickly. Long-press a chat to label it.</p>}
      <ul className="hm-catalog-list">
        {labels.map((label) => (
          <li key={label.id}>
            <Tag size={22} style={{ color: labelColor(label.color) }} aria-hidden="true" />
            <span><strong>{label.name}</strong><small>{label.chatKeys.length} {label.chatKeys.length === 1 ? 'chat' : 'chats'}</small></span>
            <button type="button" className="icon-button" aria-label={`Edit ${label.name}`} onClick={() => setForm({ id: label.id, name: label.name, color: label.color })}><Pencil size={16} /></button>
            <button type="button" className="icon-button" aria-label={`Delete ${label.name}`} onClick={() => api.deleteLabel(token, label.id).then(refreshLabels).then(() => onNotice('Label deleted.')).catch((caught) => onError(caught.message))}><Trash2 size={16} /></button>
          </li>
        ))}
      </ul>
    </>
  );
}

function QuickRepliesManager({ token, onError, onNotice }) {
  const replies = useAccountData((state) => state.quickReplies);
  const [form, setForm] = useState(null);
  async function save(event) {
    event.preventDefault();
    try {
      if (form.id) await api.updateQuickReply(token, form.id, { shortcut: form.shortcut, text: form.text });
      else await api.createQuickReply(token, { shortcut: form.shortcut, text: form.text });
      await refreshQuickReplies();
      setForm(null);
      onNotice('Quick reply saved.');
    } catch (caught) {
      onError(caught.message);
    }
  }
  return (
    <>
      {form ? (
        <form className="hm-form" onSubmit={save}>
          <label>Message<textarea value={form.text} maxLength={1000} rows={4} onChange={(event) => setForm({ ...form, text: event.target.value })} required autoFocus /></label>
          <label>Shortcut<span className="hm-prefixed"><span aria-hidden="true">/</span><input value={form.shortcut} maxLength={25} pattern="[a-z0-9_]{1,25}" onChange={(event) => setForm({ ...form, shortcut: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} required /></span></label>
          <p className="hm-muted">Type “/{form.shortcut || 'shortcut'}” in any chat to send this message.</p>
          <div className="hm-row-actions"><button type="button" onClick={() => setForm(null)}>Cancel</button><button type="submit" className="groups-primary" disabled={!form.text.trim() || !form.shortcut}>Save</button></div>
        </form>
      ) : <button type="button" className="groups-new" onClick={() => setForm({ shortcut: '', text: '' })}><span className="groups-new-icon"><Plus size={22} /></span><strong>New quick reply</strong></button>}
      {replies.length === 0 && !form && <p className="hm-empty">Save messages you send often, then type / in a chat to use them.</p>}
      <ul className="hm-catalog-list">
        {replies.map((reply) => (
          <li key={reply.id}>
            <MessageSquareText size={22} aria-hidden="true" />
            <span><strong>/{reply.shortcut}</strong><small>{reply.text}</small></span>
            <button type="button" className="icon-button" aria-label={`Edit /${reply.shortcut}`} onClick={() => setForm({ ...reply })}><Pencil size={16} /></button>
            <button type="button" className="icon-button" aria-label={`Delete /${reply.shortcut}`} onClick={() => api.deleteQuickReply(token, reply.id).then(refreshQuickReplies).then(() => onNotice('Quick reply deleted.')).catch((caught) => onError(caught.message))}><Trash2 size={16} /></button>
          </li>
        ))}
      </ul>
    </>
  );
}

function AutoMessage({ kind, token, onError, onNotice }) {
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getBusinessProfile(token).then(setProfile).catch((caught) => onError(caught.message)); }, [token, onError]);
  if (!profile) return <p className="hm-muted hm-padded">Loading…</p>;
  const value = profile[kind];
  const update = (patch) => setProfile({ ...profile, [kind]: { ...value, ...patch } });
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      setProfile(await api.saveBusinessProfile(token, { [kind]: value }));
      onNotice(value.enabled ? `${kind === 'away' ? 'Away' : 'Greeting'} message is on.` : 'Saved.');
    } catch (caught) {
      onError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="hm-form" onSubmit={save}>
      <label className="hm-switch-row">
        <span><strong>Send {kind === 'away' ? 'away' : 'greeting'} message</strong>
          <small>{kind === 'away' ? 'At most once a day to each person who messages you.' : 'To people messaging you for the first time, or after 14 days without messages.'}</small></span>
        <input type="checkbox" className="groups-switch-input" checked={value.enabled} onChange={(event) => update({ enabled: event.target.checked })} aria-label={`Send ${kind} message`} />
      </label>
      <label>Message<textarea value={value.text} maxLength={1000} rows={4} onChange={(event) => update({ text: event.target.value })} placeholder={kind === 'away' ? 'Thank you for your message. We’re unavailable right now, but will respond as soon as possible.' : 'Thank you for contacting us. How can we help?'} /></label>
      {kind === 'away' && (
        <fieldset className="hm-radio-list"><legend>Schedule</legend>
          <label><input type="radio" name="away-schedule" checked={value.schedule === 'always'} onChange={() => update({ schedule: 'always' })} /> Always send</label>
          <label><input type="radio" name="away-schedule" checked={value.schedule === 'offline'} onChange={() => update({ schedule: 'offline' })} /> Only when I’m offline (no Hidden Messenger app open)</label>
        </fieldset>
      )}
      {kind === 'away' && <BusinessHoursEditor hours={value.hours ?? null} onChange={(hours) => update({ hours })} />}
      <button type="submit" className="groups-primary" disabled={busy || (value.enabled && !value.text.trim())}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}

// Opening hours for the away message (sent only outside them), in this device's time zone.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toTime = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const fromTime = (text) => { const [hours, minutes] = String(text).split(':').map(Number); return hours * 60 + minutes; };
function BusinessHoursEditor({ hours, onChange }) {
  const timeZone = hours?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const days = hours?.days ?? {};
  const set = (nextDays) => onChange({ timeZone, days: nextDays });
  return (
    <fieldset className="hm-radio-list hm-hours"><legend>Business hours</legend>
      <label className="hm-switch-row"><span><strong>Only outside business hours</strong><small>The away message goes out only when you’re closed ({timeZone}).</small></span>
        <input type="checkbox" className="groups-switch-input" checked={Boolean(hours)} onChange={(event) => onChange(event.target.checked ? { timeZone, days: { 1: [540, 1020], 2: [540, 1020], 3: [540, 1020], 4: [540, 1020], 5: [540, 1020] } } : null)} aria-label="Only outside business hours" /></label>
      {hours && DAY_NAMES.map((name, index) => {
        const range = days[index];
        return (
          <div key={name} className="hm-hours-row">
            <label><input type="checkbox" checked={Boolean(range)} onChange={(event) => { const next = { ...days }; if (event.target.checked) next[index] = [540, 1020]; else delete next[index]; set(next); }} /> {name}</label>
            {range ? (
              <span>
                <input type="time" value={toTime(range[0])} onChange={(event) => set({ ...days, [index]: [fromTime(event.target.value), range[1]] })} aria-label={`${name} opens`} />
                –
                <input type="time" value={toTime(range[1])} onChange={(event) => set({ ...days, [index]: [range[0], fromTime(event.target.value)] })} aria-label={`${name} closes`} />
              </span>
            ) : <small>Closed</small>}
          </div>
        );
      })}
    </fieldset>
  );
}
