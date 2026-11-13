// Business tools, laid out like a business messenger's: manage the business (profile, catalog, hours, labels)
// and messaging tools (greeting, away, quick replies). Profile, hours and auto-replies share /api/v1/business.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AtSign, CalendarClock, ChevronRight, CircleHelp, Clock, Copy, FileText, FolderOpen, Globe, Hand, ImagePlus, Link2, ListChecks, Mail, MapPin, Megaphone, MessageSquareText, Pencil, Phone, Plus, QrCode, Share2, ShoppingBag, Store, Tag, Trash2, X, Zap } from 'lucide-react';
import ProfilePhoto from '../ProfilePhoto.jsx';
import { DisplayNameEditor } from '../ToolsView.jsx';
import { QRCodeSVG } from 'qrcode.react';
import { useChatStore } from '../../store.js';
import { apiFetch } from '../../api.js';
import * as api from '../../parityApi.js';
import { refreshLabels, refreshQuickReplies, useAccountData } from '../../accountData.js';
import { LABEL_PALETTE, labelColor } from '../../labels.js';
import { CatalogImage, formatPrice } from './ProductCard.jsx';
import Panel, { Notice } from './Panel.jsx';
import TabMenu from '../TabMenu.jsx';

// Grouped the way a business messenger's Tools tab is: grow the business, organise chats, manage the account.
// `sheet` opens an app-wide sheet; `target` opens another section; `hidden` sections open from elsewhere (Profile).
const GROUPS = [
  ['Grow your business', [
    { id: 'catalog', label: 'Catalogue', detail: 'Show products and services', icon: ShoppingBag },
    { id: 'broadcasts', label: 'Broadcast lists', detail: 'One message to many customers', icon: Megaphone, sheet: 'broadcasts' },
    { id: 'link', label: 'Short link', detail: 'A link and QR code that open a chat with you', icon: QrCode },
  ]],
  ['Organise your chats', [
    { id: 'lists', label: 'Lists', detail: 'Manage people and groups', icon: ListChecks, sheet: 'lists' },
    { id: 'labels', label: 'Labels', detail: 'Organise chats and customers', icon: Tag },
    { id: 'greeting', label: 'Greeting message', detail: 'Welcome new customers automatically', icon: Hand },
    { id: 'away', label: 'Away message', detail: 'Reply automatically when you’re away', icon: Clock },
    { id: 'quick', label: 'Quick replies', detail: 'Reuse frequent messages', icon: Zap },
  ]],
  ['Manage your account', [
    { id: 'profile', label: 'Profile', detail: 'Manage address, hours and websites', icon: Store },
    { id: 'social', label: 'Instagram & Facebook', detail: 'Show your pages on your profile', icon: AtSign, target: 'profile' },
    { id: 'hours', label: 'Business hours', detail: 'When you’re open, shown on your profile', icon: CalendarClock, hidden: true },
    { id: 'help', label: 'Help Centre', detail: 'Get help, contact us', icon: CircleHelp, sheet: 'help' },
  ]],
];
export const BUSINESS_SECTIONS = GROUPS.flatMap(([, items]) => items).filter((item) => !item.sheet && !item.target);

// inline: the Tools tab (the menu sits in the tab; each tool opens full screen over it).
export default function BusinessTools({ token, userId, onClose, onSheet, onSettings, initialSection = null, inline = false }) {
  const [section, setSection] = useState(initialSection);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  const current = BUSINESS_SECTIONS.find((item) => item.id === section);
  const title = section === 'profile' ? 'Edit profile' : current?.label;
  const feedback = { onError: (message) => { setNotice(''); setError(message); }, onNotice: (message) => { setError(''); setNotice(message); } };
  return (
    <Panel inline={inline && !section} title={title ?? (inline ? 'Tools' : 'Business tools')} onClose={onClose} onBack={section && !initialSection ? () => { setSection(null); setError(''); } : undefined}
      actions={inline && !section ? <TabMenu items={[{ label: 'Short link', onClick: () => setSection('link') }, { label: 'Verified', onClick: () => onSheet?.('verified') }, { label: 'Settings', onClick: () => onSettings?.() }]} /> : null}>
      <Notice error={error} notice={notice} />
      {!section && GROUPS.map(([title, items]) => (
        <section key={title} className="hm-menu-group">
          <h3 className="hm-section">{title}</h3>
          <ul className="hm-menu-list">
            {items.filter((item) => !item.hidden).map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => (item.sheet ? onSheet?.(item.sheet) : setSection(item.target ?? item.id))}>
                  <item.icon size={22} aria-hidden="true" />
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {section === 'profile' && <BusinessProfileForm token={token} userId={userId} onOpenSection={setSection} {...feedback} />}
      {section === 'hours' && <BusinessHoursForm token={token} {...feedback} />}
      {section === 'link' && <ShortLink {...feedback} />}
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
      {items?.length > 0 && <CollectionsManager token={token} userId={userId} items={items} onError={onError} onNotice={onNotice} />}
    </>
  );
}

// Collections ("Cakes", "Bread"…): named groups of catalog items, shown to customers as sections of the catalog.
function CollectionsManager({ token, userId, items, onError, onNotice }) {
  const [collections, setCollections] = useState(null);
  const [form, setForm] = useState(null);
  const load = useCallback(() => api.listCollections(token, userId).then(setCollections).catch((caught) => onError(caught.message)), [token, userId, onError]);
  useEffect(() => { load(); }, [load]);
  async function save(event) {
    event.preventDefault();
    try {
      if (form.id) await api.updateCollection(token, form.id, { name: form.name, itemIds: form.itemIds });
      else await api.createCollection(token, { name: form.name, itemIds: form.itemIds });
      setForm(null);
      await load();
      onNotice('Collection saved.');
    } catch (caught) {
      onError(caught.message);
    }
  }
  const toggle = (id) => setForm((current) => ({ ...current, itemIds: current.itemIds.includes(id) ? current.itemIds.filter((item) => item !== id) : [...current.itemIds, id] }));
  if (form) {
    return (
      <form className="hm-form hm-collection-form" onSubmit={save}>
        <h3 className="hm-section">{form.id ? 'Edit collection' : 'New collection'}</h3>
        <label>Collection name<input value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="For example Cakes or New arrivals" autoFocus /></label>
        <ul className="chat-list-picker">
          {items.map((item) => (
            <li key={item.id}><label><input type="checkbox" checked={form.itemIds.includes(item.id)} onChange={() => toggle(item.id)} /><span>{item.name}</span></label></li>
          ))}
        </ul>
        <div className="hm-row-actions">
          <button type="button" onClick={() => setForm(null)}>Cancel</button>
          <button type="submit" className="groups-primary" disabled={!form.name.trim()}>Save</button>
        </div>
      </form>
    );
  }
  return (
    <section className="hm-collections">
      <h3 className="hm-section">Collections</h3>
      <button type="button" className="groups-new" onClick={() => setForm({ name: '', itemIds: [] })}><span className="groups-new-icon"><FolderOpen size={20} /></span><strong>Add collection</strong></button>
      <ul className="hm-catalog-list">
        {collections?.map((collection) => (
          <li key={collection.id}>
            <span className="hm-catalog-thumb hm-collection-icon" aria-hidden="true"><FolderOpen size={20} /></span>
            <span><strong>{collection.name}</strong><small>{collection.itemIds.length} item{collection.itemIds.length === 1 ? '' : 's'}</small></span>
            <button type="button" className="icon-button" aria-label={`Edit ${collection.name}`} onClick={() => setForm({ id: collection.id, name: collection.name, itemIds: collection.itemIds })}><Pencil size={16} /></button>
            <button type="button" className="icon-button" aria-label={`Delete ${collection.name}`} onClick={() => api.deleteCollection(token, collection.id).then(load).then(() => onNotice('Collection deleted.')).catch((caught) => onError(caught.message))}><Trash2 size={16} /></button>
          </li>
        ))}
      </ul>
      {collections?.length === 0 && <p className="hm-muted">Group items into collections such as Cakes or New arrivals. Customers see them as sections of your catalog.</p>}
    </section>
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
          <label><input type="radio" name="away-schedule" checked={value.schedule === 'custom'} onChange={() => update({ schedule: 'custom', from: value.from ?? Date.now(), until: value.until ?? Date.now() + 7 * 24 * 60 * 60 * 1000 })} /> Custom schedule (for example a holiday)</label>
          {value.schedule === 'custom' && (
            <div className="hm-away-range">
              <label>Starts<input type="datetime-local" value={localDateTime(value.from)} onChange={(event) => update({ from: new Date(event.target.value).getTime() })} /></label>
              <label>Ends<input type="datetime-local" value={localDateTime(value.until)} onChange={(event) => update({ until: new Date(event.target.value).getTime() })} /></label>
            </div>
          )}
        </fieldset>
      )}
      {kind === 'away' && (
        <p className="hm-muted">{value.hours
          ? `Sent only outside your business hours (${hoursSummary(value.hours)}). Change them in Business tools › Business hours.`
          : 'No business hours set, so it follows the schedule above. Set them in Business tools › Business hours to send it only when you’re closed.'}</p>
      )}
      <button type="submit" className="groups-primary" disabled={busy || (value.enabled && !value.text.trim())}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}

const localDateTime = (ms) => (Number.isFinite(ms) ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

// Opening hours: shown to customers, and the away message goes out only outside them. Set in this device's time zone.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toTime = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const fromTime = (text) => { const [hours, minutes] = String(text).split(':').map(Number); return hours * 60 + minutes; };
function BusinessHoursEditor({ hours, onChange }) {
  const timeZone = hours?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const days = hours?.days ?? {};
  const set = (nextDays) => onChange({ timeZone, days: nextDays });
  return (
    <fieldset className="hm-radio-list hm-hours"><legend>Business hours</legend>
      <label className="hm-switch-row"><span><strong>Set business hours</strong><small>Shown on your profile ({timeZone}). Your away message, when on, goes out only when you’re closed.</small></span>
        <input type="checkbox" className="groups-switch-input" checked={Boolean(hours)} onChange={(event) => onChange(event.target.checked ? { timeZone, days: { 1: [540, 1020], 2: [540, 1020], 3: [540, 1020], 4: [540, 1020], 5: [540, 1020] } } : null)} aria-label="Set business hours" /></label>
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

/** "Mon–Fri 09:00–17:00, Sat 10:00–14:00" style summary of business hours. */
export function hoursSummary(hours) {
  if (!hours) return '';
  const order = [1, 2, 3, 4, 5, 6, 0];
  const short = (index) => DAY_NAMES[index].slice(0, 3);
  const runs = [];
  for (const day of order) {
    const range = hours.days?.[day];
    if (!range) continue;
    const key = range.join('-');
    const last = runs.at(-1);
    if (last && last.key === key && order.indexOf(day) === order.indexOf(last.end) + 1) last.end = day;
    else runs.push({ key, start: day, end: day, range });
  }
  if (!runs.length) return 'Closed every day';
  return runs.map((run) => `${short(run.start)}${run.end !== run.start ? `–${short(run.end)}` : ''} ${toTime(run.range[0])}–${toTime(run.range[1])}`).join(', ');
}

/** Whether the business is open now, in its own time zone (null when it has no hours). */
export function openNow(hours, at = new Date()) {
  if (!hours) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: hours.timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(at).map((part) => [part.type, part.value]));
  const range = hours.days?.[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)];
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return Boolean(range && minute >= range[0] && minute < range[1]);
}

export const BUSINESS_CATEGORIES = ['Shopping & retail', 'Food & grocery', 'Restaurant', 'Bakery', 'Clothing & apparel', 'Beauty, cosmetic & personal care',
  'Health & medical', 'Education', 'Professional services', 'Automotive service', 'Travel & transportation', 'Hotel & lodging',
  'Event planning & service', 'Finance', 'Public service', 'Entertainment', 'Non-profit organisation', 'Other business'];

function useBusinessSettings(token, onError) {
  const [settings, setSettings] = useState(null);
  useEffect(() => { api.getBusinessProfile(token).then(setSettings).catch((caught) => onError(caught.message)); }, [token, onError]);
  return [settings, setSettings];
}

// Edit profile, laid out like a business messenger's: cover photo with the round profile photo over it (tap to
// change), the business name, then rows grouped as Business information, Products and services, Links and Contact
// information. Tap a row to edit it; Save stores the whole profile.
function ProfileRow({ icon: Icon, label, value, placeholder, editing, onEdit, onOpen, children }) {
  if (editing) {
    return (
      <div className="bp-row is-editing">
        <Icon size={22} aria-hidden="true" />
        <label className="bp-row-edit"><small>{label}</small>{children}</label>
      </div>
    );
  }
  return (
    <button type="button" className="bp-row" onClick={onOpen ?? onEdit}>
      <Icon size={22} aria-hidden="true" />
      <span className="bp-row-copy">
        {value ? <><strong>{value}</strong><small>{label}</small></> : <strong className="bp-row-placeholder">{placeholder ?? label}</strong>}
      </span>
      {onOpen ? <ChevronRight size={18} aria-hidden="true" /> : <Pencil size={16} aria-hidden="true" className="bp-row-pencil" />}
    </button>
  );
}

function BusinessProfileForm({ token, userId, onOpenSection, onError, onNotice }) {
  const [settings, setSettings] = useBusinessSettings(token, onError);
  const user = useChatStore((state) => state.user);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState('');
  if (!settings) return <p className="hm-muted hm-padded">Loading…</p>;
  const profile = settings.profile;
  const update = (patch) => setSettings({ ...settings, profile: { ...profile, ...patch } });
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const { cover: _cover, ...editable } = profile;
      setSettings(await api.saveBusinessProfile(token, { profile: { ...editable, links: (editable.links ?? []).filter((link) => link.url.trim()) } }));
      setEditing('');
      onNotice('Business profile saved.');
    } catch (caught) {
      onError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  const row = (field, props, input) => (
    <ProfileRow {...props} editing={editing === field} onEdit={() => setEditing(field)}>{input}</ProfileRow>
  );
  const text = (field, { max, ...rest } = {}) => (
    <input value={profile[field] ?? ''} maxLength={max} autoFocus onChange={(event) => update({ [field]: event.target.value })} {...rest} />
  );
  return (
    <form className="hm-form bp-edit" onSubmit={save}>
      <div className="bp-hero">
        <CoverPicker token={token} cover={profile.cover} onChanged={(next) => { setSettings(next); onNotice('Cover photo updated.'); }} onError={onError} />
        <div className="bp-photo"><ProfilePhoto size="large" /></div>
        <div className="bp-name"><DisplayNameEditor user={user} userId={userId} /></div>
      </div>

      <h4 className="hm-form-section">Business information</h4>
      {row('category', { icon: Store, label: 'Category', value: profile.category, placeholder: 'Choose a category' }, <>
        {text('category', { max: 60, list: 'business-categories', placeholder: 'Choose or type a category' })}
        <datalist id="business-categories">{BUSINESS_CATEGORIES.map((name) => <option key={name} value={name} />)}</datalist>
      </>)}
      <ProfileRow icon={CalendarClock} label="Business hours" value={settings.away.hours ? hoursSummary(settings.away.hours) : ''} placeholder="Add business hours" onOpen={() => onOpenSection?.('hours')} />
      {row('description', { icon: FileText, label: 'Description', value: profile.description, placeholder: 'Add a description' },
        <textarea value={profile.description} maxLength={512} rows={3} autoFocus onChange={(event) => update({ description: event.target.value })} placeholder="What your business does" />)}
      {row('address', { icon: MapPin, label: 'Address', value: profile.address, placeholder: 'Add an address' }, text('address', { max: 256, placeholder: 'Street, city', autoComplete: 'street-address' }))}

      <h4 className="hm-form-section">Products and services</h4>
      <ProfileRow icon={ShoppingBag} label="Show products and services" value="Catalogue" onOpen={() => onOpenSection?.('catalog')} />

      <h4 className="hm-form-section">Links</h4>
      {row('website', { icon: Globe, label: 'Website', value: profile.website?.replace(/^https?:\/\//, '').replace(/\/$/, ''), placeholder: 'Add website' },
        text('website', { max: 256, placeholder: 'example.com', inputMode: 'url', autoComplete: 'url' }))}
      {SOCIAL_LINKS.map((social) => row(social.label, { icon: AtSign, label: social.label, value: socialHandle(profile.links, social) && `${social.host}/${socialHandle(profile.links, social)}`, placeholder: `Add ${social.label}` },
        <span className="hm-prefixed"><span aria-hidden="true">{social.host}/</span>
          <input value={socialHandle(profile.links, social)} maxLength={80} placeholder="yourbusiness" autoCapitalize="none" inputMode="url" autoFocus
            onChange={(event) => update({ links: withSocial(profile.links, social, event.target.value) })} /></span>))}
      <fieldset className="hm-radio-list hm-links"><legend>Other links</legend>
        {(profile.links ?? []).map((link, index) => (isSocial(link) ? null : (
          <div key={index} className="hm-link-row">
            <input value={link.label} maxLength={40} placeholder="Label (Shop, Menu…)" aria-label={`Link ${index + 1} label`} onChange={(event) => update({ links: profile.links.map((item, at) => (at === index ? { ...item, label: event.target.value } : item)) })} />
            <input value={link.url} maxLength={256} placeholder="example.com/shop" inputMode="url" aria-label={`Link ${index + 1} address`} onChange={(event) => update({ links: profile.links.map((item, at) => (at === index ? { ...item, url: event.target.value } : item)) })} />
            <button type="button" className="icon-button" aria-label={`Remove link ${index + 1}`} onClick={() => update({ links: profile.links.filter((_, at) => at !== index) })}><X size={16} /></button>
          </div>
        )))}
        {(profile.links ?? []).length < MAX_LINKS && <button type="button" className="groups-secondary" onClick={() => update({ links: [...(profile.links ?? []), { label: '', url: '' }] })}><Link2 size={16} /> Add link</button>}
      </fieldset>

      <h4 className="hm-form-section">Contact information</h4>
      {row('email', { icon: Mail, label: 'Business email', value: profile.email, placeholder: 'Add business email' }, text('email', { max: 128, type: 'email', placeholder: 'name@example.com', autoComplete: 'email' }))}
      {row('phone', { icon: Phone, label: 'Phone', value: profile.phone, placeholder: 'Add a contact number' }, text('phone', { max: 32, type: 'tel', placeholder: '+880 1712 345678', autoComplete: 'tel' }))}
      <p className="hm-muted">People who chat with you see this in your contact info.</p>
      <button type="submit" className="groups-primary bp-save" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}
const MAX_LINKS = 4;

// Instagram and Facebook: typed as a handle (or pasted as a full address), stored as { label, url } links.
export const SOCIAL_LINKS = [{ label: 'Instagram', host: 'instagram.com' }, { label: 'Facebook', host: 'facebook.com' }];
const isSocial = (link) => SOCIAL_LINKS.some((social) => social.label === link?.label);
export function socialHandle(links = [], social) {
  const url = links.find((link) => link.label === social.label)?.url ?? '';
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(new RegExp(`^${social.host.replace('.', '\\.')}/?`, 'i'), '').replace(/\/$/, '');
}
export function withSocial(links = [], social, value) {
  const others = links.filter((link) => link.label !== social.label);
  const handle = value.trim().replace(/^@/, '');
  if (!handle) return others;
  const url = /\./.test(handle) && /\//.test(handle) ? handle : `https://${social.host}/${handle}`;
  const socials = [...others.filter(isSocial), { label: social.label, url }].sort((a, b) => SOCIAL_LINKS.findIndex((x) => x.label === a.label) - SOCIAL_LINKS.findIndex((x) => x.label === b.label));
  return [...socials, ...others.filter((link) => !isSocial(link))].slice(0, MAX_LINKS);
}

// The cover photo across the top of the business profile (shown to customers in contact info).
export function BusinessCover({ path, token, className = 'hm-business-cover' }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!path || !token) { setUrl(''); return undefined; }
    let objectUrl = '';
    let cancelled = false;
    apiFetch(path, { headers: { Authorization: `Bearer ${token}` } }).then((response) => (response.ok ? response.blob() : null)).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, token]);
  return url ? <img className={className} src={url} alt="" /> : null;
}

function CoverPicker({ token, cover, onChanged, onError }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  async function upload(file) {
    setBusy(true);
    try { onChanged(await api.uploadBusinessCover(token, file)); } catch (caught) { onError(caught.message); } finally { setBusy(false); }
  }
  return (
    <div className="hm-cover-picker">
      {cover ? <BusinessCover path={cover} token={token} /> : <div className="hm-business-cover is-empty" aria-hidden="true"><ImagePlus size={28} /></div>}
      <div className="hm-row-actions">
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}><ImagePlus size={16} /> {cover ? 'Change cover photo' : 'Add cover photo'}</button>
        {cover && <button type="button" onClick={() => api.removeBusinessCover(token).then(onChanged).catch((caught) => onError(caught.message))} disabled={busy}><Trash2 size={16} /> Remove</button>}
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(event) => { const [file] = event.target.files ?? []; event.target.value = ''; if (file) upload(file); }} />
    </div>
  );
}

// Short link and QR code: anyone who opens it lands in a chat with you, optionally with a message typed for them.
export const shortLinkFor = (username, message = '') => `https://hiddenmessenger.com/u/${encodeURIComponent(username)}${message.trim() ? `?text=${encodeURIComponent(message.trim())}` : ''}`;
function ShortLink({ onError, onNotice }) {
  const username = useChatStore((state) => state.user?.username ?? '');
  const [message, setMessage] = useState('');
  const link = shortLinkFor(username, message);
  async function copy() {
    try { await navigator.clipboard.writeText(link); onNotice('Link copied.'); } catch { onError('Copying isn’t allowed here. Select the link and copy it.'); }
  }
  async function share() {
    try { if (navigator.share) await navigator.share({ title: 'Chat with me on Hidden Messenger', url: link }); else await copy(); } catch (caught) { if (caught?.name !== 'AbortError') onError('Sharing isn’t available here.'); }
  }
  return (
    <div className="hm-form hm-short-link">
      <p className="hm-muted">Customers who open this link or scan the code go straight to a chat with you.</p>
      <div className="hm-qr"><QRCodeSVG value={link} size={196} level="M" bgColor="#ffffff" fgColor="#0b1628" includeMargin aria-label="QR code for your short link" /></div>
      <p className="hm-short-url" aria-label="Your short link">{link}</p>
      <label>Message filled in for them (optional)<input value={message} maxLength={200} onChange={(event) => setMessage(event.target.value)} placeholder="Hi! I'd like to order…" /></label>
      <div className="hm-row-actions">
        <button type="button" onClick={copy}><Copy size={16} /> Copy link</button>
        <button type="button" className="groups-primary" onClick={share}><Share2 size={16} /> Share</button>
      </div>
    </div>
  );
}

function BusinessHoursForm({ token, onError, onNotice }) {
  const [settings, setSettings] = useBusinessSettings(token, onError);
  const [busy, setBusy] = useState(false);
  if (!settings) return <p className="hm-muted hm-padded">Loading…</p>;
  const hours = settings.away.hours ?? null;
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      setSettings(await api.saveBusinessProfile(token, { away: { hours } }));
      onNotice(hours ? 'Business hours saved.' : 'Business hours removed.');
    } catch (caught) {
      onError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="hm-form" onSubmit={save}>
      <BusinessHoursEditor hours={hours} onChange={(next) => setSettings({ ...settings, away: { ...settings.away, hours: next } })} />
      <button type="submit" className="groups-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}
