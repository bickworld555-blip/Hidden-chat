// Message bubbles and composers for view once voice notes, polls and events (direct and group chats).
import { useEffect, useRef, useState } from 'react';
import { CalendarPlus, CalendarDays, Check, MapPin, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import { apiFetch } from '../api.js';
import { useChatStore } from '../store.js';
import { formatClock } from '../voice.js';
import { MAX_POLL_OPTIONS, encodePoll, tallyPoll } from '../polls.js';
import { encodeEvent, eventCalendarFile, formatEventTime } from '../calendarEvents.js';
import { saveBlob } from '../media.js';

function OnceMark({ opened }) {
  return <span className={`view-once-mark${opened ? ' is-opened' : ''}`} aria-hidden="true">1</span>;
}

// Recipient: tap to fetch and play the audio once (it is never cached or downloadable). Sender: a status card.
export function ViewOnceVoice({ messageId, seconds, opened, mine, sessionToken, children }) {
  const [state, setState] = useState('idle'); // idle | loading | playing | paused | done | error
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const audioRef = useRef(null);
  const urlRef = useRef('');

  useEffect(() => () => {
    audioRef.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  async function play() {
    if (state === 'playing') { audioRef.current?.pause(); setState('paused'); return; }
    if (state === 'paused') { audioRef.current?.play().then(() => setState('playing')).catch(() => {}); return; }
    setState('loading');
    setError('');
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
      urlRef.current = URL.createObjectURL(await response.blob());
      const audio = new Audio(urlRef.current);
      audioRef.current = audio;
      audio.ontimeupdate = () => setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
      audio.onended = () => {
        setState('done');
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = '';
        audioRef.current = null;
      };
      await audio.play();
      setState('playing');
    } catch {
      setError('This voice message could not be played.');
      setState('error');
    }
  }

  const active = state === 'loading' || state === 'playing' || state === 'paused';
  if ((opened || state === 'done') && !active) {
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
  return (
    <div className="view-once-voice">
      <button type="button" className="view-once-play" onClick={play} disabled={state === 'loading'} aria-label={state === 'playing' ? 'Pause' : 'Play view once voice message'}>
        {state === 'playing' ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <span className="view-once-copy">
        <strong>{active ? 'Playing once…' : 'Voice message'}</strong>
        {active
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
  return (await response.json()).votes;
}

async function putVote(sessionToken, messageId, options) {
  const response = await apiFetch(`/api/v1/polls/${encodeURIComponent(messageId)}/vote`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ options }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? 'Your vote was not saved.');
  return body.votes;
}

export function PollBubble({ messageId, poll, sessionToken, userId, nameFor, children }) {
  const votes = useChatStore((state) => state.pollVotes?.[messageId]);
  const setPollVotes = useChatStore((state) => state.setPollVotes);
  const [error, setError] = useState('');
  const [showVoters, setShowVoters] = useState(false);

  useEffect(() => {
    if (votes || !sessionToken) return;
    fetchVotes(sessionToken, messageId).then((loaded) => setPollVotes(messageId, loaded)).catch(() => {});
  }, [messageId, sessionToken, votes, setPollVotes]);

  const tally = tallyPoll(votes ?? {}, poll.options.length, userId);

  async function choose(index) {
    const chosen = tally.mine.includes(index)
      ? tally.mine.filter((option) => option !== index)
      : poll.multiple ? [...tally.mine, index] : [index];
    const previous = votes ?? {};
    // Optimistic: move this user's vote right away; the server's tally replaces it.
    const optimistic = {};
    poll.options.forEach((_, option) => {
      const others = (previous[option] ?? []).filter((id) => id !== userId);
      const next = chosen.includes(option) ? [...others, userId] : others;
      if (next.length) optimistic[option] = next;
    });
    setPollVotes(messageId, optimistic);
    setError('');
    try {
      setPollVotes(messageId, await putVote(sessionToken, messageId, chosen));
    } catch (failure) {
      setPollVotes(messageId, previous);
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
