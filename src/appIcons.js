// Settings › Appearance › App icon: the launcher icons the Android app ships (AndroidManifest.xml activity-alias
// entries, res/drawable/hm_launcher_background*.xml). Same mark, different background.
export const APP_ICONS = Object.freeze([
  { id: 'default', label: 'Blue', from: '#2f7df0', to: '#0a3f9e' },
  { id: 'midnight', label: 'Midnight', from: '#1b2b45', to: '#060d18' },
  { id: 'teal', label: 'Teal', from: '#14b8a6', to: '#0f5f73' },
]);

export const appIconLabel = (id) => APP_ICONS.find((icon) => icon.id === id)?.label ?? 'Blue';
