import { memo, useEffect } from 'react';
import { useCallSlice, useCallStore } from '../../callStore.js';

// In-call notices one at a time ("Inviting Ava…", "Ava declined"), in priority order; each shows for its time, then
// the next. An error from the call itself always wins and stays.
export default memo(function CallNotices({ error }) {
  const { current } = useCallSlice('notices');
  useEffect(() => {
    if (!current) return undefined;
    const timer = setTimeout(() => useCallStore.getState().dismissNotice(current.id), current.durationMs);
    return () => clearTimeout(timer);
  }, [current]);
  if (error) return <div className="wa-call-error-toast" role="alert">{error}</div>;
  if (!current) return null;
  return (
    <div key={current.id} className="wa-call-error-toast is-notice" role="status" onClick={() => useCallStore.getState().dismissNotice(current.id)}>
      {current.text}
    </div>
  );
});
