// AdsAuditor e2e smoke: load the unpacked chrome-mv3 build in real Chromium, visit a
// known-green control video and a known ad-free video, dump extension console output,
// storage, and badge state. Diagnostic tool for the owner-reported "completely broken".
import { chromium } from 'playwright';
import path from 'node:path';

const EXT = path.join(import.meta.dirname, '../../.output/chrome-mv3');
const PROFILE = path.join(import.meta.dirname, 'profile');
const GREEN = 'https://www.youtube.com/watch?v=mvcesPWvUIc'; // Veritasium, control list
const ADFREE = 'https://www.youtube.com/watch?v=j61hDDHfphM'; // Elisa uncensored, owner-reported

const logs = [];
const note = (tag, msg) => {
  const line = `[${tag}] ${msg}`;
  logs.push(line);
  console.log(line);
};

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=en-US',
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
note('sw', sw ? `service worker up: ${sw.url()}` : 'SERVICE WORKER NEVER STARTED');
if (sw) sw.on('console', (m) => note(`sw-console-${m.type()}`, m.text()));

const page = context.pages()[0] ?? (await context.newPage());
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || t.includes('AdsAuditor')) note(`page-${m.type()}`, t.slice(0, 300));
});
page.on('pageerror', (e) => note('page-exception', String(e).slice(0, 300)));

async function dismissConsent() {
  for (const label of ['Reject all', 'Rifiuta tutto', 'Accept all', 'Accetta tutto']) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      note('consent', `clicked "${label}"`);
      await page.waitForTimeout(2500);
      return;
    }
  }
  note('consent', 'no consent dialog seen');
}

async function dumpState(label) {
  if (!sw) return;
  const state = await sw
    .evaluate(async () => {
      const local = await chrome.storage.local.get(null);
      const session = await chrome.storage.session.get(null).catch(() => ({}));
      const tabs = await chrome.tabs.query({ active: true });
      const tabId = tabs[0]?.id;
      let badgeText = null;
      let badgeColor = null;
      if (tabId !== undefined) {
        badgeText = await chrome.action.getBadgeText({ tabId }).catch(() => 'ERR');
        badgeColor = await chrome.action.getBadgeBackgroundColor({ tabId }).catch(() => 'ERR');
      }
      const sessions = session['adsauditor_sessions'] ?? {};
      const sessionSummary = Object.fromEntries(
        Object.entries(sessions).map(([tid, s]) => [
          tid,
          {
            videoId: s.videoId,
            currentPageVideoId: s.currentPageVideoId,
            recentlyWatched: s.recentlyWatched,
            eventCounts: s.events.reduce((acc, e) => {
              const k =
                e.source === 'PLAYER_RESPONSE'
                  ? `PR:${e.capturePath}:${e.adPlacements.length}pl`
                  : e.source === 'DOM'
                    ? `DOM:${e.kind}`
                    : `BEACON:${e.kind}`;
              acc[k] = (acc[k] ?? 0) + 1;
              return acc;
            }, {}),
          },
        ]),
      );
      return {
        tabId,
        badgeText,
        badgeColor,
        calibration: local['adsauditor_calibration'] ?? null,
        history: (local['adsauditor_history'] ?? []).map((h) => ({
          videoId: h.videoId,
          state: h.state,
          cause: h.noSignalCause,
          evidence: h.evidence
            ? {
                pre: h.evidence.preroll,
                mid: h.evidence.midrolls,
                post: h.evidence.postroll,
                src: h.evidence.sources,
                ssai: h.evidence.ssaiAnomalySuspected,
              }
            : null,
        })),
        rewatchIndex: local['adsauditor_rewatch_index'] ?? null,
        sessionSummary,
      };
    })
    .catch((e) => ({ error: String(e) }));
  note(`state:${label}`, JSON.stringify(state, null, 1));
}

try {
  note('nav', `goto ${GREEN}`);
  await page.goto(GREEN, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  await dismissConsent();
  // Nudge playback in case autoplay was blocked.
  await page.keyboard.press('k').catch(() => {});
  await page.waitForTimeout(22000);
  await dumpState('green-video');

  note('nav', `goto ${ADFREE}`);
  await page.goto(ADFREE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  await page.keyboard.press('k').catch(() => {});
  await page.waitForTimeout(18000);
  await dumpState('adfree-video');
} catch (e) {
  note('fatal', String(e));
} finally {
  await context.close();
}
