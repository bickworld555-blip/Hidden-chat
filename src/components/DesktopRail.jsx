// Desktop navigation rail (left edge of the web app): the sections on top, your things at the bottom.
import { MessageCircle, CircleDashed, Radio, UsersRound, Phone, Star, Settings, Moon, Sun } from 'lucide-react';
import { useT } from '../i18n.js';

const SECTIONS = [
  { id: 'chats', label: 'Chats', icon: MessageCircle },
  { id: 'updates', label: 'Updates', icon: CircleDashed },
  { id: 'channels', label: 'Channels', icon: Radio, sheet: true },
  { id: 'communities', label: 'Communities', icon: UsersRound },
  { id: 'calls', label: 'Calls', icon: Phone },
];

export default function DesktopRail({ activeTab, onTab, onSheet, unreadCount = 0, darkMode, onToggleTheme }) {
  const t = useT();
  return (
    <nav className="desktop-rail" aria-label="Sections">
      <div className="desktop-rail-group">
        {SECTIONS.map(({ id, label, icon: Icon, sheet }) => (
          <button key={id} type="button" className={`desktop-rail-item${!sheet && activeTab === id ? ' is-active' : ''}`}
            onClick={() => (sheet ? onSheet(id) : onTab(id))} aria-label={t(label)} title={t(label)} aria-current={!sheet && activeTab === id ? 'page' : undefined}>
            <Icon size={22} strokeWidth={1.9} />
            {id === 'chats' && unreadCount > 0 && <span className="desktop-rail-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>
        ))}
      </div>
      <div className="desktop-rail-group">
        <button type="button" className="desktop-rail-item" onClick={() => onSheet('starred')} aria-label="Starred messages" title="Starred messages"><Star size={21} strokeWidth={1.9} /></button>
        <button type="button" className="desktop-rail-item" onClick={onToggleTheme} aria-label={darkMode ? 'Light theme' : 'Dark theme'} title={darkMode ? 'Light theme' : 'Dark theme'}>{darkMode ? <Sun size={21} /> : <Moon size={21} />}</button>
        <button type="button" className={`desktop-rail-item${activeTab === 'tools' ? ' is-active' : ''}`} onClick={() => onTab('tools')} aria-label="Settings" title="Settings"><Settings size={21} strokeWidth={1.9} /></button>
      </div>
    </nav>
  );
}
