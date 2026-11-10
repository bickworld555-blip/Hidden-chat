import { FileText, Camera, Image, Music, MapPin, User, BarChart3, Calendar, Sticker, ShoppingBag, X, Eye, Video, Smile, ShoppingCart } from 'lucide-react';
import { appSettings, useSetting } from '../settings.js';

const attachmentOptions = [
  { id: 'document', icon: FileText, label: 'Document', color: 'bg-blue-100 text-blue-600' },
  { id: 'camera', icon: Camera, label: 'Camera', color: 'bg-purple-100 text-purple-600' },
  { id: 'gallery', icon: Image, label: 'Gallery', color: 'bg-pink-100 text-pink-600' },
  { id: 'viewonce', icon: Eye, label: 'View once', color: 'bg-rose-100 text-rose-600' },
  { id: 'videonote', icon: Video, label: 'Video note', color: 'bg-sky-100 text-sky-600' },
  { id: 'mysticker', icon: Smile, label: 'Make sticker', color: 'bg-lime-100 text-lime-700' },
  { id: 'audio', icon: Music, label: 'Audio', color: 'bg-orange-100 text-orange-600' },
  { id: 'location', icon: MapPin, label: 'Location', color: 'bg-yellow-100 text-yellow-600' },
  { id: 'contact', icon: User, label: 'Contact', color: 'bg-indigo-100 text-indigo-600' },
  { id: 'poll', icon: BarChart3, label: 'Poll', color: 'bg-violet-100 text-violet-600' },
  { id: 'event', icon: Calendar, label: 'Event', color: 'bg-emerald-100 text-emerald-600' },
  { id: 'sticker', icon: Sticker, label: 'Sticker', color: 'bg-amber-100 text-amber-600' },
  { id: 'catalog', icon: ShoppingBag, label: 'Catalog', color: 'bg-teal-100 text-teal-600' },
  { id: 'order', icon: ShoppingCart, label: 'Order', color: 'bg-cyan-100 text-cyan-700' },
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
          {shown.map((option) => {
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
