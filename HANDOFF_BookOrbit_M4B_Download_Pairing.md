# Handoff: BookOrbit M4B download and local audiobook pairing bug

## Implementation status — 2026-09-07

The bounded code repair is implemented in the authoritative checkout as Android release `0.12.17`; Android acceptance remains pending.

- The format menu now sends the selected acquisition object through download handling; choosing M4B does not open the existing EPUB.
- M4B, M4A, and MP3 acquisitions bypass ebook import and are saved through the native Save dialog.
- Android `content://` destinations use native stream copying, and temporary downloads are cleaned up after save, cancellation, or failure.
- Focused regression tests, TypeScript, targeted Biome, Rust formatting, diff checks, and the production frontend build pass.
- Native compilation could not be completed locally because this Windows environment lacks MSVC `link.exe`. The Android device-acceptance scenarios below remain open.

## Objective

Fix the Android BookOrbit download flow so that when a BookOrbit title exposes both EPUB and M4B formats, the user can explicitly download the M4B as a local audiobook file and then select that local file from Readest's **Pair Audiobook** flow.

The current behavior prevents the intended EPUB + M4B pairing workflow even though the BookOrbit book detail UI visibly offers both formats.

## User-visible problem

On the BookOrbit book detail screen, a title can expose a **Download Again** format menu with at least:

- EPUB
- M4B

Example observed title: **You Are Here** by Ada Limón.

The UI correctly shows both format choices, but the actions do not behave independently.

### Reproduction case A: EPUB already present

1. The BookOrbit title has both EPUB and M4B available.
2. The EPUB is already downloaded/imported into Readest.
3. Open the BookOrbit book detail screen.
4. Open **Download Again**.
5. Select **M4B**.
6. Instead of downloading an M4B file for local use, Readest opens or resolves to the EPUB book.

Observed result:

- No user-accessible M4B is saved locally.
- The selected M4B action appears to fall through to the existing EPUB/open-book path.
- The user cannot then use **Pair Audiobook** because Android's local file picker has no M4B file to select.

Expected result:

- Selecting **M4B** should download the actual M4B asset.
- The file should be persisted to a location that Readest's local audiobook picker can access, or the app should otherwise expose a valid local URI/file handle to the pairing flow.
- The existing EPUB should remain the readable book.
- The audiobook should not replace, open as, or be mistaken for the EPUB.

### Reproduction case B: M4B selected first after deleting the local book

1. Delete the locally downloaded BookOrbit book from Readest.
2. Return to the BookOrbit book detail screen.
3. Open the format download menu.
4. Select **M4B** before downloading the EPUB.
5. The app returns an error.

Observed result:

- M4B cannot be downloaded as the first/only format.
- This strongly suggests the M4B action is still being passed through a book-import pipeline that assumes the downloaded asset must be a supported standalone reading publication.
- If the importer expects an EPUB/PDF/FB2/etc. publication, a raw M4B will fail even though it is valid as an audiobook attachment.

Expected result:

- M4B download should succeed independently of whether an EPUB is already in the local library.
- The downloaded M4B should be treated as an audiobook asset, not as a standalone ebook publication.
- Later downloading/importing the EPUB should still work and should not overwrite or orphan the M4B.

## Screenshot evidence

The attached Android screenshot shows the BookOrbit title detail page for **You Are Here** with a **Download Again** menu containing two explicit format choices:

- EPUB
- M4B

This confirms that the format is being discovered and surfaced in the UI. The defect is therefore downstream of format discovery, most likely in the selected-format download dispatch, persistence, import, or post-download action.

Screenshot supplied in the handoff conversation:

`Screenshot_20260907-094712.png`

## Why this matters

Readest's local audiobook pairing feature asks the user to select a locally saved audiobook file. For a BookOrbit title that already contains both an EPUB and an M4B, the natural workflow should be:

1. Download/import EPUB into Readest.
2. Download M4B from the same BookOrbit title as an audiobook asset.
3. Open the EPUB.
4. Choose **Pair Audiobook**.
5. Select the downloaded M4B.
6. Complete chapter mapping and save the pairing.

At present, step 2 is broken, so the pairing feature is effectively unusable for BookOrbit-hosted M4B files unless the user can obtain the audiobook through some external path.

## Project constraints and relevant continuity

The authoritative editable checkout is:

`D:\src\readest-cwa`

Follow the repository `AGENTS.md` and maintain the single project history in `PROJECT_LOG.md`.

Relevant established constraints:

- Preserve upstream Readest behavior.
- Preserve Kelvin's CWA, Android TV, and BookOrbit integrations.
- Prefer shared OPDS/download infrastructure rather than creating a separate BookOrbit-only downloader unless the existing abstractions genuinely cannot support audiobook assets.
- Keep BookOrbit provider metadata and user-facing labels distinct.
- Do not publish, push, create a release, or deploy without explicit authorization.
- Recent project continuity already notes that M4B selection was intentionally retained during the latest upstream merge, so this should be treated as a functional defect in the current M4B path rather than a request to add a new format from scratch.

## Working diagnosis

Do not assume the following until code tracing confirms it, but the observed behavior points to one or both of these defects.

### Hypothesis 1: selected format is lost before download

The BookOrbit detail menu may correctly render `EPUB` and `M4B`, but the click handler may call a generic book download function using the book-level record rather than the selected acquisition/format link.

If that generic function resolves the primary/default publication link, selecting M4B would still fetch or open the EPUB.

Things to inspect:

- Format-menu item click handler.
- The value passed when `M4B` is selected.
- Whether the handler receives a concrete acquisition URL, MIME type, rel, filename, and format.
- Any code that re-resolves a book to its preferred/default format after the user has already selected a specific format.
- Any post-download logic that calls `openBook`, `importBook`, or equivalent without checking the selected content type.

### Hypothesis 2: M4B uses the ebook import pipeline

The failure when M4B is selected first suggests the downloaded M4B may be passed directly into the normal publication importer.

That would be structurally wrong for this workflow.

The app needs to distinguish:

- **Readable publication asset**, EPUB, PDF, FB2, etc.
- **Audiobook attachment asset**, M4B/M4A/MP3 intended for pairing.

The M4B should be persisted without being forced through a reader-publication parser.

## Investigation plan

### 1. Reproduce with diagnostics before changing behavior

Use the exact two scenarios above on Android.

Capture, at minimum:

- Selected format.
- BookOrbit acquisition URL or acquisition identifier.
- MIME type.
- Suggested filename.
- Download target.
- Download response content type.
- Byte count.
- Any import function invoked after download.
- Any open-book navigation invoked after download.
- Error object/message for the "M4B first" case.

Avoid logging credentials, auth headers, cookies, tokens, or signed URLs containing secrets.

### 2. Trace the BookOrbit format menu to the shared downloader

Find the code responsible for:

- Building the BookOrbit detail download menu.
- Mapping BookOrbit/OPDS acquisitions to displayed format labels.
- Handling a selected download format.
- Calling the shared OPDS/download service.
- Importing or opening the downloaded result.

The key question is:

> Does selecting M4B preserve the exact M4B acquisition object all the way through download and post-download handling?

Add or inspect tests around this boundary.

### 3. Verify acquisition metadata

For the failing title, inspect the BookOrbit/OPDS entry and confirm the M4B acquisition has:

- A unique download URL or acquisition identifier.
- A correct or usable MIME type, ideally `audio/mp4`, `audio/x-m4b`, or the provider's actual value.
- A filename ending in `.m4b`, or enough metadata to derive one.
- No accidental reuse of the EPUB acquisition URL.

If BookOrbit reports a generic media type, extension detection may need to use the acquisition URL or server-provided filename as a fallback.

### 4. Separate download from ebook import

Refactor the post-download flow so behavior is content-type aware.

Conceptually:

```text
selected acquisition
        |
        v
shared authenticated download
        |
        v
determine asset kind
   /                 \
publication         audiobook
   |                   |
import into            persist as
Readest library        local audio asset
   |                   |
open/read if           return success,
appropriate            do not ebook-import
```

For `M4B`, `M4A`, and supported audiobook `MP3`:

- Do not call the normal ebook parser/import path.
- Do not replace the existing EPUB library item.
- Do not automatically navigate to/open the EPUB as a side effect of the M4B selection.
- Save the downloaded audio as an audiobook asset.

### 5. Choose the correct Android persistence model

The local pairing picker must be able to consume the file after download.

Preferred implementation should fit the existing Readest Android file architecture. Evaluate in this order:

#### Option A: user-visible Downloads/document location

Save the M4B through Android storage APIs into a user-visible location such as Downloads.

Advantages:

- Pair Audiobook's existing system file picker can select it naturally.
- The user can see and manage the file.
- Minimal coupling between BookOrbit and audiobook pairing.

Requirements:

- Use Android-supported scoped storage behavior.
- Preserve filename and `.m4b` extension.
- Avoid broad storage permissions if the Storage Access Framework or MediaStore can provide the needed behavior.

#### Option B: app-private asset plus direct "pair this audiobook" handoff

If the app already has a robust local asset abstraction, store the M4B privately and expose a direct action such as:

**Download and Pair Audiobook**

This would require the pairing code to accept the resulting app-local URI/path instead of requiring the user to reselect it through the Android document picker.

This may provide a better UX eventually, but it is a broader behavioral change.

For the immediate bug fix, prefer the smallest change that makes the currently advertised **local file pairing** workflow actually work.

### 6. Preserve separate lifecycle semantics

An EPUB and paired M4B are related but should remain separate assets.

Define expected behavior for:

- Deleting the EPUB.
- Removing the audiobook pairing.
- Deleting the downloaded M4B.
- Redownloading either format.
- Re-downloading a newer copy of the EPUB.
- Re-running BookOrbit SmartScope cleanup.
- Cloud/Drive synchronization, if local audio is intentionally excluded.
- BookOrbit progress/finished-state exchange.

Do not let BookOrbit SmartScope cleanup accidentally remove an M4B unless audiobook-asset cleanup is explicitly designed and tested.

## Recommended implementation direction

### Minimal repair

The first implementation should make the existing format menu truthful.

When the user taps **M4B**:

1. Preserve the selected M4B acquisition.
2. Download that exact acquisition through the existing authenticated BookOrbit/OPDS download infrastructure.
3. Detect it as an audiobook asset.
4. Save it locally without passing it to the ebook importer.
5. Show a success state with the saved filename/location or an action to pair it.
6. Leave the EPUB/library state unchanged.

This is preferable to trying to make M4B itself a standalone Readest library publication.

### Optional follow-up UX improvement

After the minimal fix is stable, consider replacing the generic completion message with:

**Audiobook downloaded**

Actions:

- **Pair with this book**
- **Done**

If **Pair with this book** is selected, invoke the same pairing logic used by the reader's **Pair Audiobook** command, passing the freshly downloaded local asset directly where supported.

Do this only after the basic independent download behavior is working and tested.

## Test plan

### Unit tests

Add focused tests for format selection:

1. EPUB menu selection passes EPUB acquisition.
2. M4B menu selection passes M4B acquisition.
3. M4B selection never falls back to the primary EPUB acquisition.
4. Selected filename and MIME type survive through the downloader.
5. Audiobook extension fallback works when MIME metadata is weak.

Add post-download tests:

6. EPUB invokes publication import.
7. M4B does not invoke publication import.
8. M4B does not invoke EPUB open/navigation.
9. M4B uses audiobook persistence.
10. Existing EPUB remains untouched after M4B download.
11. M4B can be downloaded when no EPUB is locally present.
12. Download failure surfaces a useful error without corrupting the library record.

### Integration tests

Use a fixture BookOrbit/OPDS entry containing both EPUB and M4B acquisitions.

Verify:

- Choosing each format downloads the correct bytes.
- The two acquisitions remain distinguishable.
- M4B completion creates a usable local audiobook asset.
- EPUB import remains unchanged.
- Authentication is handled through the existing shared provider infrastructure.

### Android device acceptance

Test on the Pixel 10 Pro Fold.

Scenario 1:

1. Keep EPUB downloaded.
2. BookOrbit detail → Download Again → M4B.
3. Confirm M4B download succeeds.
4. Open EPUB.
5. Pair Audiobook.
6. Use Android file picker.
7. Confirm downloaded M4B appears and can be selected.
8. Complete pairing.
9. Start playback and confirm human narration plays.

Scenario 2:

1. Remove local EPUB and M4B.
2. Download M4B first.
3. Confirm no error.
4. Confirm audiobook file exists locally.
5. Download EPUB second.
6. Pair successfully.

Scenario 3:

1. Download EPUB first.
2. Download M4B second.
3. Confirm selecting M4B does not reopen the EPUB as the result of the M4B action.

Scenario 4:

1. Cancel an in-progress M4B download if supported.
2. Retry.
3. Confirm no duplicate/corrupt partial asset remains.

Scenario 5:

1. Download a large M4B.
2. Background the app.
3. Resume.
4. Confirm download completion and file integrity.

## Regression areas

Because this app deliberately reuses shared OPDS/download infrastructure, validate that the repair does not break:

- Standard EPUB BookOrbit downloads.
- CWA OPDS downloads.
- BookOrbit SmartScope auto-download.
- Generic OPDS format selection.
- Existing local file import.
- M4B selection in the reader's Pair Audiobook flow.
- Android TV ZIP/file-selection behavior retained during the recent upstream merge.
- Existing Readest Cloud/Drive behavior.
- BookOrbit cleanup logic for finished books.

## Validation gates

Before considering the fix complete:

- Focused BookOrbit format-selection tests pass.
- Shared OPDS/download tests pass.
- Audiobook/local-file tests pass.
- Relevant Android file-selection tests pass.
- TypeScript passes.
- Biome/lint passes for touched files.
- Production frontend build passes.
- Android APK build passes through the established build path.
- Pixel 10 Pro Fold acceptance scenarios above pass.

Do not publish or release until explicitly authorized.

## Project log update after implementation

Once the defect is fixed, add a concise durable entry to `PROJECT_LOG.md` recording:

- Root cause.
- Files/components changed.
- Persistence choice for M4B.
- Whether M4B remains user-visible in Downloads or app-private.
- Tests added.
- Android device acceptance result.
- Any remaining UX follow-up, such as direct **Pair with this book** after download.

Do not duplicate the full debugging narrative from this handoff into the project log.

## Suggested skills

For the implementation session, use the coding/debugging workflow appropriate for the Readest CWA repository.

Priorities for the next agent:

1. Read root `AGENTS.md`.
2. Read the latest relevant section of `PROJECT_LOG.md`.
3. Reproduce and trace before editing.
4. Inspect the BookOrbit format menu, acquisition model, shared OPDS downloader, publication importer, and Android local-file persistence.
5. Add focused tests before or alongside the fix.
6. Run the repository's required validation gates.
7. Stop before push/release unless Kelvin explicitly authorizes it.

## Definition of done

This issue is done when the following user workflow works reliably:

> From a BookOrbit title that offers EPUB and M4B, I can download the EPUB into Readest, separately download the M4B as an actual local audiobook file, open the EPUB, choose Pair Audiobook, select that M4B, and complete the pairing. Downloading the M4B must also work before the EPUB exists locally, and selecting M4B must never silently open or substitute the EPUB.
