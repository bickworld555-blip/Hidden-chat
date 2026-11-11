// Message bubbles and composers for view once voice notes, polls and events (direct and group chats).
import { useEffect, useRef, useState } from 'react';
import { CalendarPlus, CalendarDays, Check, MapPin, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import { apiFetch } from '../api.js';
import { useChatStore } from '../store.js';
import { formatClock } from '../voice.js';
import { MAX_POLL_OPTIONS, encodePoll, tallyPoll } from '../polls.js';
import { encodeEvent, eventCalendarFile, formatEventTime } from '../calendarEvents.js';
import { saveBlob } from '../media.js';
import { castVote, combineVotes } from '../e2e/polls.js';
import { decryptMedia } from '../mediaCrypto.js';

function OnceMark({ opened }) {
  return <span className={`view-once-mark${opened ? ' is-opened' : ''}`} aria-hidden="true">1</span>;
}

// A view once note that was claimed from the server but has not played to the end yet, kept in memory only (never
// stored or downloadable) for the rest of this session: if Android refuses to start playback, the bubble re-renders
// or the chat is reopened, it plays from here instead of being lost (the server hands the audio out only once).
const heldOnce = new Map(); // messageId -> object URL

function releaseHeld(messageId) {
  const url = heldOnce.get(messageId);
  if (url) URL.revokeObjectURL(url);
  heldOnce.delete(messageId);
}

// Recipient: tap to fetch and play the audio once (it is never cached on disk or downloadable). Sender: a status card.
// An end-to-end encrypted note arrives as ciphertext and is decrypted here with the key from its message.
export function ViewOnceVoice({ messageId, seconds, opened, mine, sessionToken, descriptor = null, children }) {
  // idle | loading | ready (audio held, not playing yet) | playing | paused | done | error
  const [state, setState] = useState(() => (heldOnce.has(messageId) ? 'ready' : 'idle'));
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const audioRef = useRef(null);

  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null; }, []);

  function startAudio(url) {
    const audio = audioRef.current ?? new Audio(url);
    if (!audioRef.current) {
      audioRef.current = audio;
      audio.ontimeupdate = () => setProgress(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0);
      audio.onended = () => {
        audioRef.current = null;
        releaseHeld(messageId);
        setState('done');
      };
      audio.onerror = () => { audioRef.current = null; setState('ready'); setError('Tap to try again.'); };
    }
    // Rejected (e.g. Android wants a fresh tap after the download): the audio stays held, one more tap plays it.
    audio.play().then(() => { setError(''); setState('playing'); }).catch(() => { setState('ready'); setError('Tap to play.'); });
  }

  async function play() {
    if (state === 'playing') { audioRef.current?.pause(); setState('paused'); return; }
    const held = heldOnce.get(messageId);
    if (held) { startAudio(held); return; }
    setState('loading');
    setError('');
    let received;
    try {
      const response = await apiFetch(`/api/v1/messages/${encodeURIComponent(messageId)}/view-once`, {
        method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? 'This voice message could not be played.');
        setState(response.status === 410 ? 'done' : 'error');
        return;
      }
      received = await response.blob();
    } catch {
      // Nothing was claimed (no answer from the server): the note can still be played.
      setError('No connection. Tap to try again.');
      setState('idle');
      return;
    }
    try {
      const audio = descriptor ? await decryptMedia(received, descriptor) : received;
      heldOnce.set(messageId, URL.createObjectURL(audio));
    } catch {
      setError('This voice message could not be decrypted.');
      setState('error');
      return;
    }
    startAudio(heldOnce.get(messageId));
  }

  // Still held (claimed, not finished) means it can play, even though the server already reports it opened.
  const active = ['loading', 'ready', 'playing', 'paused'].includes(state);
  if ((opened || state === 'done' || state === 'error') && !active) {
    return (
      <div className="view-once-voice is-opened">
        <OnceMark opened />
        <span className="view-once-copy"><strong>Opened</strong>{error && <small>{error}</small>}</span>
        {children}
      </div>
    );
  }
  if (mine) {
    return (
      <div className="view-once-voice">
        <OnceMark />
        <span className="view-once-copy"><strong>Voice message</strong><small>View once · {formatClock(seconds)}</small></span>
        {children}
      </div>
    );
  }
  const playing = state === 'playing';
  return (
    <div className="view-once-voice">
      <button type="button" className="view-once-play" onClick={play} disabled={state === 'loading'} aria-label={playing ? 'Pause' : 'Play view once voice message'}>
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <span className="view-once-copy">
        <strong>{state === 'loading' ? 'Opening…' : playing || state === 'paused' ? 'Playing once…' : 'Voice message'}</strong>
        {playing || state === 'paused'
          ? <span className="view-once-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>
          : <small>{error || `View once · ${formatClock(seconds)}`}</small>}
      </span>
      <OnceMark />
      {children}
    </div>
  );
}

// --- Polls ----------------------------------------------------------------------------------------

async function fetchVotes(sessionToken, messageId) {
  const response = await apiFetch(`/api/v1/polls/${encodeURIComponent(messageId)}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
  if (!response.ok) throw new Error('Could not load votes.');
  const body = await response.json();
  return { votes: body.votes ?? {}, sealedVotes: body.sealedVotes ?? [] };
}

// Votes are end-to-end encrypted (src/e2e/polls.js): the store keeps what the server sent ({ votes, sealedVotes })
// and this bubble opens and counts them. `context` is { peerId } in a direct chat or { groupId } in a group.
export function PollBubble({ messageId, poll, sessionToken, userId, nameFor, context = {}, children }) {
  const raw = useChatStore((state) => state.pollVotes?.[messageId]);
  const setPollVotes = useChatStore((state) => state.setPollVotes);
  const [votes, setVotes] = useState(null);
  const [error, setError] = useState('');
  const [showVoters, setShowVoters] = useState(false);
  const groupId = context.groupId ?? null;

  useEffect(() => {
    if (raw || !sessionToken) return;
    fetchVotes(sessionToken, messageId).then((loaded) => setPollVotes(messageId, loaded)).catch(() => {});
  }, [messageId, sessionToken, raw, setPollVotes]);

  useEffect(() => {
    if (!raw) return undefined;
    let cancelled = false;
    // Older stores held a plain { [option]: [userId] } map.
    const source = raw.votes || raw.sealedVotes ? raw : { votes: raw, sealedVotes: [] };
    combineVotes(source, poll, groupId ? { groupId } : {}).then((combined) => { if (!cancelled) setVotes(combined); }).catch(() => {});
    return () => { cancelled = true; };
  }, [raw, poll, groupId]);

  const tally = tallyPoll(votes ?? {}, poll.options.length, userId);

  async function choose(index) {
    const chosen = tally.mine.includes(index)
      ? tally.mine.filter((option) => option !== index)
      : poll.multiple ? [...tally.mine, index] : [index];
    const previous = votes ?? {};
    // Optimistic: move this user's vote right away; the server's answer replaces it.
    const optimistic = {};
    poll.options.forEach((_, option) => {
      const others = (previous[option] ?? []).filter((id) => id !== userId);
      const next = chosen.includes(option) ? [...others, userId] : others;
      if (next.length) optimistic[option] = next;
    });
    setVotes(optimistic);
    setError('');
    try {
      const saved = await castVote(sessionToken, messageId, chosen, context);
      setPollVotes(messageId, { votes: saved.votes ?? {}, sealedVotes: saved.sealedVotes ?? [] });
    } catch (failure) {
      setVotes(previous);
      setError(failure.message);
    }
  }

  return (
    <div className="poll-bubble">
      <strong className="poll-question">{poll.question}</strong>
      <small className="poll-hint">{poll.multiple ? 'Select one or more' : 'Select one'}</small>
      <ul className="poll-options">
        {poll.options.map((option, index) => {
          const selected = tally.mine.includes(index);
          const count = tally.counts[index];
          return (
            <li key={option}>
              <button type="button" className={`poll-option${selected ? ' is-selected' : ''}`} onClick={() => choose(index)} aria-pressed={selected}>
                <span className={`poll-check${poll.multiple ? ' is-square' : ''}`} aria-hidden="true">{selected && <Check size={12} strokeWidth={3} />}</span>
                <span className="poll-option-body">
                  <span className="poll-option-row"><span>{option}</span><span className="poll-count">{count}</span></span>
                  <span className="poll-bar"><i style={{ width: tally.leader ? `${(count / tally.leader) * 100}%` : '0%' }} /></span>
                  {showVoters && count > 0 && <small className="poll-voters">{votes[index].map((id) => (id === userId ? 'You' : nameFor?.(id) ?? 'Someone')).join(', ')}</small>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {error && <small className="poll-error" role="alert">{error}</small>}
      <button type="button" className="poll-view-votes" onClick={() => setShowVoters((open) => !open)} disabled={tally.voters === 0}>
        {tally.voters === 0 ? 'No votes yet' : showVoters ? 'Hide votes' : `View votes · ${tally.voters} ${tally.voters === 1 ? 'person' : 'people'}`}
      </button>
      {children}
    </div>
  );
}

// --- Events ---------------------------------------------------------------------------------------

export function EventBubble({ messageId, event, children }) {
  const past = new Date(event.startsAt).getTime() < Date.now();
  function addToCalendar() {
    const file = eventCalendarFile({ ...event, id: messageId });
    saveBlob(new Blob([file], { type: 'text/calendar' }), `${event.title.replace(/[^\w\s-]/g, '').trim() || 'event'}.ics`);
  }
  return (
    <div className="event-bubble">
      <span className="event-icon" aria-hidden="true"><CalendarDays size={22} /></span>
      <span className="event-body">
        <strong>{event.title}</strong>
        <small className={past ? 'is-past' : ''}>{formatEventTime(event.startsAt)}{past ? ' · ended' : ''}</small>
        {event.location && <small className="event-location"><MapPin size={12} aria-hidden="true" /> {event.location}</small>}
        {event.description && <p>{event.description}</p>}
      </span>
      <button type="button" className="event-calendar" onClick={addToCalendar}><CalendarPlus size={16} /> Add to calendar</button>
      {children}
    </div>
  );
}

// --- Composers ------------------------------------------------------------------------------------

function ComposerSheet({ title, onClose, onSubmit, canSubmit, submitLabel, children }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="rich-composer" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (canSubmit) onSubmit(); }}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="rich-composer-actions">
          <button type="submit" className="account-primary" disabled={!canSubmit}>{submitLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function PollComposer({ onSend, onClose }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const content = encodePoll({ question, options, multiple });

  function setOption(index, value) {
    setOptions((list) => {
      const next = list.map((option, position) => (position === index ? value : option));
      // A new empty row appears once the last one is used, like WhatsApp.
      if (index === next.length - 1 && value.trim() && next.length < MAX_POLL_OPTIONS) next.push('');
      return next;
    });
  }

  return (
    <ComposerSheet title="Create poll" onClose={onClose} onSubmit={() => onSend(content)} canSubmit={Boolean(content)} submitLabel="Send poll">
      <label className="rich-field">Question<input autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question" maxLength={200} /></label>
      <span className="rich-field-label">Options</span>
      {options.map((option, index) => (
        <div className="rich-option" key={index}>
          <input value={option} onChange={(event) => setOption(index, event.target.value)} placeholder={`Option ${index + 1}`} maxLength={200} aria-label={`Option ${index + 1}`} />
          {options.length > 2 && (
            <button type="button" className="icon-button" onClick={() => setOptions((list) => list.filter((_, position) => position !== index))} aria-label={`Remove option ${index + 1}`}><Trash2 size={16} /></button>
          )}
        </div>
      ))}
      {options.length < MAX_POLL_OPTIONS && options.every((option) => option.trim()) && (
        <button type="button" className="rich-add" onClick={() => setOptions((list) => [...list, ''])}><Plus size={16} /> Add option</button>
      )}
      <button type="button" className="tool-item rich-toggle" role="switch" aria-checked={multiple} onClick={() => setMultiple((value) => !value)}>
        <span className="tool-item-info"><strong>Allow multiple answers</strong></span>
        <span className={`wa-switch${multiple ? ' on' : ''}`} aria-hidden="true"><span /></span>
      </button>
    </ComposerSheet>
  );
}

const pad = (value) => String(value).padStart(2, '0');
function nextHourLocal() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
}

export function EventComposer({ onSend, onClose }) {
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState(nextHourLocal);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const content = encodeEvent({ title, startsAt, location, description });
  return (
    <ComposerSheet title="Create event" onClose={onClose} onSubmit={() => onSend(content)} canSubmit={Boolean(content)} submitLabel="Send event">
      <label className="rich-field">Event name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Birthday dinner" maxLength={120} /></label>
      <label className="rich-field">Starts<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
      <label className="rich-field">Location (optional)<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Add a place" maxLength={200} /></label>
      <label className="rich-field">Description (optional)<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={1000} /></label>
    </ComposerSheet>
  );
}
