import type { Book, BookNote, CWABookSourceRef } from '@/types/book';
import type { AppService } from '@/types/system';
import type { BookOrbitSettings, CWASubscription, SystemSettings } from '@/types/settings';
import type { OPDSCatalog } from '@/types/opds';
import { DEFAULT_BOOKORBIT_SETTINGS } from '@/services/constants';
import {
  CWA_AUTO_SYNC_INTERVAL_MS,
  CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
  CWA_DEFAULT_QUEUE_TARGET,
  CWA_DOWNLOAD_CONCURRENCY,
  CWA_DOWNLOAD_DELAY_MS,
  discoverOPDSShelvesAt,
} from '@/services/cwa';
import type {
  CWAShelfCandidate,
  CWASubscriptionReport,
  CWASyncOptions,
  CWASyncReport,
} from '@/services/cwa';
import { syncSubscribedCatalogs } from '@/services/opds';
import type { OPDSCatalogSyncStats } from '@/services/opds';
import type { PendingItem } from '@/services/opds/types';
import { computeOpdsCatalogContentId } from '@/services/sync/adapters/opdsCatalog';
import { BookOrbitClient } from './BookOrbitClient';
import { BookOrbitSyncStore } from './BookOrbitSyncStore';
import { formatKoDate } from './noteMapping';
import type { BookOrbitCatalogBookDetail } from './types';

const trimTrailingSlashes = (value: string): string => value.trim().replace(/\/+$/, '');

export type NormalizedBookOrbitSettings = BookOrbitSettings & {
  opdsUsername: string;
  opdsPassword: string;
  subscriptions: CWASubscription[];
};

export const getBookOrbitSettings = (settings: SystemSettings): NormalizedBookOrbitSettings => ({
  ...DEFAULT_BOOKORBIT_SETTINGS,
  ...settings.bookorbit,
  opdsUsername: settings.bookorbit?.opdsUsername ?? '',
  opdsPassword: settings.bookorbit?.opdsPassword ?? '',
  subscriptions: settings.bookorbit?.subscriptions ?? [],
});

export const getBookOrbitOPDSUrl = (settings: Partial<BookOrbitSettings>): string => {
  const base = trimTrailingSlashes(settings.serverUrl ?? '');
  return base ? `${base}/api/v1/opds` : '';
};

export const hasEnabledBookOrbitSubscriptions = (settings: SystemSettings): boolean => {
  const bookorbit = getBookOrbitSettings(settings);
  return (
    !!getBookOrbitOPDSUrl(bookorbit) &&
    !!bookorbit.opdsUsername &&
    !!bookorbit.opdsPassword &&
    bookorbit.subscriptions.some((subscription) => subscription.enabled)
  );
};

export const discoverBookOrbitSmartScopes = async (
  settings: Partial<BookOrbitSettings>,
): Promise<CWAShelfCandidate[]> =>
  discoverOPDSShelvesAt(
    getBookOrbitOPDSUrl(settings),
    settings.opdsUsername ?? '',
    settings.opdsPassword ?? '',
    {
      idPrefix: 'bookorbit-scope',
      containerPattern: /smart[\s_-]*scopes?/i,
      nestedOnly: true,
      customHeaders: settings.customHeaders,
    },
  );

export const getBookOrbitBookSources = (book: Book): CWABookSourceRef[] => {
  if (!book.bookorbitSource) return [];
  const primary: CWABookSourceRef = {
    subscriptionId: book.bookorbitSource.subscriptionId,
    subscriptionName: book.bookorbitSource.subscriptionName,
    catalogId: book.bookorbitSource.catalogId,
    entryId: book.bookorbitSource.entryId,
    sourceUrl: book.bookorbitSource.sourceUrl,
    downloadedAt: book.bookorbitSource.downloadedAt,
  };
  const sources = [primary, ...(book.bookorbitSource.sources ?? [])];
  const byKey = new Map<string, CWABookSourceRef>();
  for (const source of sources) {
    const key = `${source.subscriptionId}|${source.entryId ?? ''}|${source.sourceUrl ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, { ...source });
  }
  return Array.from(byKey.values());
};

export const addBookOrbitBookSource = (book: Book, source: CWABookSourceRef): void => {
  const existing = getBookOrbitBookSources(book);
  const key = `${source.subscriptionId}|${source.entryId ?? ''}|${source.sourceUrl ?? ''}`;
  if (
    !existing.some(
      (item) => `${item.subscriptionId}|${item.entryId ?? ''}|${item.sourceUrl ?? ''}` === key,
    )
  ) {
    existing.push({ ...source });
  }
  const primary = book.bookorbitSource ? { ...book.bookorbitSource } : { ...source };
  book.bookorbitSource = { ...primary, sources: existing.map((item) => ({ ...item })) };
};

const buildCatalog = (
  bookorbit: NormalizedBookOrbitSettings,
  subscription: CWASubscription,
): OPDSCatalog => ({
  id: `bookorbit-sub-${subscription.id}`,
  name: subscription.name,
  url: subscription.url,
  username: bookorbit.opdsUsername,
  password: bookorbit.opdsPassword,
  customHeaders: bookorbit.customHeaders,
  autoDownload: true,
  contentId: computeOpdsCatalogContentId(subscription.url),
});

const sourceKey = (source: Pick<CWABookSourceRef, 'subscriptionId' | 'entryId' | 'sourceUrl'>) =>
  `${source.subscriptionId}|${source.entryId ?? ''}|${source.sourceUrl ?? ''}`;

const BOOKORBIT_DETAIL_CONCURRENCY = 6;
const BOOKORBIT_ENTRY_ID_RE = /^urn:bookorbit:book:(\d+)$/i;

const getBookOrbitEntryBookId = (item: PendingItem): number | null => {
  const match = BOOKORBIT_ENTRY_ID_RE.exec(item.entryId);
  if (match?.[1]) return Number(match[1]);
  const downloadMatch = /\/opds\/(\d+)\/download(?:[/?#]|$)/i.exec(item.acquisitionHref);
  return downloadMatch?.[1] ? Number(downloadMatch[1]) : null;
};

const getPublicationTimestamp = (
  item: PendingItem,
  detail: BookOrbitCatalogBookDetail,
): number | null => {
  const published = detail.publishedDate || item.metadata?.published;
  if (published) {
    const timestamp = Date.parse(published);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  if (detail.publishedYear && detail.publishedYear >= 1000 && detail.publishedYear <= 9999) {
    return Date.UTC(detail.publishedYear, 0, 1);
  }
  return null;
};

const latestNoteChange = (notes: BookNote[]): number =>
  notes.reduce(
    (latest, note) => Math.max(latest, note.createdAt, note.updatedAt, note.deletedAt ?? 0),
    0,
  );

const areBookOrbitNotesSynced = async (
  store: BookOrbitSyncStore,
  book: Book,
  notes: BookNote[],
): Promise<boolean> => {
  for (const kind of ['annotation', 'bookmark'] as const) {
    const matching = notes.filter((note) => note.type === kind);
    if (matching.length === 0) continue;
    if (matching.some((note) => !note.deletedAt && !note.xpointer0)) return false;
    const watermark = await store.getWatermark(
      book.hash,
      kind === 'annotation' ? 'annotations' : 'bookmarks',
    );
    if (watermark < latestNoteChange(matching)) return false;
  }
  return true;
};

/**
 * Remove finished BookOrbit downloads only after their local highlights and
 * bookmarks are known to have completed a BookOrbit exchange. The finished
 * state is pushed in the same operation before any local file is removed, so
 * the server suppresses the title from unread SmartScope queues.
 */
export const cleanupFinishedBookOrbitBooks = async (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
): Promise<Book[]> => {
  const bookorbit = getBookOrbitSettings(settings);
  if (!bookorbit.syncBookStates) return [];

  const store = new BookOrbitSyncStore(appService);
  const ready: Book[] = [];
  for (const book of books) {
    if (book.deletedAt || book.readingStatus !== 'finished' || !book.bookorbitSource) continue;
    const config = await appService.loadBookConfig(book, settings);
    const notes = config.booknotes ?? [];
    if (notes.length > 0 && !bookorbit.syncNotes) continue;
    if (!(await areBookOrbitNotesSynced(store, book, notes))) continue;
    ready.push(book);
  }
  if (ready.length === 0) return [];

  try {
    await new BookOrbitClient(bookorbit).uploadBookStates(
      ready.map((book) => ({
        hash: book.hash,
        status: 'complete',
        statusModified: formatKoDate(book.readingStatusUpdatedAt ?? Date.now()),
      })),
    );
  } catch (error) {
    console.warn('[BookOrbit] finished-book state push failed; keeping local downloads', error);
    return [];
  }

  const cleaned: Book[] = [];
  for (const book of ready) {
    await appService.deleteBook(book, 'local');
    book.deletedAt = Date.now();
    book.updatedAt = Date.now();
    book.downloadedAt = null;
    book.coverDownloadedAt = null;
    cleaned.push(book);
  }
  return cleaned;
};

const runSync = async (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
  options: CWASyncOptions = {},
) => {
  const startedAt = Date.now();
  const trigger = options.trigger ?? (options.dryRun ? 'preview' : 'manual');
  const bookorbit = getBookOrbitSettings(settings);
  if (!hasEnabledBookOrbitSubscriptions(settings)) {
    return { newBooks: [], totalNewBooks: 0, errors: [], cleanedBooks: [], report: null };
  }

  const selectedIds = options.subscriptionIds ? new Set(options.subscriptionIds) : null;
  const enabled = bookorbit.subscriptions.filter(
    (subscription) => subscription.enabled && (!selectedIds || selectedIds.has(subscription.id)),
  );
  const cleanedBooks = options.dryRun
    ? []
    : await cleanupFinishedBookOrbitBooks(appService, settings, books);
  const reports = new Map<string, CWASubscriptionReport>();
  const bookorbitClient = new BookOrbitClient(bookorbit);
  const detailByBookId = new Map<number, Promise<BookOrbitCatalogBookDetail>>();
  const getBookDetail = (bookId: number) => {
    let detail = detailByBookId.get(bookId);
    if (!detail) {
      detail = bookorbitClient.getCatalogBookDetail(bookId);
      detailByBookId.set(bookId, detail);
    }
    return detail;
  };
  const catalogs: OPDSCatalog[] = [];
  const byCatalogId = new Map<string, CWASubscription>();
  const limitByCatalogId: Record<string, number> = {};

  for (const subscription of enabled) {
    let readyBefore = 0;
    for (const book of books) {
      if (book.deletedAt || ![undefined, 'unread', 'reading'].includes(book.readingStatus))
        continue;
      if (
        !getBookOrbitBookSources(book).some((source) => source.subscriptionId === subscription.id)
      ) {
        continue;
      }
      const available = appService.isBookAvailable
        ? await appService.isBookAvailable(book)
        : book.downloadedAt !== null;
      if (available) readyBefore += 1;
    }

    const queueTarget = subscription.queueTarget ?? CWA_DEFAULT_QUEUE_TARGET;
    const deficit = Math.max(0, queueTarget - readyBefore);
    reports.set(subscription.id, {
      subscriptionId: subscription.id,
      subscriptionName: subscription.name,
      queueTarget,
      readyBefore,
      deficit,
      discovered: 0,
      deferredByBackoff: 0,
      skippedServerRead: 0,
      skippedSuppressed: 0,
      planned: 0,
      attempted: 0,
      downloaded: 0,
      failed: 0,
    });
    const retryEntryIds = options.retryEntryIdsBySubscription?.[subscription.id] ?? [];
    if (deficit === 0 && retryEntryIds.length === 0) continue;
    const catalog = buildCatalog(bookorbit, subscription);
    catalogs.push(catalog);
    byCatalogId.set(catalog.id, subscription);
    limitByCatalogId[catalog.id] = retryEntryIds.length
      ? retryEntryIds.length
      : Math.min(deficit, subscription.maxDownloadsPerSync ?? CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC);
  }

  const localFinishedKeys = new Set(
    books
      .filter((book) => book.readingStatus === 'finished' && !book.deletedAt)
      .flatMap((book) => getBookOrbitBookSources(book).map(sourceKey)),
  );
  const result = await syncSubscribedCatalogs(catalogs, appService, books, {
    limitByCatalogId,
    onlyEntryIdsByCatalogId: Object.fromEntries(
      catalogs.flatMap((catalog) => {
        const subscription = byCatalogId.get(catalog.id);
        const entryIds = subscription
          ? options.retryEntryIdsBySubscription?.[subscription.id]
          : undefined;
        return entryIds ? [[catalog.id, entryIds]] : [];
      }),
    ),
    downloadConcurrency: CWA_DOWNLOAD_CONCURRENCY,
    delayBetweenDownloadsMs: CWA_DOWNLOAD_DELAY_MS,
    dryRun: options.dryRun,
    sortItems: async ({ items }) => {
      const itemBookIds = items.map((item) => {
        const bookId = getBookOrbitEntryBookId(item);
        if (!bookId) {
          throw new Error(`BookOrbit returned an unrecognized OPDS entry ID: ${item.entryId}`);
        }
        return { item, bookId };
      });
      let nextIndex = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(BOOKORBIT_DETAIL_CONCURRENCY, itemBookIds.length) },
          async () => {
            while (nextIndex < itemBookIds.length) {
              const current = itemBookIds[nextIndex++];
              if (current) await getBookDetail(current.bookId);
            }
          },
        ),
      );
      const indexed = await Promise.all(
        itemBookIds.map(async ({ item, bookId }, index) => ({
          item,
          index,
          publishedAt: getPublicationTimestamp(item, await getBookDetail(bookId)),
        })),
      );
      indexed.sort((a, b) => {
        if (a.publishedAt === null && b.publishedAt === null) return a.index - b.index;
        if (a.publishedAt === null) return 1;
        if (b.publishedAt === null) return -1;
        return b.publishedAt - a.publishedAt || a.index - b.index;
      });
      return indexed.map(({ item }) => item);
    },
    shouldSkipItem: async ({ item, catalogId, sourceUrl }) => {
      const subscription = byCatalogId.get(catalogId);
      if (!subscription) return false;
      const bookId = getBookOrbitEntryBookId(item);
      if (!bookId) {
        throw new Error(`BookOrbit returned an unrecognized OPDS entry ID: ${item.entryId}`);
      }
      const detail = await getBookDetail(bookId);
      if (detail.readStatus === 'read' || detail.readStatus === 'skimmed') {
        const report = reports.get(subscription.id);
        if (report) report.skippedServerRead += 1;
        return true;
      }
      const finished = localFinishedKeys.has(
        sourceKey({ subscriptionId: subscription.id, entryId: item.entryId, sourceUrl }),
      );
      if (finished) {
        const report = reports.get(subscription.id);
        if (report) report.skippedSuppressed += 1;
      }
      return finished;
    },
    onBookImported: ({ book, catalogId, catalogName, sourceUrl, item }) => {
      const subscription = byCatalogId.get(catalogId);
      if (!subscription) return;
      addBookOrbitBookSource(book, {
        subscriptionId: subscription.id,
        subscriptionName: subscription.name || catalogName,
        catalogId,
        entryId: item.entryId,
        sourceUrl,
        downloadedAt: Date.now(),
      });
    },
    onCatalogComplete: (stats: OPDSCatalogSyncStats) => {
      const subscription = byCatalogId.get(stats.catalogId);
      const report = subscription ? reports.get(subscription.id) : undefined;
      if (!report) return;
      report.discovered = stats.discovered;
      report.deferredByBackoff = stats.deferredByBackoff;
      report.planned = stats.planned;
      report.attempted = stats.attempted;
      report.downloaded = stats.downloaded;
      report.failed = stats.failed;
      report.nextRetryAt = stats.nextRetryAt;
      report.error = stats.error;
    },
  });

  const subscriptions = Array.from(reports.values());
  const failedCount = subscriptions.reduce((sum, report) => sum + report.failed, 0);
  const errorCount = subscriptions.filter((report) => report.error).length + result.errors.length;
  const report: CWASyncReport = {
    version: 1,
    trigger,
    startedAt,
    completedAt: Date.now(),
    lastQueueSyncAt: options.dryRun ? undefined : Date.now(),
    status: options.dryRun
      ? 'preview'
      : errorCount === 0 && failedCount === 0
        ? 'success'
        : result.totalNewBooks > 0
          ? 'partial'
          : 'failed',
    totalDownloaded: result.totalNewBooks,
    totalCleaned: cleanedBooks.length,
    subscriptions,
  };
  return { ...result, cleanedBooks, report };
};

let activeSync: ReturnType<typeof runSync> | null = null;

export const syncBookOrbitSubscriptions = (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
  options: CWASyncOptions = {},
) => {
  if (activeSync) return activeSync;
  activeSync = runSync(appService, settings, books, options).finally(() => {
    activeSync = null;
  });
  return activeSync;
};

export const shouldRunBookOrbitAutoSync = (settings: SystemSettings): boolean => {
  const lastSyncedAt = getBookOrbitSettings(settings).lastLibrarySyncedAt ?? 0;
  return Date.now() - lastSyncedAt >= CWA_AUTO_SYNC_INTERVAL_MS;
};
