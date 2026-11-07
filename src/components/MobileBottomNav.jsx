import { MessageCircle, Phone, Eye, Settings } from 'lucide-react';

export default function MobileBottomNav({ activeTab, onTabChange, unreadCount = 0 }) {
  const tabs = [
    { id: 'chats', label: 'Chats', icon: MessageCircle, unread: unreadCount },
    { id: 'calls', label: 'Calls', icon: Phone, unread: 0 },
    { id: 'updates', label: 'Updates', icon: Eye, unread: 0 },
    { id: 'tools', label: 'Tools', icon: Settings, unread: 0 },
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
            <span className="nav-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
