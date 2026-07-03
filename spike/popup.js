// AdsAuditor — Phase 0 spike, popup script.
//
// Reads chrome.storage.local directly for the counter/export (simple, no race risk).
// "Clear data" is routed through the service worker's serialized write queue instead
// of calling chrome.storage.local.remove() here directly, so it cannot race an
// in-flight append from the background script (see background.js's queueClear()).
//
// THROWAWAY SPIKE CODE (Phase 0): plain JS, no build step, no TypeScript.

'use strict';

const STORAGE_KEY = 'adsauditor_spike_records';

const countEl = document.getElementById('record-count');
const statusEl = document.getElementById('status');
const exportBtn = document.getElementById('export-btn');
const clearBtn = document.getElementById('clear-btn');

async function getRecords() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

async function refreshCount() {
  const records = await getRecords();
  countEl.textContent = String(records.length);
  return records;
}

exportBtn.addEventListener('click', async () => {
  const records = await getRecords();
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = `adsauditor-spike-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  // Plain anchor download: no "downloads" permission needed, keeping the manifest
  // scoped to the minimum permissions listed for this spike.
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  statusEl.textContent = `Exported ${records.length} record(s) to ${filename}`;
});

clearBtn.addEventListener('click', async () => {
  statusEl.textContent = 'Clearing…';
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'ADSAUDITOR_SPIKE_CLEAR' });
    statusEl.textContent = response && response.ok
      ? 'Data cleared.'
      : `Clear failed: ${(response && response.error) || 'unknown error'}`;
  } catch (err) {
    statusEl.textContent = `Clear failed: ${err.message}`;
  }
  refreshCount();
});

refreshCount();
