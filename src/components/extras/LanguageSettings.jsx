// App language (src/i18n.js), laid out like WhatsApp's: the device's language first, then every language by its own
// name with the current language's name for it underneath, one choice at a time.
import Panel from '../parity/Panel.jsx';
import { DEVICE_LANGUAGE, LANGUAGES, deviceLanguage, setLanguage, useLanguage, useT } from '../../i18n.js';

function Choice({ checked, title, detail, onPick }) {
  return (
    <label className="hm-lang-row">
      <input type="radio" name="app-language" checked={checked} onChange={onPick} />
      <span><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
    </label>
  );
}

export default function LanguageSettings({ onClose }) {
  const language = useLanguage((state) => state.language);
  const followsDevice = useLanguage((state) => state.followsDevice);
  const t = useT();
  const device = LANGUAGES.find((item) => item.id === deviceLanguage());
  return (
    <Panel title={t('App language')} onClose={onClose}>
      <div role="radiogroup" aria-label={t('App language')} className="hm-lang-list">
        <Choice checked={followsDevice} title={`${device.native} (device's language)`} detail={device.name} onPick={() => setLanguage(DEVICE_LANGUAGE)} />
        {LANGUAGES.map((item) => (
          <Choice key={item.id} checked={!followsDevice && language === item.id} title={item.native} detail={item.name}
            onPick={() => setLanguage(item.id)} />
        ))}
      </div>
      <p className="hm-muted hm-lang-note">The main screens use your language now; the rest of the app is being translated and shows English until then.</p>
    </Panel>
  );
}
