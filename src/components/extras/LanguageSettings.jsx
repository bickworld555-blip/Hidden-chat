// App language picker (src/i18n.js).
import { Check } from 'lucide-react';
import Panel from '../parity/Panel.jsx';
import { LANGUAGES, setLanguage, useLanguage, useT } from '../../i18n.js';

export default function LanguageSettings({ onClose }) {
  const language = useLanguage((state) => state.language);
  const t = useT();
  return (
    <Panel title={t('App language')} onClose={onClose}>
      <div role="radiogroup" aria-label={t('App language')}>
        {LANGUAGES.map((item) => (
          <button key={item.id} type="button" role="radio" aria-checked={language === item.id} className="hm-row-main" onClick={() => setLanguage(item.id)}>
            <span><strong>{item.native}</strong><small>{item.name}</small></span>
            {language === item.id && <Check size={18} />}
          </button>
        ))}
      </div>
      <p className="hm-muted">The main screens use your language now; the rest of the app is being translated and shows English until then.</p>
    </Panel>
  );
}
