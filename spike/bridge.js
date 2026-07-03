// AdsAuditor — Phase 0 spike, ISOLATED-world content script.
//
// Bridges records from the MAIN-world interceptor (interceptor.js) to the service
// worker. Validates the message's origin and a per-page session token before relaying
// anything, per SPEC.md §3.2 ("strict origin checking and a session token").
//
// THROWAWAY SPIKE CODE (Phase 0): plain JS, no build step, no TypeScript.

(() => {
  'use strict';

  if (window.__adsauditorSpikeBridgeLoaded) return;
  window.__adsauditorSpikeBridgeLoaded = true;

  const CHANNEL = 'adsauditor-spike';

  // JS globals are NOT shared between the MAIN and ISOLATED worlds, but the DOM is —
  // so the token is published as a data attribute on <html> for interceptor.js to read.
  const SESSION_TOKEN = (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  document.documentElement.dataset.adsauditorToken = SESSION_TOKEN;

  window.addEventListener('message', (event) => {
    // Reject anything not posted by same-page same-origin script (no iframes, no
    // cross-origin senders).
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    if (data.token !== SESSION_TOKEN) return;
    if (data.type !== 'PLAYER_RESPONSE_RECORD' && data.type !== 'DOM_AD_EVENT') return;

    try {
      chrome.runtime.sendMessage({
        kind: 'ADSAUDITOR_SPIKE_RECORD',
        payload: data.payload,
      });
    } catch (err) {
      // Extension context can be invalidated after a reload during development; this
      // is throwaway tooling, so we just log and move on rather than trying to recover.
      console.warn('[AdsAuditor Spike] Failed to relay record to background', err);
    }
  });
})();
