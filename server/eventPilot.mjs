function validateEvent(event) {
  if (typeof event !== 'string' || !event.trim()) throw new TypeError('Event name must be a nonempty string.');
}

export function createEventPilot() {
  const registrations = new Map();
  const pending = new Set();
  let closed = false;
  let closing;

  function assertOpen() {
    if (closed) throw new Error('Event Pilot is closed.');
  }

  function remove(event, registration) {
    const listeners = registrations.get(event);
    listeners?.delete(registration);
    if (listeners?.size === 0) registrations.delete(event);
  }

  return {
    on(event, listener, { once = false } = {}) {
      assertOpen();
      validateEvent(event);
      if (typeof listener !== 'function') throw new TypeError('Event listener must be a function.');
      if (typeof once !== 'boolean') throw new TypeError('Listener once option must be a boolean.');
      const registration = { listener, once };
      if (!registrations.has(event)) registrations.set(event, new Set());
      registrations.get(event).add(registration);
      return () => remove(event, registration);
    },

    async publish(event, payload) {
      assertOpen();
      validateEvent(event);
      const snapshot = [...(registrations.get(event) ?? [])];
      // Claim one-shot listeners before invoking any callbacks or concurrent publications.
      for (const registration of snapshot) {
        if (registration.once) remove(event, registration);
      }
      const task = Promise.allSettled(snapshot.map(({ listener }, index) => Promise.resolve()
        .then(() => listener(payload, event))
        .catch((error) => {
          console.error('Event Pilot listener failed:', event, index, error?.code ?? error?.name ?? 'UnknownError');
          throw error;
        })));
      pending.add(task);
      try {
        return await task;
      } finally {
        pending.delete(task);
      }
    },

    close() {
      if (!closing) {
        closed = true;
        registrations.clear();
        closing = Promise.all([...pending]).then(() => {});
      }
      return closing;
    },
  };
}
