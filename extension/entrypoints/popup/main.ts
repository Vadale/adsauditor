/**
 * Popup UI (ROADMAP §1.4): current-video state chip + honest-language headline,
 * per-source evidence list, and searchable local history. Vanilla DOM, no framework
 * (decided stack) — all copy goes through browser.i18n.getMessage (§1.4d).
 *
 * Rendering discipline: every value that ultimately comes from storage or from the
 * page (videoId, evidence, etc.) is written via `textContent`/DOM APIs, never
 * `innerHTML` — a videoId is attacker-influenced page data in principle.
 */
import './style.css';
import { runtimeMessageKinds } from '../../utils/selectors';
import { formatRelativeTime } from '../../utils/relative-time';
import {
  adPlaybackObserved,
  confidenceMessageKeyForSourceCount,
} from '../../utils/evidence-summary';
import { buildLocalExport } from '../../utils/local-export';
import type { LocalExport } from '../../utils/local-export';
import { EMPTY_CALIBRATION_STATE } from '../../utils/calibration';
import type { CalibrationState } from '../../utils/calibration';
import { CALIBRATION_STORAGE_KEY, LOCAL_HISTORY_KEY } from '../../utils/storage-keys';
import { isRecord } from '../../utils/types';
import type {
  AdEvidenceDetail,
  ClassificationResult,
  EvidenceSource,
  LocalHistoryEntry,
  NoSignalCause,
  ObservedState,
} from '../../utils/types';

interface TabStateResponse {
  videoId: string;
  result: ClassificationResult;
}

function isTabStateResponse(value: unknown): value is TabStateResponse {
  return isRecord(value) && typeof value.videoId === 'string' && isRecord(value.result);
}

/** WXT's i18n typegen (`wxt prepare`, from public/_locales/en/messages.json) overloads
 * `getMessage` with one literal-string signature per known key and NO generic `string`
 * fallback — so a `Record<X, string>` lookup used as an argument fails to typecheck.
 * `Parameters<>` on an overloaded function type resolves to its LAST signature, which is
 * exactly the full keys-union overload; reusing it here keeps these message-key maps
 * checked against the real generated key set instead of widening to `string`. */
type I18nMessageKey = Parameters<typeof browser.i18n.getMessage>[0];

const STATE_CHIP_CLASS: Record<ObservedState, string> = {
  ADS_SERVED: 'state-chip--ads-served',
  NO_ADS: 'state-chip--no-ads',
  NO_SIGNAL: 'state-chip--no-signal',
  UNAVAILABLE: 'state-chip--unavailable',
};

const STATE_CHIP_MESSAGE_KEY: Record<ObservedState, I18nMessageKey> = {
  ADS_SERVED: 'stateChipAdsServed',
  NO_ADS: 'stateChipNoAds',
  NO_SIGNAL: 'stateChipNoSignal',
  UNAVAILABLE: 'stateChipUnavailable',
};

/**
 * Renders `state` into a state-chip element defensively (ROADMAP §1.4 review fix).
 * `state` is statically typed as ObservedState, but its actual value can come from
 * chrome.storage (a history entry written by a past, possibly mismatched, extension
 * version) or a runtime message (the live tabStateQuery response) — neither boundary
 * runtime-validates that the string is still one of the four current values. A miss
 * here previously threw inside `.map()` and blanked the entire section; now it renders
 * a generic gray chip showing the raw state string via textContent (never innerHTML,
 * never thrown).
 */
function applyStateChip(chipEl: HTMLElement, state: ObservedState, extraClass?: string): void {
  const classes = ['state-chip'];
  if (extraClass) classes.push(extraClass);
  if (state in STATE_CHIP_CLASS) {
    classes.push(STATE_CHIP_CLASS[state]);
    chipEl.className = classes.join(' ');
    chipEl.textContent = browser.i18n.getMessage(STATE_CHIP_MESSAGE_KEY[state]);
  } else {
    classes.push('state-chip--unknown');
    chipEl.className = classes.join(' ');
    chipEl.textContent = state;
  }
}

/** Exhaustive over the current NoSignalCause union (SPEC §3.4 / ROADMAP §1.3's four
 * ObserverInvalidCause values plus the three classifier-level causes). A value read
 * back from LocalHistoryEntry storage is only *typed* as NoSignalCause — it isn't
 * runtime-validated at that boundary — so noSignalCauseMessageKey() below still falls
 * back to the generic message for anything not in this map (e.g. a cause retired by a
 * future extension version). */
const NO_SIGNAL_CAUSE_MESSAGE_KEY: Record<NoSignalCause, I18nMessageKey> = {
  'adblock-suspected': 'causeAdblockSuspected',
  'premium-suspected': 'causePremiumSuspected',
  'calibration-failed': 'causeCalibrationFailed',
  uncalibrated: 'causeUncalibrated',
  'recent-rewatch': 'causeRecentRewatch',
  'no-player-response': 'causeNoPlayerResponse',
  'anomalous-beacon-only': 'causeAnomalousBeaconOnly',
};

function noSignalCauseMessageKey(cause: NoSignalCause | undefined): I18nMessageKey {
  if (cause !== undefined && cause in NO_SIGNAL_CAUSE_MESSAGE_KEY) {
    return NO_SIGNAL_CAUSE_MESSAGE_KEY[cause];
  }
  return 'causeGeneric';
}

/** Same defensive pattern as applyStateChip: `state` is a value read back out of
 * chrome.storage, only *typed* as ObservedState — an unrecognized string (legacy/
 * mismatched-version data) falls back to the raw string rather than indexing
 * STATE_CHIP_MESSAGE_KEY with an unknown key. */
function stateLabel(state: ObservedState): string {
  return state in STATE_CHIP_MESSAGE_KEY
    ? browser.i18n.getMessage(STATE_CHIP_MESSAGE_KEY[state])
    : state;
}

/**
 * Finds the informative (state !== 'NO_SIGNAL') history entry for `videoId`, if one is
 * stored (ROADMAP §1.6, owner-reported rewatch bug). History is deduped to at most one
 * entry per videoId (utils/local-history.ts), and upsertLocalHistoryEntry() never lets a
 * NO_SIGNAL observation overwrite an existing informative one for the same video. A
 * stored NO_SIGNAL entry therefore usually means no informative entry existed — though
 * not with certainty: the 50-entry cap can evict an old informative entry, after which
 * a later NO_SIGNAL stores fresh. The consequence is only a missing "last valid
 * observation" line. Returns null in that case: there is nothing valid to show.
 */
function findLastInformativeHistoryEntry(
  entries: LocalHistoryEntry[],
  videoId: string,
): LocalHistoryEntry | null {
  const entry = entries.find((e) => e.videoId === videoId);
  return entry && entry.state !== 'NO_SIGNAL' ? entry : null;
}

async function queryActiveTabState(): Promise<TabStateResponse | null> {
  try {
    // Tab id is available WITHOUT the "tabs" permission (CLAUDE.md invariant 7); url/
    // title are intentionally never read here (they'd be undefined without it anyway).
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number') return null;
    const response: unknown = await browser.runtime.sendMessage({
      kind: runtimeMessageKinds.tabStateQuery,
      tabId: tab.id,
    });
    return isTabStateResponse(response) ? response : null;
  } catch (err) {
    console.warn('[AdsAuditor] Failed to query active tab state', err);
    return null;
  }
}

function renderEvidenceSection(evidence: AdEvidenceDetail | null): void {
  const listEl = document.getElementById('evidence-list') as HTMLUListElement;
  const confidenceEl = document.getElementById('confidence-line') as HTMLElement;
  const sources = evidence?.sources ?? [];

  const rows: Array<{ labelKey: I18nMessageKey; source: EvidenceSource }> = [
    { labelKey: 'evidenceSourcePlayerResponse', source: 'PLAYER_RESPONSE' },
    { labelKey: 'evidenceSourceDom', source: 'DOM' },
    { labelKey: 'evidenceSourceBeacons', source: 'BEACON' },
  ];

  listEl.replaceChildren(
    ...rows.map(({ labelKey, source }) => {
      const li = document.createElement('li');
      li.className = 'evidence-row';

      const label = document.createElement('span');
      label.className = 'evidence-label';
      label.textContent = browser.i18n.getMessage(labelKey);

      const marker = document.createElement('span');
      marker.className = 'evidence-marker';
      marker.textContent = evidence
        ? browser.i18n.getMessage(sources.includes(source) ? 'evidencePresent' : 'evidenceAbsent')
        : browser.i18n.getMessage('evidenceNotApplicable');

      li.append(label, marker);
      return li;
    }),
  );

  // Never a percentage: nothing is calibrated yet (ROADMAP §1.4) — a qualitative line
  // derived purely from how many of the three sources agreed. Bucketing itself is the
  // pure confidenceMessageKeyForSourceCount() (utils/evidence-summary.ts); only the
  // browser.i18n.getMessage lookup happens here.
  confidenceEl.textContent = evidence
    ? browser.i18n.getMessage(confidenceMessageKeyForSourceCount(sources.length))
    : '';
}

function renderCurrentState(
  state: TabStateResponse | null,
  historyEntries: LocalHistoryEntry[],
): void {
  const chipEl = document.getElementById('state-chip') as HTMLElement;
  const headlineEl = document.getElementById('state-headline') as HTMLElement;
  const detailEl = document.getElementById('state-detail') as HTMLElement;
  const disclaimerEl = document.getElementById('state-disclaimer') as HTMLElement;
  const ssaiEl = document.getElementById('state-ssai') as HTMLElement;
  const adDecisionNoteEl = document.getElementById('state-ad-decision-note') as HTMLElement;
  const causeSectionEl = document.getElementById('no-signal-cause') as HTMLElement;
  const causeTextEl = document.getElementById('no-signal-cause-text') as HTMLElement;
  const lastValidEl = document.getElementById('last-valid-observation') as HTMLElement;
  const evidenceSectionEl = document.getElementById('evidence-section') as HTMLElement;

  chipEl.hidden = true;
  detailEl.hidden = true;
  detailEl.textContent = '';
  disclaimerEl.hidden = true;
  disclaimerEl.textContent = '';
  ssaiEl.hidden = true;
  ssaiEl.textContent = '';
  adDecisionNoteEl.hidden = true;
  adDecisionNoteEl.textContent = '';
  causeSectionEl.hidden = true;
  causeTextEl.textContent = '';
  lastValidEl.hidden = true;
  lastValidEl.textContent = '';

  if (!state) {
    evidenceSectionEl.hidden = true;
    headlineEl.textContent = browser.i18n.getMessage('headlineNoSession');
    renderEvidenceSection(null);
    return;
  }

  evidenceSectionEl.hidden = false;
  const { result } = state;

  chipEl.hidden = false;
  applyStateChip(chipEl, result.state);

  if (result.state === 'ADS_SERVED') {
    const evidence = result.evidence ?? null;
    // ROADMAP §1.6 owner-reported fix: SPEC §3.2 table row 2 ("decision made, playback
    // not observed") is still correctly ADS_SERVED, but showing the SAME "ads served"
    // copy in both cases overstates what was actually witnessed when source A's ad
    // decision has no DOM/beacon corroboration at all. Defensive fallback to "observed"
    // (the pre-existing, unconditional copy) when evidence itself is missing — that
    // should never happen for a real ADS_SERVED result (see AdEvidenceDetail's doc
    // comment), so it is not a case worth inventing new behavior for.
    const playbackObserved = evidence ? adPlaybackObserved(evidence.sources) : true;

    if (playbackObserved) {
      headlineEl.textContent = browser.i18n.getMessage('headlineAdsServed');
      if (evidence) {
        detailEl.hidden = false;
        detailEl.textContent = browser.i18n.getMessage('evidenceDetailLine', [
          browser.i18n.getMessage(evidence.preroll ? 'yesWord' : 'noWord'),
          String(evidence.midrolls),
          browser.i18n.getMessage(evidence.postroll ? 'yesWord' : 'noWord'),
        ]);
        if (evidence.ssaiAnomalySuspected) {
          ssaiEl.hidden = false;
          ssaiEl.textContent = browser.i18n.getMessage('ssaiAnomalyLine');
        }
      }
    } else {
      // Never assert anything about the creator's earnings either way (CLAUDE.md
      // invariant 4) — the note only explains what WE measure (an ad-delivery
      // decision), not what it implies about monetization.
      headlineEl.textContent = browser.i18n.getMessage('headlineAdDecisionOnly');
      adDecisionNoteEl.hidden = false;
      adDecisionNoteEl.textContent = browser.i18n.getMessage('adDecisionOnlyNote');
    }
    renderEvidenceSection(evidence);
  } else if (result.state === 'NO_ADS') {
    headlineEl.textContent = browser.i18n.getMessage('headlineNoAds');
    disclaimerEl.hidden = false;
    disclaimerEl.textContent = browser.i18n.getMessage('noAdsDisclaimer');
    renderEvidenceSection(null);
  } else if (result.state === 'NO_SIGNAL') {
    headlineEl.textContent = browser.i18n.getMessage('headlineNoSignal');
    causeSectionEl.hidden = false;
    causeTextEl.textContent = browser.i18n.getMessage(
      noSignalCauseMessageKey(result.noSignalCause),
    );

    // ROADMAP §1.6 owner-reported fix: a rewatch (or any other NO_SIGNAL cause) on a
    // video this browser already has an informative verdict for must not look like that
    // verdict evaporated — see findLastInformativeHistoryEntry's doc comment for why
    // history is guaranteed to still hold it.
    const lastValid = findLastInformativeHistoryEntry(historyEntries, state.videoId);
    if (lastValid) {
      lastValidEl.hidden = false;
      lastValidEl.textContent = browser.i18n.getMessage('lastValidObservation', [
        stateLabel(lastValid.state),
        formatRelativeTime(lastValid.observedAt),
      ]);
    }
    renderEvidenceSection(null);
  } else {
    // UNAVAILABLE
    headlineEl.textContent = browser.i18n.getMessage('headlineUnavailable');
    renderEvidenceSection(null);
  }
}

async function loadHistory(): Promise<LocalHistoryEntry[]> {
  return (await storage.getItem<LocalHistoryEntry[]>(LOCAL_HISTORY_KEY)) ?? [];
}

function renderHistory(entries: LocalHistoryEntry[], filter: string): void {
  const listEl = document.getElementById('history-list') as HTMLUListElement;
  const emptyEl = document.getElementById('history-empty') as HTMLElement;
  const normalizedFilter = filter.trim().toLowerCase();
  const filtered = normalizedFilter
    ? entries.filter((entry) => entry.videoId.toLowerCase().includes(normalizedFilter))
    : entries;

  if (filtered.length === 0) {
    listEl.replaceChildren();
    emptyEl.hidden = false;
    emptyEl.textContent = browser.i18n.getMessage(
      entries.length === 0 ? 'historyEmpty' : 'historyNoMatches',
    );
    return;
  }
  emptyEl.hidden = true;

  const now = Date.now();
  listEl.replaceChildren(
    ...filtered.map((entry) => {
      const li = document.createElement('li');
      li.className = 'history-row';

      const link = document.createElement('a');
      link.className = 'history-video-id';
      link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(entry.videoId)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.videoId; // textContent only — never innerHTML

      const chip = document.createElement('span');
      applyStateChip(chip, entry.state, 'state-chip--small');

      const time = document.createElement('span');
      time.className = 'history-time';
      time.textContent = formatRelativeTime(entry.observedAt, now);

      li.append(link, chip, time);
      return li;
    }),
  );
}

// ---------------------------------------------------------------------------------
// "Export JSON" (ROADMAP §1.7) — the local counterpart of the Phase 0 spike tool's
// export button (spike/popup.js): Blob + object URL + a clicked, DOM-attached
// `<a download>`. No `downloads` permission (CLAUDE.md invariant 7), no network call —
// the file is written straight to the user's downloads via the browser's own save
// mechanism, and sharing it onward is a separate, manual, voluntary action.
// ---------------------------------------------------------------------------------

function exportFilename(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `adsauditor-export-${datePart}T${timePart}.json`;
}

/** The revoke is deliberately delayed rather than immediate: some browsers can cancel
 * an in-flight download if the object URL backing it is revoked too soon after
 * anchor.click() returns (same timing the spike tool used — spike/popup.js). */
const OBJECT_URL_REVOKE_DELAY_MS = 10_000;

function triggerJsonDownload(payload: LocalExport): void {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFilename(new Date());
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
}

/**
 * Reads history + calibration fresh from storage at click time (not whatever was cached
 * at popup load — the user may have watched something new in the meantime) and builds
 * the shareable export (utils/local-export.ts). Works with an empty history: an empty
 * list is still a truthful, exportable snapshot ("nothing observed yet"), so this never
 * refuses to export on that basis alone — only a genuine storage-read failure is worth
 * surfacing, and even then only as a console warning (the button's disabled state,
 * managed in init(), is the user-visible signal for a broken read).
 */
async function handleExportClick(): Promise<void> {
  try {
    const [history, calibration] = await Promise.all([
      storage.getItem<LocalHistoryEntry[]>(LOCAL_HISTORY_KEY),
      storage.getItem<CalibrationState>(CALIBRATION_STORAGE_KEY),
    ]);
    const payload = buildLocalExport(
      history ?? [],
      calibration ?? EMPTY_CALIBRATION_STATE,
      browser.runtime.getManifest().version,
      Date.now(),
    );
    triggerJsonDownload(payload);
  } catch (err) {
    console.warn('[AdsAuditor] Export JSON failed', err);
  }
}

async function init(): Promise<void> {
  document.getElementById('evidence-title')!.textContent =
    browser.i18n.getMessage('evidenceSectionTitle');
  document.getElementById('history-title')!.textContent = browser.i18n.getMessage('historyTitle');
  const searchInput = document.getElementById('history-search') as HTMLInputElement;
  searchInput.placeholder = browser.i18n.getMessage('historySearchPlaceholder');
  document.getElementById('open-settings-button')!.textContent =
    browser.i18n.getMessage('openSettingsLink');

  document.getElementById('open-settings-button')!.addEventListener('click', () => {
    browser.runtime.openOptionsPage();
  });

  const exportButton = document.getElementById('export-json-button') as HTMLButtonElement;
  exportButton.textContent = browser.i18n.getMessage('exportJson');
  exportButton.title = browser.i18n.getMessage('exportJsonTooltip');
  exportButton.addEventListener('click', () => {
    void handleExportClick();
  });

  let historyEntries: LocalHistoryEntry[] = [];
  searchInput.addEventListener('input', () => {
    renderHistory(historyEntries, searchInput.value);
  });

  // History is awaited BEFORE rendering the current-video state (ROADMAP §1.6):
  // renderCurrentState's NO_SIGNAL branch looks up the current video in history to
  // surface a preserved earlier informative verdict, so it needs historyEntries
  // populated first, not the previous fire-and-forget-then-backfill order.
  let state: TabStateResponse | null = null;
  try {
    const results = await Promise.all([queryActiveTabState(), loadHistory()]);
    state = results[0];
    historyEntries = results[1];
  } catch (err) {
    // queryActiveTabState() already catches its own failures and resolves null (see its
    // own try/catch) — landing here means loadHistory()'s storage.getItem() rejected
    // outright, something more fundamental than "no history yet". ROADMAP §1.7: Export
    // JSON works fine with a genuinely empty history, but a file built while we can't
    // even confirm storage is readable would misrepresent "we don't know" as "nothing
    // observed" — disable the button rather than export a possibly-misleading empty file.
    console.warn('[AdsAuditor] Failed to load popup state', err);
    exportButton.disabled = true;
  }
  renderCurrentState(state, historyEntries);
  renderHistory(historyEntries, searchInput.value);
}

void init();
