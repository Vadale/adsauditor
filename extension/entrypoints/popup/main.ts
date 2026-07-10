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
import { confidenceMessageKeyForSourceCount } from '../../utils/evidence-summary';
import { LOCAL_HISTORY_KEY } from '../../utils/storage-keys';
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

function renderCurrentState(state: TabStateResponse | null): void {
  const chipEl = document.getElementById('state-chip') as HTMLElement;
  const headlineEl = document.getElementById('state-headline') as HTMLElement;
  const detailEl = document.getElementById('state-detail') as HTMLElement;
  const disclaimerEl = document.getElementById('state-disclaimer') as HTMLElement;
  const ssaiEl = document.getElementById('state-ssai') as HTMLElement;
  const causeSectionEl = document.getElementById('no-signal-cause') as HTMLElement;
  const causeTextEl = document.getElementById('no-signal-cause-text') as HTMLElement;
  const evidenceSectionEl = document.getElementById('evidence-section') as HTMLElement;

  chipEl.hidden = true;
  detailEl.hidden = true;
  detailEl.textContent = '';
  disclaimerEl.hidden = true;
  disclaimerEl.textContent = '';
  ssaiEl.hidden = true;
  ssaiEl.textContent = '';
  causeSectionEl.hidden = true;
  causeTextEl.textContent = '';

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
    headlineEl.textContent = browser.i18n.getMessage('headlineAdsServed');
    const evidence = result.evidence ?? null;
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

  let historyEntries: LocalHistoryEntry[] = [];
  searchInput.addEventListener('input', () => {
    renderHistory(historyEntries, searchInput.value);
  });

  const [state, entries] = await Promise.all([queryActiveTabState(), loadHistory()]);
  renderCurrentState(state);
  historyEntries = entries;
  renderHistory(historyEntries, searchInput.value);
}

void init();
