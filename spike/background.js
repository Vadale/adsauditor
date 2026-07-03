// AdsAuditor — Phase 0 spike, service worker.
//
// MV3 note: the message listener must be registered synchronously at the top level of
// this file — the service worker can be re-spawned per event, and only statically
// registered listeners are guaranteed to receive the event that woke it up.
//
// THROWAWAY SPIKE CODE (Phase 0): plain JS, no build step, no TypeScript.

'use strict';

const STORAGE_KEY = 'adsauditor_spike_records';
const FLUSH_DEBOUNCE_MS = 150;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.kind !== 'string') return false;

  if (message.kind === 'ADSAUDITOR_SPIKE_RECORD') {
    if (message.payload) queueAppend(message.payload);
    return false; // fire and forget, no async response expected by the sender
  }

  if (message.kind === 'ADSAUDITOR_SPIKE_CLEAR') {
    // Routed through the SAME serialized queue as appends (see enqueue() below) so a
    // "Clear data" click from the popup can never race an in-flight append — a direct
    // chrome.storage.local.remove() from the popup could otherwise land between another
    // write's own get() and set(), resurrecting the records the clear meant to wipe.
    queueClear()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async sendResponse above
  }

  return false;
});

let writeQueue = Promise.resolve();
let pendingRecords = [];
let flushTimer = null;

// Serializes every storage-mutating task behind a single promise chain. A rejected task
// (e.g. QUOTA_BYTES exceeded — records can still add up even trimmed, across ~30 videos
// x 3 capture paths x 2 collection passes) must not permanently poison the chain, or
// every later append would be silently dropped for the rest of the run. Re-deriving
// writeQueue through a .catch() below keeps it always-settling regardless of outcome.
function enqueue(task) {
  const resultPromise = writeQueue.then(task);
  writeQueue = resultPromise.catch((err) => {
    console.error('[AdsAuditor Spike] Storage write failed', err);
  });
  return resultPromise;
}

function queueAppend(payload) {
  pendingRecords.push({ ...payload, storedAt: new Date().toISOString() });
  if (flushTimer) return;
  // Several records often arrive within the same tick (e.g. the initial/fetch/
  // getPlayerResponse trio on one navigation, or a burst of ad badge sightings):
  // batch them into a single get+set instead of one storage round trip per record.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = pendingRecords;
    pendingRecords = [];
    enqueue(async () => {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const records = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
      records.push(...batch);
      await chrome.storage.local.set({ [STORAGE_KEY]: records });
    });
  }, FLUSH_DEBOUNCE_MS);
}

function queueClear() {
  // Drop anything not yet flushed so it doesn't reappear after the clear completes.
  pendingRecords = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return enqueue(() => chrome.storage.local.remove(STORAGE_KEY));
}
