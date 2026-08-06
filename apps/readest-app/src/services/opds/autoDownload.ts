import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { OPDSCatalog } from '@/types/opds';
import { downloadFile } from '@/libs/storage';
import { getFileExtFromMimeType } from '@/libs/document';
import { needsProxy, getProxiedURL, probeAuth, probeFilename } from '@/app/opds/utils/opdsReq';
import { resolveURL, parseMediaType, getFileExtFromPath } from '@/app/opds/utils/opdsUtils';
import { normalizeOPDSCustomHeaders } from '@/app/opds/utils/customHeaders';
import { READEST_OPDS_USER_AGENT } from '@/services/constants';
import { applyOPDSCover } from './cover';
import { applyOPDSMetadata } from './metadata';
import { checkFeedForNewItems } from './feedChecker';
import {
  loadSubscriptionState,
  saveSubscriptionState,
  pruneKnownEntryIds,
} from './subscriptionState';
import { upsertOPDSSourceMapping } from './sourceMap';
import { isRetryEligible, getNextRetryAt, DOWNLOAD_CONCURRENCY, MAX_RETRY_ATTEMPTS } from './types';
import type {
  PendingItem,
  SyncResult,
  OPDSSubscriptionState,
  FailedEntry,
  OPDSSyncOptions,
  OPDSCatalogSyncStats,
} from './types';
import { runWithConcurrency } from '@/utils/concurrency';
import { uniqueId } from '@/utils/misc';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download a single item and import it into the library.
 */
async function downloadAndImport(
  item: PendingItem,
  catalog: OPDSCatalog,
  appService: AppService,
  books: Book[],
): Promise<Book> {
  const url = resolveURL(item.acquisitionHref, item.baseURL);
  const username = catalog.username ?? '';
  const password = catalog.password ?? '';
  const customHeaders = normalizeOPDSCustomHeaders(catalog.customHeaders);
  const useProxy = needsProxy(url);

  let downloadUrl = useProxy ? getProxiedURL(url, '', true, customHeaders) : url;
  const headers: Record<string, string> = {
    'User-Agent': READEST_OPDS_USER_AGENT,
    Accept: '*/*',
    ...(!useProxy ? customHeaders : {}),
  };

  if (username || password) {
    const authHeader = await probeAuth(url, username, password, useProxy, customHeaders);
    if (authHeader) {
      if (!useProxy) {
        headers['Authorization'] = authHeader;
      }
      downloadUrl = useProxy ? getProxiedURL(url, authHeader, true, customHeaders) : url;
    }
  }

  const parsed = parseMediaType(item.mimeType);
  const rawPathname = new URL(url).pathname;
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    pathname = rawPathname;
  }
  const ext = getFileExtFromMimeType(parsed?.mediaType) || getFileExtFromPath(pathname);
  // Use the last non-empty path segment as the base; falling back to the
  // entry id avoids producing 200+ char filenames from deep URLs and keeps
  // us comfortably under the ~255-byte filesystem limit.
  const basename = uniqueId();
  const filename = ext ? `${basename}.${ext}` : basename;
  let dstFilePath = await appService.resolveFilePath(filename, 'Cache');

  console.log(`[OPDS] downloading "${item.title}" from ${url}`);
  const responseHeaders = await downloadFile({
    appService,
    dst: dstFilePath,
    cfp: '',
    url: downloadUrl,
    headers,
    singleThreaded: true,
    // Same self-signed/private-CA workaround as the manual download path
    // (#2871): the native downloader's rustls validation ignores the OS
    // trust store, so without this flag auto-download fails the TLS
    // handshake on servers where feed browsing and manual download work
    // (#4988).
    skipSslVerification: true,
  });

  const probedFilename = await probeFilename(responseHeaders);
  if (probedFilename) {
    const newFilePath = await appService.resolveFilePath(probedFilename, 'Cache');
    await appService.copyFile(dstFilePath, 'None', newFilePath, 'None');
    await appService.deleteFile(dstFilePath, 'None');
    dstFilePath = newFilePath;
  }

  const book = await appService.importBook(dstFilePath, books);
  if (!book) throw new Error(`importBook returned null for ${item.title}`);
  // The catalog's curated metadata wins over the file's embedded record
  // (#5270). Retry items rebuilt from FailedEntry carry none and skip.
  if (item.metadata) {
    applyOPDSMetadata(book, item.metadata);
  }
  // The catalog's own artwork wins over the one embedded in the file (#5270).
  // Best effort: a failure here must not fail an otherwise good import.
  if (item.coverHref) {
    try {
      await applyOPDSCover({
        appService,
        book,
        coverUrl: resolveURL(item.coverHref, item.baseURL),
        username,
        password,
        customHeaders,
      });
    } catch (error) {
      console.warn(`[OPDS] failed to apply the feed cover for "${item.title}":`, error);
    }
  }
  try {
    await upsertOPDSSourceMapping(appService, {
      catalogId: catalog.contentId || catalog.id,
      sourceUrl: url,
      bookHash: book.hash,
    });
  } catch (error) {
    console.error('OPDS sync: failed to update source map:', error);
  }
  console.log(`[OPDS] imported "${item.title}"`);
  return book;
}

/**
 * Sync a single catalog: discover new items, retry failed, download, update state.
 */
async function syncCatalog(
  catalog: OPDSCatalog,
  appService: AppService,
  books: Book[],
  options: OPDSSyncOptions = {},
): Promise<{ newBooks: Book[]; state: OPDSSubscriptionState }> {
  const state = await loadSubscriptionState(appService, catalog.id);
  const stats: OPDSCatalogSyncStats = {
    catalogId: catalog.id,
    catalogName: catalog.name,
    discovered: 0,
    deferredByBackoff: 0,
    filtered: 0,
    planned: 0,
    attempted: 0,
    downloaded: 0,
    failed: 0,
  };

  // Discovery: find new items from feeds
  const pendingItems = await checkFeedForNewItems(catalog, state);
  stats.discovered = pendingItems.length;

  // Failed entries still in their backoff window must not be re-attempted
  // until they become retry-eligible. They naturally reappear in
  // pendingItems (still in feed, not yet in knownEntryIds), so we have to
  // filter them out here. Without this, every sync would re-download the
  // same in-backoff entry and append a second copy to failedEntries —
  // surfacing as duplicate-key warnings in the failed-downloads dialog.
  const inBackoffIds = new Set(
    state.failedEntries.filter((fe) => !isRetryEligible(fe)).map((fe) => fe.entryId),
  );
  const eligiblePendingItems = pendingItems.filter((p) => !inBackoffIds.has(p.entryId));
  stats.deferredByBackoff = pendingItems.length - eligiblePendingItems.length;

  // Collect retry-eligible failed entries as PendingItems
  const retryItems: PendingItem[] = state.failedEntries.filter(isRetryEligible).map((fe) => ({
    entryId: fe.entryId,
    title: fe.title,
    acquisitionHref: fe.href,
    mimeType: 'application/octet-stream',
    baseURL: catalog.url,
  }));

  // Dedupe: a retry-eligible failed entry can also reappear in pendingItems
  // (because the entry isn't in knownEntryIds yet). Prefer the pending copy
  // since it carries the freshly-discovered MIME type from the feed.
  const seenIds = new Set<string>();
  let allItems: PendingItem[] = [];
  for (const item of [...eligiblePendingItems, ...retryItems]) {
    if (seenIds.has(item.entryId)) continue;
    seenIds.add(item.entryId);
    allItems.push(item);
  }

  const onlyEntryIds = options.onlyEntryIdsByCatalogId?.[catalog.id];
  if (onlyEntryIds) {
    const allowed = new Set(onlyEntryIds);
    allItems = allItems.filter((item) => allowed.has(item.entryId));
  }

  if (options.shouldSkipItem) {
    const filteredItems: PendingItem[] = [];
    for (const item of allItems) {
      const sourceUrl = resolveURL(item.acquisitionHref, item.baseURL);
      const shouldSkip = await options.shouldSkipItem({
        item,
        catalogId: catalog.id,
        catalogName: catalog.name,
        sourceUrl,
      });
      if (!shouldSkip) {
        filteredItems.push(item);
      } else {
        stats.filtered += 1;
      }
    }
    allItems = filteredItems;
  }

  const limit = options.limitByCatalogId?.[catalog.id];
  if (limit && limit > 0) {
    allItems = allItems.slice(0, limit);
  }
  stats.planned = allItems.length;
  if (allItems.length === 0) {
    stats.failed = state.failedEntries.length;
    stats.nextRetryAt = getNextRetryAt(state.failedEntries);
    if (!options.dryRun) {
      state.lastCheckedAt = Date.now();
      await saveSubscriptionState(appService, state);
    }
    await options.onCatalogComplete?.(stats);
    return { newBooks: [], state };
  }

  if (options.dryRun) {
    stats.failed = state.failedEntries.length;
    stats.nextRetryAt = getNextRetryAt(state.failedEntries);
    await options.onCatalogComplete?.(stats);
    return { newBooks: [], state };
  }

  // Acquisition: download with bounded concurrency
  const downloadConcurrency = options.downloadConcurrency ?? DOWNLOAD_CONCURRENCY;
  const delayBetweenDownloadsMs = Math.max(0, options.delayBetweenDownloadsMs ?? 0);
  stats.attempted = allItems.length;
  let completedDownloads = 0;
  const downloadResults = await runWithConcurrency(allItems, downloadConcurrency, async (item) => {
    const book = await downloadAndImport(item, catalog, appService, books);
    completedDownloads += 1;
    if (delayBetweenDownloadsMs > 0 && completedDownloads < allItems.length) {
      await sleep(delayBetweenDownloadsMs);
    }
    return book;
  });

  // Process results and update state
  const newBooks: Book[] = [];
  const newKnownIds: string[] = [];
  const updatedFailedEntries: FailedEntry[] = [
    // Keep non-retry-eligible failures as-is
    ...state.failedEntries.filter((fe) => !isRetryEligible(fe)),
  ];

  for (const outcome of downloadResults) {
    const item = outcome.item;
    if ('result' in outcome) {
      const book = outcome.result;
      newBooks.push(book);
      stats.downloaded += 1;
      newKnownIds.push(item.entryId);
      const sourceUrl = resolveURL(item.acquisitionHref, item.baseURL);
      await options.onBookImported?.({
        book,
        catalogId: catalog.id,
        catalogName: catalog.name,
        sourceUrl,
        item,
      });
    } else {
      stats.failed += 1;
      const existingFailed = state.failedEntries.find((fe) => fe.entryId === item.entryId);
      const attempts = (existingFailed?.attempts ?? 0) + 1;

      if (attempts >= MAX_RETRY_ATTEMPTS) {
        newKnownIds.push(item.entryId);
        updatedFailedEntries.push({
          entryId: item.entryId,
          href: item.acquisitionHref,
          title: item.title,
          attempts,
          lastAttemptAt: Date.now(),
        });
        console.error(
          `OPDS sync: permanently skipping "${item.title}" after ${attempts} failed attempts`,
        );
      } else {
        updatedFailedEntries.push({
          entryId: item.entryId,
          href: item.acquisitionHref,
          title: item.title,
          attempts,
          lastAttemptAt: Date.now(),
        });
      }
    }
  }

  state.knownEntryIds = pruneKnownEntryIds([...state.knownEntryIds, ...newKnownIds]);
  state.failedEntries = updatedFailedEntries;
  stats.failed = updatedFailedEntries.length;
  stats.nextRetryAt = getNextRetryAt(updatedFailedEntries);
  state.lastCheckedAt = Date.now();
  await saveSubscriptionState(appService, state);
  await options.onCatalogComplete?.(stats);

  return { newBooks, state };
}

/**
 * Sync all OPDS catalogs that have autoDownload enabled.
 *
 * Catalogs are processed sequentially: the per-catalog pool already runs
 * DOWNLOAD_CONCURRENCY parallel downloads, and a parallel fan-out across
 * catalogs would multiply that (N × DOWNLOAD_CONCURRENCY) and hammer
 * cellular connections. One failure does not block the others — each
 * catalog's errors are isolated and surfaced in the result.
 */
export async function syncSubscribedCatalogs(
  catalogs: OPDSCatalog[],
  appService: AppService,
  books: Book[],
  options: OPDSSyncOptions = {},
): Promise<SyncResult> {
  const eligible = catalogs.filter((c) => c.autoDownload && !c.disabled);
  if (eligible.length === 0) {
    return { newBooks: [], totalNewBooks: 0, errors: [] };
  }

  const allNewBooks: Book[] = [];
  const errors: SyncResult['errors'] = [];

  for (const catalog of eligible) {
    try {
      const { newBooks } = await syncCatalog(catalog, appService, books, options);
      allNewBooks.push(...newBooks);
    } catch (reason) {
      console.error(`OPDS sync: catalog "${catalog.name}" failed:`, reason);
      errors.push({
        catalogId: catalog.id,
        catalogName: catalog.name,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      await options.onCatalogComplete?.({
        catalogId: catalog.id,
        catalogName: catalog.name,
        discovered: 0,
        deferredByBackoff: 0,
        filtered: 0,
        planned: 0,
        attempted: 0,
        downloaded: 0,
        failed: 0,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      try {
        const state = await loadSubscriptionState(appService, catalog.id);
        state.lastCheckedAt = Date.now();
        await saveSubscriptionState(appService, state);
      } catch {
        // Best effort
      }
    }
  }

  return {
    newBooks: allNewBooks,
    totalNewBooks: allNewBooks.length,
    errors,
  };
}
