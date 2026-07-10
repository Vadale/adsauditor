import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
//
// CLAUDE.md invariant 7: host_permissions are limited to youtube.com, doubleclick.net,
// and googlesyndication.com. Any addition requires an explicit justification in the PR.
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'AdsAuditor',
    description:
      'Observes whether YouTube is actually serving ads on the video you are watching. Local-first, opt-in telemetry.',
    // ROADMAP §1.4: popup/options strings ship as _locales messages (English source,
    // Italian translation) rather than hardcoded literals. Not a permission change.
    default_locale: 'en',
    permissions: ['storage', 'webRequest'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://googleads.g.doubleclick.net/*',
      'https://*.googlesyndication.com/*',
    ],
    browser_specific_settings: {
      gecko: {
        // TODO(§5.1): replace with the real add-on id before the first Firefox AMO submission.
        id: 'adsauditor@adsauditor.org',
        // world: "MAIN" content scripts require Firefox >= 128 (docs/SPEC.md §3.2).
        strict_min_version: '128.0',
        // TODO(§5.1): AMO requires `data_collection_permissions` for new extensions
        // (since 2025-11-03) — wxt build -b firefox currently warns about this. Fill it
        // in once the opt-in telemetry payload (§2.4) and docs/PRIVACY.md exist; do not
        // suppress the warning before then.
      },
    },
  },
});
