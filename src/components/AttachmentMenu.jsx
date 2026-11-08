import { FileText, Camera, Image, Music, MapPin, User, BarChart3, Calendar, X } from 'lucide-react';

const attachmentOptions = [
  { id: 'document', icon: FileText, label: 'Document', color: 'bg-blue-100 text-blue-600' },
  { id: 'camera', icon: Camera, label: 'Camera', color: 'bg-purple-100 text-purple-600' },
  { id: 'gallery', icon: Image, label: 'Gallery', color: 'bg-pink-100 text-pink-600' },
  { id: 'audio', icon: Music, label: 'Audio', color: 'bg-orange-100 text-orange-600' },
  { id: 'location', icon: MapPin, label: 'Location', color: 'bg-yellow-100 text-yellow-600' },
  { id: 'contact', icon: User, label: 'Contact', color: 'bg-indigo-100 text-indigo-600' },
  { id: 'poll', icon: BarChart3, label: 'Poll', color: 'bg-violet-100 text-violet-600' },
  { id: 'event', icon: Calendar, label: 'Event', color: 'bg-emerald-100 text-emerald-600' },
];

export default function AttachmentMenu({ onSelect, onClose, isOpen }) {
  if (!isOpen) return null;

  const handleOptionClick = (optionId) => {
    onSelect(optionId);
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div className="attachment-menu-backdrop" onClick={onClose} />
      
      {/* Menu Panel */}
      <div className="attachment-menu-panel">
        <div className="attachment-menu-header">
          <h3>Share with</h3>
          <button 
            className="attachment-menu-close" 
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>
        
        <div className="attachment-menu-grid">
          {attachmentOptions.map((option) => {
            const IconComponent = option.icon;
            return (
              <button
                key={option.id}
                className="attachment-menu-item"
                onClick={() => handleOptionClick(option.id)}
                title={option.label}
              >
                <div className={`attachment-menu-icon ${option.color}`}>
                  <IconComponent size={24} />
                </div>
                <span className="attachment-menu-label">{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
