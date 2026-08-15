# Project Log

## 2026-08-15 — Lifetime plan restoration and library integration controls

- Restored `getUserProfilePlan()` to JWT-based plan resolution, including the existing purchased-storage fallback to the Lifetime (`purchase`) plan; removed the private always-Pro override.
- Hardened BookOrbit SmartScope downloads by checking each OPDS candidate against the authenticated BookOrbit catalog detail API, always excluding `read` and `skimmed`, and ranking eligible candidates by publication date/year before the feed's added-date order.
- Added a CWA Disconnect action that clears only the CWA server, credentials, and subscriptions while preserving local library books and other integrations.
- Validation: 51 focused access, CWA, BookOrbit, proxy, and OPDS auto-download tests passed; TypeScript/Biome lint passed across 2,043 files; the optimized Tauri frontend production build passed. Live BookOrbit account behavior and packaged Android UI remain to be smoke-tested before release.
- No commit, push, release, updater publication, or device deployment was performed.

## 2026-08-12 — BookOrbit SmartScope download queues

- Extended the existing BookOrbit integration with separate OPDS credentials and SmartScope discovery.
- Reused Readest's OPDS auto-download infrastructure and CWA queue defaults: target 10 available unread/reading books per selected scope, up to 3 downloads per sync by default, serial downloads with the existing delay, and a six-hour startup interval.
- Added SmartScope browse links, manual sync, pull-to-refresh sync, source tagging, encrypted credential sync, and credential-free backup handling.
- Added focused coverage for discovery, authentication requirements, queue limits, source tagging, and full-queue behavior.
- Validation: TypeScript/Biome lint passed across 2,013 files; 180 focused tests passed; the production web build passed. The full suite passed 9,012 tests and had five unrelated failures (one stale 0.12.9 version assertion, three native-service timeouts, and one native-share mock count after the timeout-heavy run).
- Live validation with Kelvin's BookOrbit OPDS account and a packaged Readest build remains required before release.

## 2026-08-12 — Upstream integration refresh

- Merged `upstream/main` at `42c7a2cb`, retaining the private CWA and BookOrbit integrations while adding upstream LocalSend in the shared Integrations panel.
- Confirmed library pull-to-refresh continues to run enabled CWA and BookOrbit subscription syncs independently.
- Retained upstream OPDS format filtering and Android/TV changes, and advanced the `foliate-js` and `tao` submodule pointers supplied by upstream.
- Replaced the stale Android release test's exact `0.12.9` assertion with a minimum corrected-version check so later app versions remain valid.
- Validation: 163 focused BookOrbit/CWA/OPDS/settings tests passed; 23 Android/TV tests passed; TypeScript/Biome lint passed across 2,042 files; and the production web build passed.
- The APK release workflow was not dispatched; packaged-app and live-device validation remain release steps.
