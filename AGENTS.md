# Readest CWA

- Treat `D:\src\readest-cwa` as the sole authoritative editable checkout and active project-continuity location.
- Preserve upstream Readest behavior while maintaining Kelvin's private CWA, Android TV, and BookOrbit integrations.
- Keep credentials out of source, tests, logs, and documentation. Use persisted application settings and test fixtures only.
- Prefer shared OPDS/download infrastructure over provider-specific duplicate downloaders. Keep CWA and BookOrbit credentials, source metadata, and user-facing labels distinct.
- For library subscription changes, verify focused provider tests, OPDS auto-download tests, TypeScript/lint, and the relevant production build when practical.
- Do not publish, push, create releases, or deploy without Kelvin's explicit authorization.
- Keep the single active project history in `PROJECT_LOG.md`; do not create a parallel continuity folder or second project log elsewhere.
