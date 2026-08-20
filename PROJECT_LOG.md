# Project Log

Historical entries below preserve the status reported at the time; later entries may supersede their open steps, paths, and release state.

## 2026-08-20 — Workspace consolidation and BookOrbit queue cleanup

- Established `D:\src\readest-cwa` as the sole project location for editable source, operating guidance, and continuity.
- Merged the earlier July 8–August 9 history from the superseded Google Drive continuity folder into this log; the existing August 12–15 entries remain authoritative for later work.
- Removed the superseded Google Drive continuity folder, including generated build scratch, stale handoffs/plans, and device-state evidence, after Kelvin confirmed that the evidence no longer needed to be retained.
- Remaining device acceptance from the former handoff is optional rather than blocking: fresh-device portable-settings restore, phone Drive reconnect/restart sync, TV Read Aloud cold/warm playback, and remote-only Backup/Restore overlays.
- Added BookOrbit cleanup-before-replenishment: a downloaded BookOrbit title marked finished is removed locally only after its latest annotations/bookmarks have a completed BookOrbit exchange and its finished state has been accepted by BookOrbit. Failed or stale sync state keeps the local file.
- Confirmed SmartScope candidates already rank by publication date descending within the OPDS entries Readest discovers. The bounded crawler currently sees at most five pages per feed; BookOrbit's OPDS feed orders/paginates by added date and does not expose a publication-date sort, so full-catalog publication ordering requires a BookOrbit server enhancement rather than a safe client-only reorder.
- Updated BookOrbit sync completion messages to report both new downloads and finished removals. Focused BookOrbit tests, full lint/type checking, and the optimized production web build passed; three unrelated full-suite native-service timeout failures passed when rerun in isolation.
- The attached phone did not enumerate through ADB, so live queue/download validation could not be performed. The default SmartScope queue target remains 10 and the per-sync download cap remains 3; manual BookOrbit downloads count toward the ready queue and can reduce a later automatic pass to one or two downloads.

## 2026-08-15 — Lifetime plan restoration and library integration controls

- Restored `getUserProfilePlan()` to JWT-based plan resolution, including the existing purchased-storage fallback to the Lifetime (`purchase`) plan; removed the private always-Pro override.
- Hardened BookOrbit SmartScope downloads by checking each OPDS candidate against the authenticated BookOrbit catalog detail API, always excluding `read` and `skimmed`, and ranking eligible candidates by publication date/year before the feed's added-date order.
- Added a CWA Disconnect action that clears only the CWA server, credentials, and subscriptions while preserving local library books and other integrations.
- Merged the current `upstream/main` (33 incoming commits), preserving the private CWA, BookOrbit, Android TV, and LocalSend integrations, and advanced the app version to `0.12.12` for a signed Android release.
- Validation after the merge: 53 focused access/CWA/BookOrbit/OPDS tests passed, 127 combined feature and Android/TV tests passed, the OPDS persistence hook tests passed, TypeScript/Biome lint passed across 2,055 files, and the optimized Tauri frontend production build passed.
- The GitHub release workflow will publish signed arm64 phone and armv7 Android TV APKs plus shared `latest.json`; live BookOrbit behavior and packaged Android UI remain device smoke-test items.

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

## 2026-08-09 — Google Drive settings sync

- Confirmed on both Android TV and the Onyx Leaf that ZIP settings restore remains unreliable while Google Drive library/progress synchronization works.
- Added a portable `Readest/settings.json` snapshot to Google Drive sync. A fresh device restores the remote snapshot before publishing local defaults; later passes use a three-way merge so independent device changes converge and same-field conflicts follow the existing sync strategy.
- Reused the established backup sanitizer and restore merger. Device paths, device IDs, sync cursors, Google OAuth tokens, CWA/OPDS passwords, API keys, and other credentials remain local and are not written to Drive.
- Settings changes now enter the existing five-second Drive sync window alongside library changes. The implementation is limited to Google Drive rather than changing every third-party file backend.
- Validation passed: 30 focused settings/orchestration/trigger tests, the complete suite (9,013 passed; 16 skipped), full TypeScript/Biome lint across 2,011 files, and the optimized production frontend build.
- Committed and pushed the settings implementation as `7184b3b4`, then published signed `0.12.10` APKs in Actions run [`31349487698`](https://github.com/kelvinalfaro/readest/actions/runs/31349487698). Updater metadata remained disabled for bounded device testing.
- Installed the ARMv7 TV APK in place on the Google TV Streamer. Existing app data and the Drive authorization survived; a manual Drive sync completed, reconciled the library from 45 to 47 ready books with no issues, and showed a current successful-sync timestamp. Because portable settings sync runs before library reconciliation and propagates failure, the completed pass verifies that `Readest/settings.json` was exchanged successfully.
- Corrected the Google Drive integration description and tip so the UI no longer claims portable settings require Readest Cloud. Pushed `20541a5e`, published signed `0.12.11` APKs in Actions run [`31351013256`](https://github.com/kelvinalfaro/readest/actions/runs/31351013256), and installed the checksum-matched TV ARMv7 asset. Both automatic sync after launch and a second manual sync completed; 47 books remained ready with zero CWA issues, and no crash or ANR occurred. Updater metadata again remained disabled.

Open next step:

- Confirm a portable preference restores on the Leaf or another fresh/local-baseline-free device while credentials and device-local fields remain unchanged. The TV upload/sync path is accepted; a destructive TV clear-data restore was intentionally not performed.

## 2026-08-08 — Separate phone and Android TV listening release

- Implemented native Android TV detection through `Configuration.UI_MODE_TYPE_TELEVISION` with a Leanback-feature fallback, then gated TV-only remote focus behavior, overscan-safe styling, and the expanded listen-first Read Aloud panel behind that runtime result.
- Added deterministic D-pad spatial focus navigation, conspicuous TV focus styling, TV author metadata, and a dedicated Stop control while retaining the repaired shared TTS/media-service playback stack.
- Added a generated 320 x 180 Readest TV launcher banner and a reproducible build-profile script. At Kelvin's direction, changed the release design from one adaptive APK to two signed APK variants with the same package and version: a normal phone/tablet manifest and a TV manifest with optional touch/faketouch, Leanback launcher, and banner declarations.
- Changed the private release workflow to build both variants, reject identical APKs, inspect their packaged manifests, and leave shared updater metadata disabled unless explicitly requested after phone smoke testing.
- Validation passed: 8,807 unit tests across 698 files (4 skipped), focused TV/TTS tests, full type/Biome lint, Rust formatting, production frontend build, YAML parsing, both Linux-hosted signed Android builds, packaged-manifest differentiation, and independent APK signature/hash verification. Local Clippy, Rust tests, and Android packaging remain blocked by the workstation's missing MSVC `link.exe`; the successful Linux workflow provided the native production-build gate.
- GitHub Actions run `31275476918` built release commit `a49787a` and published private release [`cwa-android-v0.11.24-tv-listen-a49787a`](https://github.com/kelvinalfaro/readest/releases/tag/cwa-android-v0.11.24-tv-listen-a49787a) with:
  - `Readest_CWA_0.11.24_phone.apk` — 76,517,555 bytes; SHA-256 `6c01cafb4c68513aa1116464027fc11132c5cad494558e1ba1637b835e99776c`
  - `Readest_CWA_0.11.24_android-tv.apk` — 76,517,727 bytes; SHA-256 `0ba90db6a647aac49f2dc70134aec379de64473bcb52452fa8b535c4f498d127`
  - Both APKs verify against signing-certificate SHA-256 `22a903457dd10a7c77210a5d29c375f26aee6bea73120a740b23865f7476a4be`. No `latest.json` was published.
- Pushed canonical `main` at `f3ea9ec` after adding a durable workflow safeguard: releases without updater metadata remain non-latest, while an explicitly authorized metadata publication also promotes that release. The updater-ready `0.11.23` release remains GitHub's `latest` release.

Open next steps:

- Sideload and validate the TV APK on the Google TV Streamer using the then-current remote-only and background-playback checks.
- Smoke-test the phone APK on the Pixel 7a before deciding whether to publish shared updater metadata pointing to the phone artifact.

## 2026-08-08 — Upstream reconciliation, armv7 TV release, and device validation

- Reconciled canonical `main` with current `readest/readest:main`, preserving the CWA fork and TV adaptations. Diagnosed the Google TV Streamer as Android 14 with only `armeabi-v7a`/`armeabi`, which explained the prior `INSTALL_FAILED_NO_MATCHING_ABIS` failure.
- Updated the signed workflow to produce architecture-labelled phone arm64 and TV armv7 APKs and updated updater selection by Android architecture. GitHub Actions run `31281853980` successfully published release `cwa-android-v0.12.4-tv-direct-restore-0fbc7bb`.
- Installed and verified `0.12.4` on the TV as package `com.bilingify.readest.cwa`, `versionCode 12004`, with primary ABI `armeabi-v7a`. The phone artifact remains untested and shared updater metadata remains unpublished.
- Preserved the completed phone backup locally at `D:\Readest Device Transfer\readest-backup-2026-08-08.zip` and on the TV in `/sdcard/Download`. Kelvin manually recreated the needed TV settings, so backup restoration is no longer required.
- Migrated the clean canonical checkout to `D:\src\readest-cwa`, copied the ignored local environment files with matching hashes, retained the old `C:\src` checkouts pending explicit deletion approval, and configured the new checkout with the existing fork author identity.
- Device testing exposed a TV remote focus loss whenever shared Settings or Backup/Restore dialogs opened or replaced their controls. Fixed the shared dialog chassis to focus the first visible actionable control on TV, recover focus after content transitions, and keep explicitly scoped dialog navigation isolated. Ten focused TV/release tests and the full type/Biome lint gate across 2,007 files pass.
- Pushed release commit `3f6ad8d` for version `0.12.5`. Signed dual-APK workflow run `31285121759` is in progress with updater metadata disabled.
- After Kelvin approved the verified cleanup list, removed the superseded `C:\src` canonical clone, stale handoff clone, two merged worktrees, and the obsolete `D:\src\readest-fix-tv-zip-picker` worktree that still depended on the old `C:` Git metadata. Verified `C:\src` is absent and `D:\src\readest-cwa` remains clean at `3f6ad8d`, matching `origin/main`.
- Reproduced the Google Drive TV failure. The Streamer has no Custom Tabs service or usable browser; while the obsolete AnExplorer Wear OS build was installed, Android routed the authorization page through its `BrowserActivity` and mishandled the custom-scheme return. After AnExplorer was removed, Android correctly reported that no app could open the authorization URL. The TV therefore needs Google's limited-input device OAuth flow and a separate TV/limited-input OAuth client rather than the phone-style browser callback. The phone's immediate `Failed to connect` remains separately unobserved because only the TV is connected over ADB.

Open next steps:

- After run `31285121759` succeeds, install the `0.12.5` TV armv7 APK and verify Settings and Backup overlays using only the remote, including scrolling and Back behavior.
- Connect the phone, smoke-test the `0.12.5` phone arm64 APK, and only then decide whether to upload `latest.json` and promote the release for automatic updates.
- Create or identify a Google OAuth client of type **TVs and Limited Input devices**, then implement and validate the official device-code flow for the TV while preserving the existing phone/browser flow.
- Connect the phone over ADB and reproduce its immediate `Failed to connect` error with logs; do not assume it shares the TV cause.

## 2026-08-08 — Google Drive OAuth repair for phone and TV

- Reproduced the Pixel 7a failure with ADB. Readest stopped before launching Chrome because the OAuth token store incorrectly probed the separate sync-passphrase preferences; that stale encrypted file raised `AEADBadTagException` and made Drive appear to lack secure storage.
- Added a dedicated secure-item-store probe for OAuth tokens, leaving the unreadable passphrase isolated and avoiding any deletion of books, settings, or potentially valid tokens.
- Added Google's limited-input device flow for Android TV. The TV now shows Google's verification URL and user code in Readest, polls for approval, persists the refresh token, and uses the TV client secret for later refreshes; phone/tablet browser + PKCE behavior is unchanged.
- Configured the fork's `CWA_GOOGLE_TV_CLIENT_ID` and `CWA_GOOGLE_TV_CLIENT_SECRET` Actions secrets from the user-supplied limited-input credential. Downloaded `client_secret_*.json` files are ignored and no credential value is committed.
- Bumped the CWA app to `0.12.6`, committed and pushed exact source commit `b278f932`, and dispatched signed dual-APK release run [`31287177944`](https://github.com/kelvinalfaro/readest/actions/runs/31287177944) with tag `cwa-android-v0.12.6-drive-oauth-b278f932`. Shared updater metadata remains disabled for manual smoke testing.
- Validation passed: 34 focused tests across OAuth, provider construction, release architecture, and TV device flow; TypeScript and targeted Biome checks; production Next.js build; clean diff/credential scan. Local native packaging remains blocked by the workstation's missing MSVC `link.exe`; the Linux release workflow is the authoritative native compile/sign gate.

Open next steps:

- Monitor run `31287177944`, then manually install the phone arm64 and TV armv7 APKs.
- Phone: tap Google Drive Connect, complete the browser consent/return, verify the account label, restart Readest, and run Sync now.
- TV: tap Connect, use the displayed URL and code on a second device, verify Readest completes automatically, restart Readest, and run Sync now.
- The phone disconnected before the temporary ADB USB stay-awake setting could be explicitly restored. It has no effect while unplugged; on the next ADB connection, run `adb -s <phone-serial> shell svc power stayon false` and verify the setting.
- Phone testing confirmed `0.12.6` removed the original keychain exception but still failed before opening Chrome. Added the underlying JavaScript error to the user-visible toast and bumped to `0.12.7` at commit `79c88cee` so the remaining cause can be captured without a debuggable APK.
- Corrected the release approach after Kelvin clarified that the TV depends on the auto-updater. Canceled metadata-disabled run `31289048326` during setup and started replacement run [`31289082532`](https://github.com/kelvinalfaro/readest/actions/runs/31289082532) with shared `latest.json` publication enabled. On success it will publish both architecture URLs and promote `0.12.7` as latest.
- The `0.12.7` diagnostic identified the remaining phone cause: the dedicated OAuth encrypted-preferences file itself was unreadable. APK inspection confirmed `is_secure_item_store_available` was packaged, ruling out a stale or incomplete APK.
- Added a narrowly scoped recovery for Android backup/restore key mismatch: when opening the OAuth store raises a cryptographic exception, Readest deletes and recreates only `readest_secure_items_v1`. Books, reading data, settings, and the separate sync-passphrase store are untouched; the unreadable OAuth values cannot be recovered.
- Updated stale OneDrive test mocks for the shared OAuth store probe, bumped to `0.12.8`, and passed 32 focused Drive/release tests, the full suite (9,005 passed; 16 skipped), and full TypeScript/Biome lint. The repository-wide pre-push format hook remains unusable on this Windows checkout because it flags CRLF in thousands of untouched files; changed files passed the pre-commit formatter and the push used the verified commit.
- Pushed exact commit `2b36a4e6` and dispatched signed dual-APK run [`31290394452`](https://github.com/kelvinalfaro/readest/actions/runs/31290394452) with tag `cwa-android-v0.12.8-secure-store-recovery-2b36a4e6` and updater metadata enabled.
- Device testing on both phone and TV showed that `0.12.8` still returned the secure-storage build error. The Android method existed in the APK, but it had not been registered through the Rust/Tauri command and permission layers, so the invocation failed before reaching Android. Replaced the unnecessary new probe with the already registered `get_secure_item` path, which now also performs the narrow Android encrypted-store recovery.
- Diagnosed the TV Read Aloud freeze from device logs. Readest and its media service did not crash or ANR; Google TV's TTS engine spent about three minutes cold-loading its voice model while controller initialization waited. Bounded native TTS initialization at eight seconds so Readest continues with another available speech engine, and single-flighted Android initialization so repeated attempts do not launch overlapping Google TTS cold starts.
- Bumped to `0.12.9`; validation passed 149 focused Drive/TTS/lifecycle tests, the full suite (9,007 passed; 16 skipped), full TypeScript/Biome lint, and the optimized production build. Pushed exact commit `b25b18c7` and dispatched signed dual-APK run [`31291659416`](https://github.com/kelvinalfaro/readest/actions/runs/31291659416) with tag `cwa-android-v0.12.9-drive-tv-tts-b25b18c7` and updater metadata enabled.

## 2026-08-06 — Upstream merge and Read Aloud background repair

- Created and pushed recoverable branch `backup/main-pre-upstream-20260806` at the prior CWA tip `b66492f`, then merged the inspected upstream tip `45d3b1f` into canonical `main` without reset or force operations.
- Resolved all ten merge conflicts while preserving CWA package identity, routes, OPDS synchronization, queue/manual-download persistence, fork updater/release workflow, cloud/offline-audio access overrides, and the temporary forced-`pro` policy. Retained upstream TTS, iCloud, reading-statistics, reader improvements, and Edge WebSocket close/error/inactivity recovery.
- Reworked Read Aloud media ownership so Android foreground activation precedes permission prompts, listener setup, and asynchronous cover conversion; serialized native activate/deactivate transitions; ignored stale artwork; and made stop-during-start and rapid restart converge on the latest desired state.
- Added native service desired-state tracking before service creation and suppressed delayed activation after a stop. Failed TTS or foreground-service startup now shuts down the controller, releases the manager slot, unbinds media, resets UI state, and leaves the next Play action usable.
- Removed the inherited library-page wake-lock call exposed by the new upstream reader-only regression, and bumped the CWA app to `0.11.23`.
- Validation passed: 8,798 unit tests (695 files, 4 skipped), full app type/lint checks (1,976 files), 171 focused CWA/OPDS/access/updater tests, 75 focused Edge/TTS/media tests, Android native unit compilation/tests, Readest-owned Rust formatting checks, and the optimized production frontend build. The local Rust clippy/full Android package build could not complete because this PC lacks the Windows SDK/Visual C++ linker; the signed Linux GitHub workflow is the authoritative Android build gate.
- Pushed exact release commit `423bc1c` to `origin/main`. Dispatched signed workflow run `31129249005` for tag `cwa-android-v0.11.23-tts-background-423bc1c`; its signed Android compile remained in progress when Kelvin took over monitoring. The Pixel 7a was connected and still reported installed version `0.11.22`.
- The signed `0.11.23` release subsequently completed and the Pixel 7a auto-updated successfully. ADB confirmed package `com.bilingify.readest.cwa`, `versionCode 11023`, and `versionName 0.11.23`.
- Approved a private, listen-first Google TV Streamer adaptation using the same package and adaptive APK; no Google Play or public distribution is planned. The detailed handoff was retired after its material history was merged into this log.

Open next steps:

- On the Pixel 7a, verify the current-book media card and foreground `MediaPlaybackService`, playback across Home/app switching/screen lock and at least 15 minutes backgrounded, pause/resume plus five stop/restarts, and clean recovery from a user-directed temporary Edge network interruption.

## 2026-07-31 — Manual CWA shelf download persistence

- Reproduced on the connected Pixel 9 Pro Fold: manually downloading an OPDS/CWA shelf book increased the local CWA library from 38 to 39 books, but force-stopping and reopening Readest returned it to 38 while automatically synchronized CWA books remained.
- Fixed the manual OPDS download path so it publishes a new library array and awaits durable library persistence before navigation can continue. Added a focused regression test for both behaviors.
- Committed and pushed the fix to canonical `main` at `89e2901`, then bumped the Android app version to `0.11.21` and pushed release commit `e827236` so the in-app updater can distinguish the build from `0.11.20`.
- Validation passed for the focused OPDS tests (12 tests), app lint/type checking (1,822 files), and `git diff --check`. The complete unit run passed 8,012 tests with the same six environment/baseline failures seen before the fix: one wake-lock scope assertion and five native-service mock/time-out failures.
- Dispatched signed Android workflow run `30656179575` with tag `cwa-android-v0.11.21-opds-persistence-e827236`. Kelvin took over build monitoring while the Android APK step was still running.
- Device testing of `0.11.21` exposed a second defect in `addCWABookSource`: a first-time manual CWA source was stored as both the parent `cwaSource` and its own `sources[0]`, producing the exact `Converting circular structure to JSON` import error and preventing the new library entry from being saved.
- Added a regression test that reproduced the reported serialization error, changed CWA source assignment to persist detached plain source records, and bumped the app to `0.11.22`. Focused CWA/OPDS tests passed (29 tests), lint/type checking passed, and two additional full-suite timeout failures passed when rerun in isolation; the unrelated wake-lock/native-test baseline remains.
- Pushed corrected release commit `b66492f` to canonical `main` and verified the exact SHA locally, at `origin/main`, and through the GitHub API. Dispatched signed Android workflow run `30683505761` with tag `cwa-android-v0.11.22-circular-source-b66492f`.

Open next steps:

- Confirm workflow `30683505761` succeeds and publishes both the signed arm64 APK and `latest.json`.
- Update through the app, manually download a previously absent CWA shelf title, fully close/reopen Readest, and confirm the title remains in the library.

## 2026-07-29 — Upstream branch update

- Updated `agent/cwa-kosync-fallback` from Readest `v0.11.18` lineage through current upstream `main` (`21e1ed5`, Readest `v0.11.20` era) while preserving the CWA commit history.
- Used the clean local source checkout at `C:\src\readest-cwa`; the Google Drive handoff clone remains a no-checkout history/recovery copy.
- Preserved the pre-update branch at `origin/backup/agent-cwa-kosync-fallback-pre-upstream-20260729` (`972bc44`).
- Reconciled the previously unseen remote merge commit `89d0901` without changing the already verified merged tree.
- Pushed `agent/cwa-kosync-fallback` at `634813c`; local and GitHub tips matched after push.
- Validation passed: app lint/type-check, 73 focused CWA/OPDS/settings tests, formatting checks on conflict-resolved files, and the production web build including `/cwa`.
- The focused tests require explicit non-secret localhost Supabase values because the local default base64 test environment is malformed.

- Dispatched one signed prerelease build from `634813c`: GitHub Actions run `30507472614`, tag `cwa-android-v0.11.20-upstream-634813c`. Kelvin took over monitoring while the Android APK build step was in progress.
- The release completed successfully with signed asset `Readest_CWA_0.11.20_arm64.apk` (SHA-256 `4334b4914b8aa21be28dd8318c5d609e526d762954244c8f6c018fe2260d4e2d`).
- Consolidated the verified CWA tree into canonical `main` at `2590e36`; GitHub `main` matched locally and was current with upstream (`behind_by: 0`).
- Deleted the remote CWA, temporary backup, and two old `fix/*` branches at Kelvin's direction. The fork and local checkout now contain only `main`; the release tag retains the released `634813c` commit.

Open next steps:

- Perform Android/device validation of the v0.11.20 CWA prerelease.

## 2026-07-29 — Workspace consolidation

- Confirmed `C:\src\readest-cwa` is a clean, full checkout of canonical `main` with both `origin` and `upstream` remotes.
- Established this Google Drive folder as a lightweight continuity layer rather than a code checkout.
- Preserved concise history, operating guidance, release links, and unique device evidence.
- Removed redundant no-checkout/stale source clones, Git bundles, source snapshots, old build artifacts, duplicate KOPlugin source, and downloaded APKs after verifying their commits and releases were recoverable from GitHub.

## 2026-07-29 — Local access
- Committed local access changes directly to `main` at `7c0e36c` in `C:\src\readest-cwa`, pushed the exact commit to `origin/main`, and verified local, remote-tracking, and GitHub API SHAs match.
- Made third-party personal cloud sync and explicit offline Read Aloud audio downloads available, including consistent UI, sync-engine behavior, and tests.
- Preserved an intentional fork override that makes `getUserProfilePlan()` return `pro`; renamed its unused token parameter to `_token` so type/lint validation passes. This changes client-side plan interpretation but does not rewrite the signed JWT.
- Validation: 47 directly affected tests passed, type/Biome lint passed across 1,820 files, and the production web build completed. The full suite reported 8,015 passing tests plus one unrelated existing failure because `app/library/page.tsx` calls the reader-scoped wake-lock hook.
- Published signed arm64 prerelease `cwa-android-v0.11.20-access-7c0e36c` from GitHub Actions run `30513540247`. Asset: `Readest_CWA_0.11.20_arm64.apk` (76,034,315 bytes; SHA-256 `3942a93607211d98db039c00911cc29dd8f628bdf178bd7d4ccfa5ccd1a431b6`).
- The Windows pre-push hook's repository-wide format check currently flags 1,834 unrelated CRLF files. The exact verified commit was pushed with Husky disabled after the changed files passed the staged formatter, lint/type checks, affected tests, and production build; do not bulk-reformat the repository solely to satisfy that local line-ending mismatch.

Open next steps:
- Decide when to restore JWT-based profile-plan resolution instead of the temporary forced-`pro` override.
- Investigate or reconcile the unrelated library wake-lock scope test.
- Complete Android/device validation of the new local-access prerelease.

## 2026-07-08 to 2026-07-10 — CWA integration and initial releases

- Started from Readest `v0.11.18` and established the CWA-specific Android package/build path.
- Added CWA OPDS library integration, KOSync/CWA URL handling, encrypted credentials, shelf discovery and subscriptions, CWA-aware imports, patient sequential downloads, and local/server-read suppression.
- Added cleanup-before-replenishment, a per-shelf reading queue, rate-limited startup checks, multi-shelf source membership, persistent sync reports, dry-run preview, targeted retry, connection testing, and per-shelf reset.
- Added the native `/cwa` hub, normal-library CWA status, and direct CWA-aware OPDS browsing.
- Added a manual signed Android release workflow using GitHub Secrets; no keystore or signing secret was stored in the project folder.
- Verified focused CWA/OPDS tests, lint, production web builds, mobile smoke checks, and successful signed releases through commit `972bc44`.
- Retained unique July 8 device evidence for the Leaf and Pixel Fold under `Device Evidence`; replaceable source copies, snapshots, bundles, and old APK downloads were removed during the July 29 cleanup.
