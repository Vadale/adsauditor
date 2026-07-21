# Non-negotiable invariants

These encode the project's credibility. Violating any of them is a bug regardless of tests passing:

1. **Local-first**: the extension is fully functional with telemetry off. Opt-in is explicit, default OFF, revocable.
2. **Minimal payload**: telemetry contains only video ID, observed state, and the context schema in `docs/SPEC.md` §3.3. No history, no watch time, no user identifiers beyond the local pseudonymous UUID. A test must fail if the stored/sent payload gains fields.
3. **No raw IPs**: server sees IPs only inside the ingest function; only `HMAC(IP, daily_salt)` is persisted (30-day retention).
4. **Honest language**: UI and dashboard say "ad delivery status", never "demonetized" as a fact, never "the creator earns/doesn't earn". Inferred states always ship with confidence + observer count.
5. **NO_SIGNAL discipline**: observations from Premium/adblock/uncalibrated observers are never written as `NO_ADS`.
6. **Observation only**: the extension never blocks, modifies, or injects ads or page content.
7. **Minimal permissions**: manifest host permissions limited to youtube.com, doubleclick.net, googlesyndication.com. Any new permission requires an explicit justification in the PR.

*These are product guarantees, not style preferences: the extension's
credibility rests on them. Code comments across the repo cite them by number.*
