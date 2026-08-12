# Project Log

## 2026-08-12 — BookOrbit SmartScope download queues

- Extended the existing BookOrbit integration with separate OPDS credentials and SmartScope discovery.
- Reused Readest's OPDS auto-download infrastructure and CWA queue defaults: target 10 available unread/reading books per selected scope, up to 3 downloads per sync by default, serial downloads with the existing delay, and a six-hour startup interval.
- Added SmartScope browse links, manual sync, pull-to-refresh sync, source tagging, encrypted credential sync, and credential-free backup handling.
- Added focused coverage for discovery, authentication requirements, queue limits, source tagging, and full-queue behavior.
- Validation: TypeScript/Biome lint passed across 2,013 files; 180 focused tests passed; the production web build passed. The full suite passed 9,012 tests and had five unrelated failures (one stale 0.12.9 version assertion, three native-service timeouts, and one native-share mock count after the timeout-heavy run).
- Live validation with Kelvin's BookOrbit OPDS account and a packaged Readest build remains required before release.
