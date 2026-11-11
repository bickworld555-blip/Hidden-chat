import { MessageCircle, Phone, CircleDashed, Store } from 'lucide-react';
import { useT } from '../i18n.js';

export default function MobileBottomNav({ activeTab, onTabChange, unreadCount = 0 }) {
  const t = useT();
  const tabs = [
    // Business-messenger order: Chats, Calls, Updates, then Tools (the business hub). Communities is in the
    // Chats menu.
    { id: 'chats', label: 'Chats', icon: MessageCircle, unread: unreadCount },
    { id: 'calls', label: 'Calls', icon: Phone, unread: 0 },
    { id: 'updates', label: 'Updates', icon: CircleDashed, unread: 0 },
    { id: 'business', label: 'Tools', icon: Store, unread: 0 },
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
