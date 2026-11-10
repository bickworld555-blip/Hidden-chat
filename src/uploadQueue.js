// Priority queue for attachment uploads, like WhatsApp's MediaUploadQueue: voice notes and small files go first,
// big videos wait their turn, and only a few run at once so they do not starve each other on a slow connection.
// The queue reports its overall state (how many, which file, total progress) so the Android app can keep a
// foreground "Sending…" notification up while anything is uploading — without it Android may freeze or kill
// the app in the background and the upload would stall.

export const UPLOAD_PRIORITY = Object.freeze({ HIGH: 2, NORMAL: 1, LOW: 0 });
const SMALL_FILE_BYTES = 2 * 1024 * 1024;
const LARGE_FILE_BYTES = 50 * 1024 * 1024;

/** Default priority: voice notes and small files high, ordinary files normal, very large files low. */
export function uploadPriority({ size = 0, kind = '' } = {}) {
  if (kind === 'voice' || size <= SMALL_FILE_BYTES) return UPLOAD_PRIORITY.HIGH;
  if (size <= LARGE_FILE_BYTES) return UPLOAD_PRIORITY.NORMAL;
  return UPLOAD_PRIORITY.LOW;
}

/**
 * createUploadQueue({ concurrency, onChange }) → { enqueue, state }.
 * enqueue(run, { priority, label, size }) runs `run(reportProgress)` when its turn comes and settles like it.
 * `reportProgress(done, total)` feeds the overall progress; onChange(state) fires on every change.
 */
export function createUploadQueue({ concurrency = 2, onChange = () => {} } = {}) {
  const waiting = [];
  const running = new Map();
  let sequence = 0;

  function state() {
    const active = [...running.values()];
    const all = [...active, ...waiting];
    const total = all.reduce((sum, task) => sum + (task.size || 0), 0);
    const done = active.reduce((sum, task) => sum + Math.min(task.done, task.size || 0), 0);
    return {
      count: all.length,
      running: active.length,
      queued: waiting.length,
      label: active[0]?.label ?? waiting[0]?.label ?? '',
      progress: total > 0 ? Math.min(1, done / total) : 0,
    };
  }

  function notify() {
    try {
      onChange(state());
    } catch {
      // A failing listener must never break uploads.
    }
  }

  function pump() {
    while (running.size < concurrency && waiting.length > 0) {
      // Highest priority first; equal priorities in the order they were added.
      waiting.sort((a, b) => b.priority - a.priority || a.order - b.order);
      const task = waiting.shift();
      running.set(task.order, task);
      Promise.resolve()
        .then(() => task.run((done) => {
          task.done = Number(done) || 0;
          notify();
        }))
        .then(task.resolve, task.reject)
        .finally(() => {
          running.delete(task.order);
          notify();
          pump();
        });
    }
    notify();
  }

  function enqueue(run, { priority = UPLOAD_PRIORITY.NORMAL, label = '', size = 0 } = {}) {
    return new Promise((resolve, reject) => {
      sequence += 1;
      waiting.push({ run, priority, label, size, done: 0, order: sequence, resolve, reject });
      pump();
    });
  }

  return { enqueue, state };
}
