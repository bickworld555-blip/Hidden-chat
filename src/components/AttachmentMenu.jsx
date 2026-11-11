import { FileText, Camera, Image, Music, MapPin, User, BarChart3, Calendar, Sticker, ShoppingBag, X, Eye, Video, Smile, ShoppingCart } from 'lucide-react';
import { appSettings, useSetting } from '../settings.js';

// Sharing first (files, camera, photos, audio, places, people), then planning (poll, event), then selling and
// Hidden Messenger extras. `tone` is the glyph colour; the tile behind it is a soft tint of the same colour.
const attachmentOptions = [
  { id: 'document', icon: FileText, label: 'Document', tone: '#5b5fd6' },
  { id: 'camera', icon: Camera, label: 'Camera', tone: '#d6386b' },
  { id: 'gallery', icon: Image, label: 'Gallery', tone: '#2f7de1' },
  { id: 'audio', icon: Music, label: 'Audio', tone: '#e2731b' },
  { id: 'location', icon: MapPin, label: 'Location', tone: '#1c9b5c' },
  { id: 'contact', icon: User, label: 'Contact', tone: '#1597b8' },
  { id: 'poll', icon: BarChart3, label: 'Poll', tone: '#c9921a' },
  { id: 'event', icon: Calendar, label: 'Event', tone: '#d1435b' },
  { id: 'catalog', icon: ShoppingBag, label: 'Catalog', tone: '#7a55c7' },
  { id: 'order', icon: ShoppingCart, label: 'Order', tone: '#0f8a7e' },
  { id: 'viewonce', icon: Eye, label: 'View once', tone: '#b0457e' },
  { id: 'videonote', icon: Video, label: 'Video note', tone: '#3a6fc4' },
  { id: 'mysticker', icon: Smile, label: 'Make sticker', tone: '#5f8f1f' },
  { id: 'sticker', icon: Sticker, label: 'Sticker', tone: '#b86a16' },
];

export default function AttachmentMenu({ onSelect, onClose, isOpen, options = null }) {
  // Standard / HD for photos (a device setting, also in Storage and data).
  const quality = useSetting('media.uploadQuality');
  if (!isOpen) return null;
  const shown = options ? attachmentOptions.filter((option) => options.includes(option.id)) : attachmentOptions;

  const handleOptionClick = (optionId) => {
    onSelect(optionId);
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div className="attachment-menu-backdrop" onClick={onClose} />
      
      {/* Menu Panel */}
      <div className="attachment-menu-panel" role="dialog" aria-label="Share">
        <div className="attachment-menu-header">
          <span className="attachment-menu-handle" aria-hidden="true" />
          <button 
            className="attachment-menu-close" 
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>
        
        <div className="attachment-menu-grid">
          {shown.map((option) => {
            const IconComponent = option.icon;
            return (
              <button
                key={option.id}
                className="attachment-menu-item"
                onClick={() => handleOptionClick(option.id)}
                title={option.label}
              >
                <div className="attachment-menu-icon" style={{ '--tile': option.tone }}>
                  <IconComponent size={24} strokeWidth={2.1} />
                </div>
                <span className="attachment-menu-label">{option.label}</span>
              </button>
            );
          })}
        </div>
        <div className="attachment-quality" role="radiogroup" aria-label="Photo quality">
          <span>Photo quality</span>
          {[['standard', 'Standard'], ['hd', 'HD']].map(([id, label]) => (
            <button type="button" key={id} role="radio" aria-checked={quality === id} className={quality === id ? 'is-active' : ''}
              onClick={() => appSettings().set('media.uploadQuality', id).catch(() => {})}>{label}</button>
          ))}
        </div>
      </div>
    </>
  );
}
