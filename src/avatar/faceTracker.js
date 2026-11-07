// Face tracker: MediaPipe Face Landmarker loaded on demand. The WASM runtime is served from this app
// (copied from the npm package by scripts/sync-mediapipe.mjs); the 3.6 MB landmark model is read from
// /models/face_landmarker.task when present, otherwise fetched once from Google's model bucket and kept in
// the Cache Storage so later sessions work offline.

export const WASM_BASE = '/mediapipe/wasm';
export const LOCAL_MODEL_URL = '/models/face_landmarker.task';
export const REMOTE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
export const MODEL_CACHE = 'relay-face-models-v1';

let trackerPromise = null;

// Finds the model bytes: local file, then cache, then network (cached for next time).
export async function loadModelBuffer({ fetchImpl = globalThis.fetch, cacheStorage = globalThis.caches, localUrl = LOCAL_MODEL_URL, remoteUrl = REMOTE_MODEL_URL, onProgress } = {}) {
  const tryLocal = await fetchImpl(localUrl, { cache: 'force-cache' }).catch(() => null);
  if (tryLocal?.ok && /octet-stream|tflite|task/i.test(tryLocal.headers.get('content-type') ?? 'application/octet-stream')) {
    onProgress?.({ source: 'local' });
    return new Uint8Array(await tryLocal.arrayBuffer());
  }
  const cache = cacheStorage ? await cacheStorage.open(MODEL_CACHE).catch(() => null) : null;
  const cached = cache ? await cache.match(remoteUrl).catch(() => null) : null;
  if (cached) {
    onProgress?.({ source: 'cache' });
    return new Uint8Array(await cached.arrayBuffer());
  }
  onProgress?.({ source: 'network' });
  const response = await fetchImpl(remoteUrl);
  if (!response.ok) throw new Error('The face model could not be downloaded. Check your connection and try again.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (cache) await cache.put(remoteUrl, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return bytes;
}

// One shared tracker per page; callers hold a `release()` and the last one closes it.
export function loadFaceTracker({ onProgress } = {}) {
  if (!trackerPromise) {
    trackerPromise = (async () => {
      onProgress?.({ stage: 'runtime' });
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      onProgress?.({ stage: 'model' });
      const modelAssetBuffer = await loadModelBuffer({ onProgress });
      onProgress?.({ stage: 'init' });
      let landmarker;
      try {
        landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      } catch {
        landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      }
      let users = 0;
      let lastTimestamp = -1;
      const tracker = {
        // MediaPipe requires strictly increasing timestamps per video stream.
        detect(video, timestampMs) {
          const ts = Math.max(Math.floor(timestampMs), lastTimestamp + 1);
          lastTimestamp = ts;
          return landmarker.detectForVideo(video, ts);
        },
        acquire() { users += 1; return () => { users -= 1; }; },
        get users() { return users; },
        close() { try { landmarker.close(); } catch {} trackerPromise = null; },
      };
      return tracker;
    })().catch((error) => { trackerPromise = null; throw error; });
  }
  return trackerPromise;
}

export function resetFaceTrackerForTests() {
  trackerPromise = null;
}
