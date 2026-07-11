# e2e smoke (manual diagnostic tool)

`smoke.mjs` launches a real Chromium via Playwright with the built `chrome-mv3`
extension loaded, visits a known-green control video and a known ad-free video, and
dumps the extension's console output, storage (history, calibration, rewatch index,
session summaries), and per-tab badge state. It is the fastest way to see what the
extension actually does on live YouTube — the automated Vitest suite cannot observe
badge painting, service-worker lifecycle, or YouTube's real markup.

Not wired into CI (it hits live YouTube and needs a real browser). Run it manually:

```bash
npm run build                       # produce .output/chrome-mv3 first
npm i --no-save playwright          # not a project dependency on purpose
npx playwright install chromium
node test/e2e/smoke.mjs
```

Hard-won lessons encoded here (2026-07-11 field debugging):

- **Stale service worker**: with a persistent profile, Chrome can keep executing the
  OLD background service worker even though `--load-extension` points at freshly
  rebuilt files. If behavior doesn't match the source, delete the profile directory
  (`test/e2e/profile/`) — and when loading unpacked in a normal Chrome, REMOVE the
  extension and re-add it rather than trusting the reload button. The manifest
  version shown on `chrome://extensions` is the reliable tell of which build runs.
- Playwright cannot capture the extension service worker's `console.*` reliably;
  instrument via `chrome.storage` writes or by monkeypatching `chrome.action.*` from
  a service-worker `evaluate()` instead.
- The profile persists between runs: second visits of the same video exercise the
  rewatch path, not the fresh path. Delete the profile for a clean-slate run.
