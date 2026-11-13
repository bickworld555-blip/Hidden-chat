// Settings › Chats › Voice message translation (Android app): turn it on, pick the language to hear voice messages
// in, and get each of Bangla, English, Hindi and Arabic ready on this phone. Every part runs offline once downloaded:
//   speech-to-text  Android's on-device pack, or the offline speech model (whisper, 190 MB) where there is no pack;
//   translation     ML Kit's model for the language (about 30 MB);
//   voice           an installed offline voice (Android's voice data installer adds Hindi, Arabic…).
import { useEffect } from 'react';
import { AudioLines, Check, Download, Languages, Mic, Trash2, Volume2 } from 'lucide-react';
import { appSettings, useSetting } from '../settings.js';
import { VOICE_LANGUAGE_AUTO, VOICE_LANGUAGES, resolveVoiceLanguage, voiceLanguageLabel } from '../voiceLanguage.js';
import {
  deleteTranslation, deleteWhisper, downloadSystemSpeech, downloadTranslation, downloadWhisper, openVoiceInstaller,
  refreshStatus, useVoiceTranslation,
} from '../voiceTranslation.js';

const MB = 1024 * 1024;
const SPEECH_LABEL = {
  system: 'Speech: Android’s offline pack',
  whisper: 'Speech: offline speech model',
  'system-pending': 'Speech: Android pack downloading…',
  'system-download': 'Speech: Android offers an offline pack',
  'whisper-download': 'Speech: needs the offline speech model',
  none: 'Speech: not available on this phone',
};

function Step({ ready, icon: Icon, label, action, busy, onAction, onRemove }) {
  return (
    <div className={`vt-step${ready ? ' is-ready' : ''}`}>
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
      {ready ? (
        onRemove ? <button type="button" className="icon-button" onClick={onRemove} disabled={busy} aria-label={`Remove: ${label}`}><Trash2 size={15} /></button> : <Check size={16} aria-label="Ready" />
      ) : action && (
        <button type="button" className="vt-action" onClick={onAction} disabled={busy}><Download size={14} aria-hidden="true" /> {busy ? 'Working…' : action}</button>
      )}
    </div>
  );
}

export default function VoiceTranslationSettings() {
  const enabled = useSetting('chats.translateVoice');
  const choice = useSetting('chats.translateTo');
  const target = resolveVoiceLanguage(choice);
  const { status, checking, whisperProgress, busy, errors } = useVoiceTranslation();
  useEffect(() => {
    refreshStatus();
    // Back from Android's voice installer or speech settings: check again.
    const onVisible = () => { if (document.visibilityState === 'visible') refreshStatus(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const whisper = status?.whisper;
  const errorList = Object.values(errors).filter(Boolean);
  if (!status && !checking) {
    return <div className="tools-section"><p className="tools-page-note">Voice message translation works in the Android app.</p></div>;
  }
  return (
    <div className="tools-section vt-settings">
      <p className="tools-page-note">Hear voice messages in your language. Everything happens on this phone: the voice message, its text and the translation never leave it, and nothing is sent to any translation service. Download what each language needs once; after that it works without internet.</p>
      <button type="button" className="tool-item" role="switch" aria-checked={enabled} onClick={() => appSettings().set('chats.translateVoice', !enabled)}>
        <Languages size={20} />
        <div className="tool-item-info"><strong>Voice message translation</strong><small>{enabled ? `Voice messages in other languages get “Play in ${voiceLanguageLabel(target)}”` : 'Off'}</small></div>
        <span className={`wa-switch${enabled ? ' on' : ''}`} aria-hidden="true"><span /></span>
      </button>

      <h3>Play voice messages in</h3>
      <div role="radiogroup" aria-label="Translate voice messages into">
        {[{ id: VOICE_LANGUAGE_AUTO, label: `Same as the phone (${voiceLanguageLabel(resolveVoiceLanguage(VOICE_LANGUAGE_AUTO))})` }, ...VOICE_LANGUAGES].map(({ id, label }) => (
          <button key={id} type="button" role="radio" aria-checked={choice === id} className="tool-item" onClick={() => appSettings().set('chats.translateTo', id)}>
            <Volume2 size={20} />
            <div className="tool-item-info"><strong>{label}</strong></div>
            {choice === id && <Check size={18} />}
          </button>
        ))}
      </div>

      {whisper?.supported && (
        <>
          <h3>Offline speech model</h3>
          <p className="tools-page-note">Turns speech into text for languages Android has no offline pack for (often Bangla). {Math.round((whisper.sizeBytes ?? 0) / MB)} MB, checked after download.</p>
          <Step ready={whisper.installed} icon={Mic} label={whisper.installed ? 'Offline speech model is ready' : whisperProgress ? `Downloading… ${Math.round(whisperProgress.received / MB)} of ${Math.round(whisperProgress.total / MB)} MB` : 'Offline speech model'}
            action="Download" busy={Boolean(busy.whisper) || whisper.downloading} onAction={downloadWhisper} onRemove={deleteWhisper} />
        </>
      )}

      <h3>Languages</h3>
      {VOICE_LANGUAGES.map(({ id, label }) => {
        const language = status?.languages?.[id];
        if (!language) return null;
        const speechReady = ['system', 'whisper'].includes(language.speech);
        const speechAction = language.speech === 'system-download' ? ['Download', () => downloadSystemSpeech(id)]
          : language.speech === 'whisper-download' ? ['Get the model', downloadWhisper] : [null, null];
        return (
          <section key={id} className="vt-language" aria-label={label}>
            <h4>{label}{id === target ? ' · you hear voice messages in this' : ''}</h4>
            <Step ready={speechReady} icon={AudioLines} label={SPEECH_LABEL[language.speech] ?? SPEECH_LABEL.none} action={speechAction[0]} busy={Boolean(busy[`speech:${id}`] || busy.whisper)} onAction={speechAction[1]} />
            {language.translatable && (
              <Step ready={language.translation} icon={Languages} label={language.translation ? 'Translation model ready' : id === 'en-US' ? 'Translation: built in' : 'Translation model (about 30 MB)'}
                action="Download" busy={Boolean(busy[`translation:${id}`])} onAction={() => downloadTranslation(id)}
                onRemove={id === 'en-US' ? undefined : () => deleteTranslation(id)} />
            )}
            <Step ready={Boolean(language.voice)} icon={Volume2} label={language.voice ? 'Offline voice installed' : 'Offline voice: not installed'}
              action="Install voice" busy={Boolean(busy.voice)} onAction={openVoiceInstaller} />
          </section>
        );
      })}
      <p className="tools-page-note">After installing a voice in Android’s settings, come back here; the list updates by itself.</p>
      {errorList.length > 0 && <p className="attachment-error" role="alert">{errorList.at(-1)}</p>}
    </div>
  );
}
