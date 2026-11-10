import { MessageCircle, Phone, CircleDashed, UsersRound } from 'lucide-react';
import { useT } from '../i18n.js';

export default function MobileBottomNav({ activeTab, onTabChange, unreadCount = 0 }) {
  const t = useT();
  const tabs = [
    { id: 'chats', label: 'Chats', icon: MessageCircle, unread: unreadCount },
    { id: 'updates', label: 'Updates', icon: CircleDashed, unread: 0 },
    { id: 'communities', label: 'Communities', icon: UsersRound, unread: 0 },
    { id: 'calls', label: 'Calls', icon: Phone, unread: 0 },
  ];

  return (
    <nav className="mobile-bottom-nav">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            className={`nav-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
            title={tab.label}
            aria-label={`${tab.label} tab`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            <div className="nav-icon-wrapper">
              <Icon size={24} strokeWidth={2} />
              {tab.unread > 0 && <span className="unread-badge">{tab.unread}</span>}
            </div>
            <span className="nav-label">{t(tab.label)}</span>
          </button>
        );
      })}
    </nav>
  );
}
