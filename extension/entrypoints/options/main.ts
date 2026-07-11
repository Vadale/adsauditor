/**
 * Options page (ROADMAP §1.4): read-only local-first explainer + calibration status
 * readout from `local:adsauditor_calibration` (ROADMAP §1.3 debug info). NO_SIGNAL
 * notices in the popup link here. No controls: the extension is local-only with no
 * telemetry (docs/PRIVACY.md §4) — an opt-in toggle only ever appears here if the
 * descoped shared-observatory direction is revived.
 */
import './style.css';
import { EMPTY_CALIBRATION_STATE } from '../../utils/calibration';
import type { CalibrationState } from '../../utils/calibration';
import { CALIBRATION_STORAGE_KEY } from '../../utils/storage-keys';
import { formatRelativeTime } from '../../utils/relative-time';

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatAdblockStatus(status: CalibrationState['adblock']): string {
  if (!status) return browser.i18n.getMessage('calibrationNeverChecked');
  const statusKey =
    status.status === 'clear'
      ? 'calibrationStatusClear'
      : status.status === 'blocked'
        ? 'calibrationStatusBlocked'
        : 'calibrationStatusInconclusive';
  return `${browser.i18n.getMessage(statusKey)} · ${formatRelativeTime(status.checkedAt)}`;
}

function formatPremiumStatus(status: CalibrationState['premium']): string {
  if (!status) return browser.i18n.getMessage('calibrationNeverChecked');
  const statusKey = status.detected
    ? 'calibrationPremiumDetected'
    : 'calibrationPremiumNotDetected';
  return `${browser.i18n.getMessage(statusKey)} · ${formatRelativeTime(status.checkedAt)}`;
}

function formatTimestampOrNever(timestamp: number | null): string {
  return timestamp === null
    ? browser.i18n.getMessage('calibrationNever')
    : formatRelativeTime(timestamp);
}

async function init(): Promise<void> {
  setText('options-heading', browser.i18n.getMessage('optionsHeading'));
  setText('options-intro', browser.i18n.getMessage('optionsIntro'));
  setText('calibration-title', browser.i18n.getMessage('calibrationSectionTitle'));
  setText('calibration-adblock-label', browser.i18n.getMessage('calibrationAdblockLabel'));
  setText('calibration-premium-label', browser.i18n.getMessage('calibrationPremiumLabel'));
  setText(
    'calibration-last-positive-label',
    browser.i18n.getMessage('calibrationLastPositiveLabel'),
  );
  setText(
    'calibration-last-failure-label',
    browser.i18n.getMessage('calibrationLastControlFailureLabel'),
  );

  const calibration =
    (await storage.getItem<CalibrationState>(CALIBRATION_STORAGE_KEY)) ?? EMPTY_CALIBRATION_STATE;

  setText('calibration-adblock-value', formatAdblockStatus(calibration.adblock));
  setText('calibration-premium-value', formatPremiumStatus(calibration.premium));
  setText(
    'calibration-last-positive-value',
    formatTimestampOrNever(calibration.lastPositiveEvidenceAt),
  );
  setText(
    'calibration-last-failure-value',
    formatTimestampOrNever(calibration.lastControlFailureAt),
  );
}

void init();
