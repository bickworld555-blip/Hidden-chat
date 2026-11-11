// Text status backgrounds: the colours the app offers (blue and navy first), and every colour the server
// accepts, which also covers what older apps still send.
export const STATUS_BACKGROUNDS = ['#1d4ed8', '#0b3a75', '#7e57c2', '#ef6c00', '#c2185b', '#0e7490', '#5d4037', '#37474f'];
const OLDER_APPS = ['#00a884', '#128c7e', '#1e88e5'];
export const ACCEPTED_STATUS_BACKGROUNDS = new Set([...STATUS_BACKGROUNDS, ...OLDER_APPS]);
