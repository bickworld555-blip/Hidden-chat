// App language. The chosen language sets the page language (screen readers, hyphenation), dates and times, and
// the translated strings below; anything not yet translated stays in English. Kept on this device.
import { create } from 'zustand';

export const LANGUAGES = [
  { id: 'en', name: 'English', native: 'English' },
  { id: 'bn', name: 'Bengali', native: 'বাংলা' },
  { id: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { id: 'es', name: 'Spanish', native: 'Español' },
];
const STORAGE_KEY = 'hm:language';

const STRINGS = {
  bn: {
    Chats: 'চ্যাট', Calls: 'কল', Updates: 'আপডেট', Tools: 'টুলস', Message: 'মেসেজ', 'Edit message': 'মেসেজ সম্পাদনা',
    'Search or start new chat': 'খুঁজুন বা নতুন চ্যাট শুরু করুন', Archived: 'আর্কাইভ করা', 'Locked chats': 'লক করা চ্যাট',
    Channels: 'চ্যানেল', 'Broadcast lists': 'ব্রডকাস্ট তালিকা', 'Scheduled messages': 'নির্ধারিত মেসেজ', 'Call links': 'কল লিংক',
    'Status privacy': 'স্ট্যাটাস প্রাইভেসি', 'App language': 'অ্যাপের ভাষা', 'Not encrypted': 'এনক্রিপ্টেড নয়', Edited: 'সম্পাদিত',
    'Waiting for this message. It is end-to-end encrypted.': 'এই মেসেজের জন্য অপেক্ষা করা হচ্ছে। এটি এন্ড-টু-এন্ড এনক্রিপ্টেড।',
  },
  hi: {
    Chats: 'चैट', Calls: 'कॉल', Updates: 'अपडेट', Tools: 'टूल्स', Message: 'संदेश', 'Edit message': 'संदेश संपादित करें',
    'Search or start new chat': 'खोजें या नई चैट शुरू करें', Archived: 'संग्रहीत', 'Locked chats': 'लॉक की गई चैट',
    Channels: 'चैनल', 'Broadcast lists': 'ब्रॉडकास्ट सूचियाँ', 'Scheduled messages': 'शेड्यूल किए गए संदेश', 'Call links': 'कॉल लिंक',
    'Status privacy': 'स्टेटस गोपनीयता', 'App language': 'ऐप की भाषा', 'Not encrypted': 'एन्क्रिप्ट नहीं', Edited: 'संपादित',
    'Waiting for this message. It is end-to-end encrypted.': 'इस संदेश की प्रतीक्षा है। यह एंड-टू-एंड एन्क्रिप्टेड है।',
  },
  es: {
    Chats: 'Chats', Calls: 'Llamadas', Updates: 'Novedades', Tools: 'Herramientas', Message: 'Mensaje', 'Edit message': 'Editar mensaje',
    'Search or start new chat': 'Buscar o empezar un chat', Archived: 'Archivados', 'Locked chats': 'Chats bloqueados',
    Channels: 'Canales', 'Broadcast lists': 'Listas de difusión', 'Scheduled messages': 'Mensajes programados', 'Call links': 'Enlaces de llamada',
    'Status privacy': 'Privacidad del estado', 'App language': 'Idioma de la app', 'Not encrypted': 'Sin cifrar', Edited: 'Editado',
    'Waiting for this message. It is end-to-end encrypted.': 'Esperando este mensaje. Está cifrado de extremo a extremo.',
  },
};

function storedLanguage() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (LANGUAGES.some((language) => language.id === value)) return value;
  } catch { /* falls back below */ }
  const preferred = (globalThis.navigator?.language ?? 'en').slice(0, 2).toLowerCase();
  return LANGUAGES.some((language) => language.id === preferred) ? preferred : 'en';
}

export const useLanguage = create(() => ({ language: storedLanguage() }));

function applyDocumentLanguage(language) {
  if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = language;
}
applyDocumentLanguage(useLanguage.getState().language);

export function setLanguage(language) {
  if (!LANGUAGES.some((item) => item.id === language)) return;
  try { localStorage.setItem(STORAGE_KEY, language); } catch { /* applies for this session */ }
  applyDocumentLanguage(language);
  useLanguage.setState({ language });
}

/** The text in the chosen language (English when there is no translation yet). */
export function translate(text, language = useLanguage.getState().language) {
  return STRINGS[language]?.[text] ?? text;
}

/** Hook: t('Chats') re-renders when the language changes. */
export function useT() {
  const language = useLanguage((state) => state.language);
  return (text) => translate(text, language);
}

/** How many of the app's translated strings a language has (for the settings screen). */
export const translatedCount = (language) => Object.keys(STRINGS[language] ?? {}).length;
