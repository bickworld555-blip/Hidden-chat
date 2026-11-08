import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bell, Minus, Plus, Volume2 } from 'lucide-react';
import {
  LIGHT_OPTIONS,
  VIBRATE_OPTIONS,
  setSectionValue,
  updateNotificationSettings,
  useNotificationSettings,
} from '../notificationSettings.js';
import { defaultToneId, isCustomChoice, libraryTone, toneChoiceLabel, toneLibrary } from '../tones.js';
import { addCustomTone, getCustomTones, playToneChoice, removeCustomTone, stopTone } from '../sounds.js';
import { notificationPermission, requestNotificationPermission, vibrateFor } from '../notify.js';

const RINGTONE_PREVIEW_MS = 4500;

function Switch({ checked }) {
  return <span className={`wa-switch${checked ? ' on' : ''}`} aria-hidden="true"><span /></span>;
}

function Row({ title, subtitle, onClick, disabled, children }) {
  return (
    <button type="button" className={`wa-info-row notif-row${disabled ? ' is-disabled' : ''}`} onClick={onClick} disabled={disabled} aria-disabled={disabled || undefined}>
      <span className="wa-info-row-text">
        <span>{title}</span>
        {subtitle && <small>{subtitle}</small>}
      </span>
      {children}
    </button>
  );
}

function ToggleRow({ title, subtitle, checked, onChange }) {
  return (
    <Row title={title} subtitle={subtitle} onClick={() => onChange(!checked)}>
      <span role="switch" aria-checked={checked} aria-label={title}><Switch checked={checked} /></span>
    </Row>
  );
}

function SubView({ title, onBack, children }) {
  return (
    <div className="wa-info-subview">
      <header className="wa-info-header">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeft size={20} /></button>
        <h2>{title}</h2>
      </header>
      <div className="wa-info-scroll">{children}</div>
    </div>
  );
}

function RadioList({ title, options, value, onChange, onBack, render = (option) => option.label }) {
  return (
    <SubView title={title} onBack={onBack}>
      <section className="wa-info-section">
        {options.map((option) => (
          <label key={option.id} className="wa-info-radio">
            <input type="radio" name={title} checked={value === option.id} onChange={() => onChange(option.id)} />
            <span>{render(option)}</span>
          </label>
        ))}
      </section>
    </SubView>
  );
}

// Default / Silent, uploaded files, then the built-in library; choosing anything previews it.
function TonePicker({ title, kind, value, volume, onChange, onVolume, onBack }) {
  const [custom, setCustom] = useState([]);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const previewKey = `preview:${kind}`;
  const defaultTone = libraryTone(kind, defaultToneId(kind));

  useEffect(() => {
    let mounted = true;
    getCustomTones().then((list) => { if (mounted) setCustom(list.filter((tone) => tone.kind === kind)); });
    return () => { mounted = false; stopTone(previewKey); };
  }, [kind, previewKey]);

  function choose(choice) {
    onChange(choice);
    stopTone(previewKey);
    if (choice === 'silent') return;
    playToneChoice(choice, kind, { loop: kind === 'ringtone', volume, key: previewKey });
    if (kind === 'ringtone') window.setTimeout(() => stopTone(previewKey), RINGTONE_PREVIEW_MS);
  }

  async function addFile(event) {
    const [file] = event.target.files ?? [];
    event.target.value = '';
    if (!file) return;
    setError('');
    try {
      const tone = await addCustomTone(file, kind);
      setCustom((list) => [...list, tone]);
      choose(`custom:${tone.id}`);
    } catch (caught) {
      setError(caught?.message || 'Could not add this sound.');
    }
  }

  async function remove(tone) {
    stopTone(previewKey);
    await removeCustomTone(tone.id);
    setCustom((list) => list.filter((item) => item.id !== tone.id));
    if (value === `custom:${tone.id}`) onChange('default');
  }

  const option = (id, label, subtitle, extra) => (
    <label key={id} className={`wa-info-radio notif-tone${value === id ? ' is-selected' : ''}`}>
      <input type="radio" name={title} checked={value === id} onChange={() => choose(id)} />
      <span className="notif-tone-text">
        <span>{label}</span>
        {subtitle && <small>{subtitle}</small>}
      </span>
      {extra}
    </label>
  );

  return (
    <SubView title={title} onBack={onBack}>
      <section className="wa-info-section notif-card">
        {option('default', kind === 'ringtone' ? 'Default ringtone' : 'Default notification sound', defaultTone.name)}
        {option('silent', 'Silent')}
      </section>
      <section className="wa-info-section notif-card">
        <h3>Custom</h3>
        {custom.map((tone) => option(`custom:${tone.id}`, tone.name, null, (
          <button type="button" className="notif-remove" onClick={(event) => { event.preventDefault(); remove(tone); }} aria-label={`Remove ${tone.name}`}><Minus size={18} /></button>
        )))}
        <button type="button" className="wa-info-row notif-add" onClick={() => fileRef.current?.click()}>
          <Plus size={20} className="wa-info-row-icon" aria-hidden="true" />
          <span className="wa-info-row-text"><span>Add from device</span><small>MP3, WAV, OGG or M4A up to 10 MB</small></span>
        </button>
        <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a" hidden onChange={addFile} />
        {error && <p className="notif-error" role="alert">{error}</p>}
      </section>
      <section className="wa-info-section notif-card">
        <h3>Hidden Messenger</h3>
        {toneLibrary(kind).map((tone) => option(tone.id, tone.name))}
      </section>
      <div className="notif-volume" role="group" aria-label="Preview volume">
        <Volume2 size={20} aria-hidden="true" />
        <input type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => onVolume(Number(event.target.value))} aria-label="Volume" />
      </div>
    </SubView>
  );
}

export default function NotificationSettings({ onClose }) {
  const settings = useNotificationSettings();
  const [view, setView] = useState(null);
  const [custom, setCustom] = useState([]);
  const [permission, setPermission] = useState(() => notificationPermission());

  useEffect(() => {
    let mounted = true;
    getCustomTones().then((list) => { if (mounted) setCustom(list); });
    return () => { mounted = false; };
  }, [view]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      if (view) setView(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, onClose]);

  async function setHighPriority(section, enabled) {
    setSectionValue(section, 'highPriority', enabled);
    if (enabled) setPermission(await requestNotificationPermission());
  }

  const toneLabel = (choice, kind) => toneChoiceLabel(choice, kind, custom);
  const vibrateLabel = (id) => VIBRATE_OPTIONS.find((option) => option.id === id)?.label ?? 'Default';
  const lightLabel = (id) => LIGHT_OPTIONS.find((option) => option.id === id)?.label ?? 'White';
  const permissionNote = permission === 'denied'
    ? 'Notifications are blocked for this site in your browser settings.'
    : permission === 'unsupported' ? 'This browser cannot show system notifications.' : null;

  function sectionRows(section, { tones = true, light = true, reactionsLabel = 'Reaction notifications', reactionsText = 'Show notifications for reactions to messages you send' } = {}) {
    const values = settings[section];
    return (
      <>
        {tones && <Row title="Notification tone" subtitle={toneLabel(values.tone, 'notification')} onClick={() => setView({ type: 'tone', section, key: 'tone', kind: 'notification', title: 'Notification tone' })} />}
        <Row title="Vibrate" subtitle={vibrateLabel(values.vibrate)} onClick={() => setView({ type: 'vibrate', section })} />
        {section === 'messages' && <Row title="Popup notification" subtitle="Not available" disabled />}
        {light && <Row title="Light" subtitle={`${lightLabel(values.light)} · Not available in a browser`} disabled />}
        <ToggleRow title="Use high priority notifications" subtitle="Show previews of notifications at the top of the screen" checked={values.highPriority} onChange={(enabled) => setHighPriority(section, enabled)} />
        <ToggleRow title={reactionsLabel} subtitle={reactionsText} checked={values.reactions} onChange={(enabled) => setSectionValue(section, 'reactions', enabled)} />
      </>
    );
  }

  let content;
  if (view?.type === 'tone') {
    const kind = view.kind;
    content = (
      <TonePicker
        title={view.title}
        kind={kind}
        value={settings[view.section][view.key]}
        volume={kind === 'ringtone' ? settings.volume.ringtone : settings.volume.notification}
        onChange={(choice) => setSectionValue(view.section, view.key, choice)}
        onVolume={(level) => updateNotificationSettings((current) => ({ ...current, volume: { ...current.volume, [kind]: level } }))}
        onBack={() => setView(null)}
      />
    );
  } else if (view?.type === 'vibrate') {
    content = (
      <RadioList
        title="Vibrate"
        options={VIBRATE_OPTIONS}
        value={settings[view.section].vibrate}
        onChange={(id) => { setSectionValue(view.section, 'vibrate', id); vibrateFor(view.section === 'calls' ? 'incomingCall' : view.section === 'groups' ? 'group' : view.section === 'status' ? 'status' : 'message'); }}
        onBack={() => setView(null)}
      />
    );
  } else {
    content = (
      <div className="wa-info-subview">
        <header className="wa-info-header">
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close notifications settings"><ArrowLeft size={20} /></button>
          <h2>Notifications</h2>
        </header>
        <div className="wa-info-scroll">
          <section className="wa-info-section">
            <ToggleRow title="Conversation tones" subtitle="Play sounds for incoming and outgoing messages." checked={settings.conversationTones} onChange={(enabled) => updateNotificationSettings({ conversationTones: enabled })} />
            <ToggleRow title="Reminders" subtitle="Get occasional reminders about messages, calls or status updates you haven't seen" checked={settings.reminders} onChange={(enabled) => updateNotificationSettings({ reminders: enabled })} />
          </section>
          {permissionNote && <p className="notif-permission" role="note"><Bell size={14} /> {permissionNote}</p>}
          <section className="wa-info-section">
            <h3>Messages</h3>
            {sectionRows('messages')}
          </section>
          <section className="wa-info-section">
            <h3>Groups</h3>
            {sectionRows('groups')}
          </section>
          <section className="wa-info-section">
            <h3>Calls</h3>
            <Row title="Ringtone" subtitle={toneLabel(settings.calls.ringtone, 'ringtone')} onClick={() => setView({ type: 'tone', section: 'calls', key: 'ringtone', kind: 'ringtone', title: 'Ringtone' })} />
            <Row title="Vibrate" subtitle={vibrateLabel(settings.calls.vibrate)} onClick={() => setView({ type: 'vibrate', section: 'calls' })} />
          </section>
          <section className="wa-info-section">
            <h3>Status</h3>
            {sectionRows('status', { light: false, reactionsLabel: 'Reactions', reactionsText: 'Show notifications when you get likes on a status' })}
          </section>
          <section className="wa-info-section">
            <ToggleRow title="App icon badge" subtitle="Clears when you view all messages and calls" checked={settings.appBadge} onChange={(enabled) => updateNotificationSettings({ appBadge: enabled })} />
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="wa-info-layer notif-layer">
      <div className="wa-info-backdrop" onClick={onClose} role="presentation" />
      <div className="wa-info-drawer" role="dialog" aria-modal="true" aria-label="Notification settings">
        {content}
      </div>
    </div>
  );
}
