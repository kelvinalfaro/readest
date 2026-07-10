import { getFeed, isOPDSCatalog } from 'foliate-js/opds.js';
import type { Book, BookConfig, CWABookSourceRef } from '@/types/book';
import type { AppService } from '@/types/system';
import type { CWASettings, CWASubscription, SystemSettings } from '@/types/settings';
import type { OPDSCatalog, OPDSFeed, OPDSNavigationItem } from '@/types/opds';
import { fetchWithAuth } from '@/app/opds/utils/opdsReq';
import { looksLikeXMLContent, parseOPDSXML, resolveURL } from '@/app/opds/utils/opdsUtils';
import { isWebAppPlatform } from '@/services/environment';
import { DEFAULT_CWA_SETTINGS } from './constants';
import { syncSubscribedCatalogs } from './opds';
import type { OPDSCatalogSyncStats } from './opds';
import {
  deleteSubscriptionState,
  loadSubscriptionState,
  saveSubscriptionState,
} from './opds/subscriptionState';
import { computeOpdsCatalogContentId } from './sync/adapters/opdsCatalog';

export const CWA_CATALOG_ID = 'cwa-library';
export const CWA_CATALOG_NAME = 'CWA Library';
export const CWA_DEFAULT_SUBSCRIPTION_LIMIT = 10;
export const CWA_DEFAULT_QUEUE_TARGET = 10;
export const CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC = 3;
export const CWA_DOWNLOAD_CONCURRENCY = 1;
export const CWA_DOWNLOAD_DELAY_MS = 5000;
export const CWA_AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CWA_STATE_DIR = 'CWA';
const CWA_READ_STATE_PATH = `${CWA_STATE_DIR}/read-suppression.json`;
const CWA_SYNC_STATUS_PATH = `${CWA_STATE_DIR}/sync-status.json`;

export type CWASyncTrigger = 'manual' | 'pull' | 'startup' | 'preview' | 'retry';

export interface CWASubscriptionReport {
  subscriptionId: string;
  subscriptionName: string;
  queueTarget: number;
  readyBefore: number;
  deficit: number;
  discovered: number;
  deferredByBackoff: number;
  skippedServerRead: number;
  skippedSuppressed: number;
  planned: number;
  attempted: number;
  downloaded: number;
  failed: number;
  nextRetryAt?: number;
  error?: string;
}

export interface CWASyncReport {
  version: 1;
  trigger: CWASyncTrigger;
  startedAt: number;
  completedAt: number;
  lastQueueSyncAt?: number;
  status: 'success' | 'partial' | 'failed' | 'preview';
  totalDownloaded: number;
  totalCleaned: number;
  subscriptions: CWASubscriptionReport[];
}

export interface CWASyncOptions {
  trigger?: CWASyncTrigger;
  dryRun?: boolean;
  subscriptionIds?: string[];
  retryEntryIdsBySubscription?: Record<string, string[]>;
}

export interface CWAShelfCandidate {
  id: string;
  name: string;
  url: string;
}

interface CWAReadSuppressionEntry {
  subscriptionId: string;
  catalogId: string;
  entryId?: string;
  sourceUrl?: string;
  title?: string;
  bookHash?: string;
  finishedAt: number;
}

interface CWAReadSuppressionState {
  version: 1;
  entries: CWAReadSuppressionEntry[];
}

const trimTrailingSlashes = (value: string): string => value.trim().replace(/\/+$/, '');
const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);

export const normalizeCWABaseUrl = (url?: string): string => {
  const raw = trimTrailingSlashes(url || '');
  if (!raw) return '';
  if (/\/opds$/i.test(raw)) return trimTrailingSlashes(raw.replace(/\/opds$/i, ''));
  if (/\/kosync$/i.test(raw)) return trimTrailingSlashes(raw.replace(/\/kosync$/i, ''));
  return raw;
};

export const getCWAOPDSUrl = (settings?: Partial<CWASettings>): string => {
  const base = normalizeCWABaseUrl(settings?.serverUrl);
  return base ? `${base}/opds` : '';
};

export const getCWAKOSyncUrl = (settings?: Partial<CWASettings>): string => {
  const base = normalizeCWABaseUrl(settings?.serverUrl);
  return base ? `${base}/kosync` : '';
};

export const resolveCWAUrl = (settings: Partial<CWASettings> | undefined, pathOrUrl: string) => {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = normalizeCWABaseUrl(settings?.serverUrl);
  return base ? `${base}${ensureLeadingSlash(pathOrUrl)}` : ensureLeadingSlash(pathOrUrl);
};

const normalizeSubscription = (subscription: CWASubscription): CWASubscription => ({
  ...subscription,
  queueTarget: Math.max(
    1,
    subscription.queueTarget ?? subscription.limit ?? CWA_DEFAULT_QUEUE_TARGET,
  ),
  maxDownloadsPerSync: Math.max(
    1,
    subscription.maxDownloadsPerSync ?? CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
  ),
});

export const getCWASettings = (settings: SystemSettings): CWASettings => ({
  ...DEFAULT_CWA_SETTINGS,
  ...(settings.cwa ?? {}),
  subscriptions: (settings.cwa?.subscriptions ?? DEFAULT_CWA_SETTINGS.subscriptions).map(
    normalizeSubscription,
  ),
});

export const isCWAConfigured = (settings: SystemSettings): boolean => {
  const cwa = getCWASettings(settings);
  return cwa.enabled && !!normalizeCWABaseUrl(cwa.serverUrl);
};

export const hasEnabledCWASubscriptions = (settings: SystemSettings): boolean => {
  const cwa = getCWASettings(settings);
  return isCWAConfigured(settings) && cwa.subscriptions.some((sub) => sub.enabled);
};

export const buildCWACatalog = (settings: Partial<CWASettings>): OPDSCatalog => {
  const url = getCWAOPDSUrl(settings);
  return {
    id: CWA_CATALOG_ID,
    name: CWA_CATALOG_NAME,
    url,
    description: 'Browse and download from Calibre-Web-Automated.',
    username: settings.username || undefined,
    password: settings.password || undefined,
    autoDownload: false,
    contentId: computeOpdsCatalogContentId(url),
    addedAt: Date.now(),
  };
};

const STRUCTURAL_RELS = new Set(['self', 'start', 'up', 'top', 'search', 'related']);
const SHELF_RE = /shelf|shelves|magic|unread|reading|read|new|recent|latest|books/i;
const CONTAINER_RE = /shelf|shelves|magic/i;

const itemRels = (item: OPDSNavigationItem): string[] =>
  Array.isArray(item.rel) ? item.rel : [item.rel ?? ''];

const isStructuralNavigation = (item: OPDSNavigationItem): boolean =>
  itemRels(item).some((rel) => STRUCTURAL_RELS.has(rel));

const isShelfLike = (item: OPDSNavigationItem): boolean =>
  !!item.href && !isStructuralNavigation(item) && SHELF_RE.test(`${item.title ?? ''} ${item.href}`);

const isShelfContainer = (item: OPDSNavigationItem): boolean =>
  !!item.href &&
  !isStructuralNavigation(item) &&
  (!item.type || isOPDSCatalog(item.type)) &&
  CONTAINER_RE.test(`${item.title ?? ''} ${item.href}`);

const parseOPDSFeed = (text: string): OPDSFeed | null => {
  if (looksLikeXMLContent(text)) {
    const doc = parseOPDSXML(text);
    if (doc.documentElement.localName === 'feed') return getFeed(doc) as OPDSFeed;
  } else {
    try {
      return JSON.parse(text) as OPDSFeed;
    } catch {
      return null;
    }
  }
  return null;
};

const emptyReadSuppressionState = (): CWAReadSuppressionState => ({ version: 1, entries: [] });

const normalizeSourceUrl = (url?: string): string => (url || '').trim();

const sourceRefKey = (source: Pick<CWABookSourceRef, 'subscriptionId' | 'entryId' | 'sourceUrl'>) =>
  `${source.subscriptionId}:${source.entryId || normalizeSourceUrl(source.sourceUrl)}`;

export const getCWABookSources = (book: Book): CWABookSourceRef[] => {
  if (!book.cwaSource) return [];
  const primary: CWABookSourceRef = {
    subscriptionId: book.cwaSource.subscriptionId,
    subscriptionName: book.cwaSource.subscriptionName,
    catalogId: book.cwaSource.catalogId,
    entryId: book.cwaSource.entryId,
    sourceUrl: book.cwaSource.sourceUrl,
    downloadedAt: book.cwaSource.downloadedAt,
  };
  const byKey = new Map<string, CWABookSourceRef>();
  for (const source of [primary, ...(book.cwaSource.sources ?? [])]) {
    byKey.set(sourceRefKey(source), source);
  }
  return Array.from(byKey.values());
};

export const addCWABookSource = (book: Book, source: CWABookSourceRef) => {
  const existing = getCWABookSources(book);
  const byKey = new Map(existing.map((item) => [sourceRefKey(item), item]));
  byKey.set(sourceRefKey(source), source);
  if (!book.cwaSource) {
    book.cwaSource = source;
  }
  book.cwaSource.sources = Array.from(byKey.values());
};

const readSuppressionKey = (entry: {
  subscriptionId: string;
  entryId?: string;
  sourceUrl?: string;
}) => `${entry.subscriptionId}:${entry.entryId || normalizeSourceUrl(entry.sourceUrl)}`;

const loadReadSuppressionState = async (
  appService: AppService,
): Promise<CWAReadSuppressionState> => {
  try {
    const exists = await appService.exists(CWA_READ_STATE_PATH, 'Data');
    if (!exists) return emptyReadSuppressionState();
    const content = await appService.readFile(CWA_READ_STATE_PATH, 'Data', 'text');
    const parsed = JSON.parse(content as string) as CWAReadSuppressionState;
    return {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    console.error('CWA: failed to load read suppression state, using empty state');
    return emptyReadSuppressionState();
  }
};

const saveReadSuppressionState = async (appService: AppService, state: CWAReadSuppressionState) => {
  await appService.createDir(CWA_STATE_DIR, 'Data', true);
  await appService.writeFile(CWA_READ_STATE_PATH, 'Data', JSON.stringify(state, null, 2));
};

export const loadCWASyncReport = async (appService: AppService): Promise<CWASyncReport | null> => {
  try {
    if (!(await appService.exists(CWA_SYNC_STATUS_PATH, 'Data'))) return null;
    const content = await appService.readFile(CWA_SYNC_STATUS_PATH, 'Data', 'text');
    const report = JSON.parse(content as string) as CWASyncReport;
    return report?.version === 1 ? report : null;
  } catch {
    console.error('CWA: failed to load sync report');
    return null;
  }
};

const saveCWASyncReport = async (appService: AppService, report: CWASyncReport) => {
  await appService.createDir(CWA_STATE_DIR, 'Data', true);
  await appService.writeFile(CWA_SYNC_STATUS_PATH, 'Data', JSON.stringify(report, null, 2));
};

export const recordFinishedCWAReadSuppressions = async (
  appService: AppService,
  books: Book[],
): Promise<CWAReadSuppressionEntry[]> => {
  const finished = books.filter(
    (book) =>
      !book.deletedAt &&
      book.readingStatus === 'finished' &&
      getCWABookSources(book).some((source) => source.entryId || source.sourceUrl),
  );
  if (finished.length === 0) return [];

  const state = await loadReadSuppressionState(appService);
  const byKey = new Map(state.entries.map((entry) => [readSuppressionKey(entry), entry]));
  const recorded: CWAReadSuppressionEntry[] = [];
  const now = Date.now();

  for (const book of finished) {
    for (const source of getCWABookSources(book)) {
      const entry: CWAReadSuppressionEntry = {
        subscriptionId: source.subscriptionId,
        catalogId: source.catalogId,
        entryId: source.entryId,
        sourceUrl: source.sourceUrl,
        title: book.title,
        bookHash: book.hash,
        finishedAt: book.readingStatusUpdatedAt ?? now,
      };
      byKey.set(readSuppressionKey(entry), entry);
      recorded.push(entry);
    }
  }

  await saveReadSuppressionState(appService, { version: 1, entries: Array.from(byKey.values()) });
  return recorded;
};

const fetchCWAFeed = async (
  url: string,
  username: string,
  password: string,
): Promise<{ feed: OPDSFeed; baseURL: string } | null> => {
  const response = await fetchWithAuth(url, username, password, isWebAppPlatform());
  if (!response.ok) return null;
  const text = await response.text();
  const feed = parseOPDSFeed(text);
  if (!feed) return null;
  return { feed, baseURL: response.url || url };
};

const addCandidate = (
  candidates: Map<string, CWAShelfCandidate>,
  item: OPDSNavigationItem,
  baseURL: string,
) => {
  if (!item.href) return;
  const url = resolveURL(item.href, baseURL);
  candidates.set(url, {
    id: `cwa-discovered-${computeOpdsCatalogContentId(url)}`,
    name: item.title?.trim() || url,
    url,
  });
};

export const discoverCWAShelves = async (
  settings: Partial<CWASettings>,
): Promise<CWAShelfCandidate[]> => {
  const rootUrl = getCWAOPDSUrl(settings);
  if (!rootUrl) return [];

  const username = settings.username || '';
  const password = settings.password || '';
  const root = await fetchCWAFeed(rootUrl, username, password);
  if (!root) return [];

  const candidates = new Map<string, CWAShelfCandidate>();
  const rootNavigation = root.feed.navigation ?? [];
  for (const item of rootNavigation) {
    if (isShelfLike(item)) addCandidate(candidates, item, root.baseURL);
  }

  const containers = rootNavigation.filter(isShelfContainer).slice(0, 8);
  for (const container of containers) {
    const feedUrl = resolveURL(container.href!, root.baseURL);
    const nested = await fetchCWAFeed(feedUrl, username, password);
    if (!nested) continue;
    for (const item of nested.feed.navigation ?? []) {
      if (isShelfLike(item) || (!isStructuralNavigation(item) && item.href)) {
        addCandidate(candidates, item, nested.baseURL);
      }
    }
  }

  return Array.from(candidates.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const buildSubscriptionCatalog = (
  cwa: CWASettings,
  subscription: CWASubscription,
): OPDSCatalog => ({
  id: `cwa-sub-${subscription.id}`,
  name: subscription.name,
  url: resolveCWAUrl(cwa, subscription.url),
  username: cwa.username || undefined,
  password: cwa.password || undefined,
  autoDownload: true,
  contentId: computeOpdsCatalogContentId(resolveCWAUrl(cwa, subscription.url)),
});

const runCWASubscriptionSync = async (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
  options: CWASyncOptions = {},
) => {
  const startedAt = Date.now();
  const trigger = options.trigger ?? (options.dryRun ? 'preview' : 'manual');
  const cwa = getCWASettings(settings);
  if (!hasEnabledCWASubscriptions(settings)) {
    return { newBooks: [], totalNewBooks: 0, errors: [], cleanedBooks: [], report: null };
  }
  const previousReport = await loadCWASyncReport(appService);
  const selectedIds = options.subscriptionIds ? new Set(options.subscriptionIds) : null;
  const enabled = cwa.subscriptions.filter(
    (sub) => sub.enabled && (!selectedIds || selectedIds.has(sub.id)),
  );

  let cleanedBooks: Book[] = [];
  if (!options.dryRun) {
    await recordFinishedCWAReadSuppressions(appService, books);
    cleanedBooks = await cleanupFinishedCWABooks(appService, settings, books);
  }

  const reports = new Map<string, CWASubscriptionReport>();
  const catalogs: OPDSCatalog[] = [];
  const byCatalogId = new Map<string, CWASubscription>();
  const limitByCatalogId: Record<string, number> = {};

  for (const subscription of enabled) {
    let readyBefore = 0;
    for (const book of books) {
      if (book.deletedAt || ![undefined, 'unread', 'reading'].includes(book.readingStatus))
        continue;
      if (!getCWABookSources(book).some((source) => source.subscriptionId === subscription.id)) {
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
    const catalog = buildSubscriptionCatalog(cwa, subscription);
    catalogs.push(catalog);
    byCatalogId.set(catalog.id, subscription);
    limitByCatalogId[catalog.id] = retryEntryIds.length
      ? retryEntryIds.length
      : Math.min(deficit, subscription.maxDownloadsPerSync ?? CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC);
  }

  const readState = await loadReadSuppressionState(appService);
  const suppressedKeys = new Set(readState.entries.map(readSuppressionKey));
  const localFinishedKeys = new Set(
    books
      .filter((book) => book.readingStatus === 'finished' && !book.deletedAt && book.cwaSource)
      .flatMap((book) => getCWABookSources(book).map(readSuppressionKey)),
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
    shouldSkipItem: ({ item, catalogId, sourceUrl }) => {
      const subscription = byCatalogId.get(catalogId);
      if (!subscription) return false;
      if (subscription.excludeServerRead !== false && item.serverReadStatus === 'read') {
        const report = reports.get(subscription.id);
        if (report) report.skippedServerRead += 1;
        return true;
      }
      const key = readSuppressionKey({
        subscriptionId: subscription.id,
        entryId: item.entryId,
        sourceUrl,
      });
      const suppressed = suppressedKeys.has(key) || localFinishedKeys.has(key);
      if (suppressed) {
        const report = reports.get(subscription.id);
        if (report) report.skippedSuppressed += 1;
      }
      return suppressed;
    },
    onBookImported: ({ book, catalogId, catalogName, sourceUrl, item }) => {
      const subscription = byCatalogId.get(catalogId);
      if (!subscription) return;
      addCWABookSource(book, {
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
    lastQueueSyncAt: options.dryRun ? previousReport?.lastQueueSyncAt : Date.now(),
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
  await saveCWASyncReport(appService, report);

  return { ...result, cleanedBooks, report };
};

let activeCWASync: ReturnType<typeof runCWASubscriptionSync> | null = null;

export const syncCWASubscriptions = (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
  options: CWASyncOptions = {},
) => {
  if (activeCWASync) return activeCWASync;
  activeCWASync = runCWASubscriptionSync(appService, settings, books, options).finally(() => {
    activeCWASync = null;
  });
  return activeCWASync;
};

const hasUserNotes = (config: BookConfig): boolean => (config.booknotes ?? []).length > 0;

export const cleanupFinishedCWABooks = async (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
): Promise<Book[]> => {
  const cwa = getCWASettings(settings);
  const subscriptions = new Map(cwa.subscriptions.map((sub) => [sub.id, sub]));

  const cleaned: Book[] = [];
  for (const book of books) {
    if (book.deletedAt || book.readingStatus !== 'finished' || !book.cwaSource) continue;
    const sources = getCWABookSources(book);
    const sourceSubscriptions = sources
      .map((source) => subscriptions.get(source.subscriptionId))
      .filter((subscription): subscription is CWASubscription => !!subscription);
    if (
      sourceSubscriptions.length === 0 ||
      sourceSubscriptions.length !== sources.length ||
      sourceSubscriptions.some((subscription) => subscription.cleanupPolicy !== 'finished')
    ) {
      continue;
    }

    if (sourceSubscriptions.some((subscription) => !subscription.allowCleanupWithNotes)) {
      const config = await appService.loadBookConfig(book, settings);
      if (hasUserNotes(config)) continue;
    }

    await appService.deleteBook(book, 'local');
    await recordFinishedCWAReadSuppressions(appService, [book]);
    book.deletedAt = Date.now();
    book.updatedAt = Date.now();
    book.downloadedAt = null;
    book.coverDownloadedAt = null;
    cleaned.push(book);
  }
  return cleaned;
};

export const resetCWASyncHistory = async (appService: AppService, settings: SystemSettings) => {
  const cwa = getCWASettings(settings);
  for (const subscription of cwa.subscriptions) {
    await deleteSubscriptionState(appService, `cwa-sub-${subscription.id}`);
  }
  try {
    await appService.deleteFile(CWA_READ_STATE_PATH, 'Data');
  } catch {
    // Missing state is fine.
  }
  try {
    await appService.deleteFile(CWA_SYNC_STATUS_PATH, 'Data');
  } catch {
    // Missing state is fine.
  }
};

export const resetCWASubscriptionHistory = async (appService: AppService, subscriptionId: string) =>
  deleteSubscriptionState(appService, `cwa-sub-${subscriptionId}`);

export const retryFailedCWASubscription = async (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
  subscriptionId: string,
) => {
  const catalogId = `cwa-sub-${subscriptionId}`;
  const state = await loadSubscriptionState(appService, catalogId);
  const failedIds = new Set(state.failedEntries.map((entry) => entry.entryId));
  state.knownEntryIds = state.knownEntryIds.filter((entryId) => !failedIds.has(entryId));
  state.failedEntries = state.failedEntries.map((entry) => ({
    ...entry,
    attempts: 0,
    lastAttemptAt: 0,
  }));
  await saveSubscriptionState(appService, state);
  return syncCWASubscriptions(appService, settings, books, {
    trigger: 'retry',
    subscriptionIds: [subscriptionId],
    retryEntryIdsBySubscription: { [subscriptionId]: Array.from(failedIds) },
  });
};

export const shouldRunCWAAutoSync = async (appService: AppService): Promise<boolean> => {
  const report = await loadCWASyncReport(appService);
  return (
    !report?.lastQueueSyncAt || Date.now() - report.lastQueueSyncAt >= CWA_AUTO_SYNC_INTERVAL_MS
  );
};

export const testCWAConnection = async (settings: Partial<CWASettings>) => {
  const rootUrl = getCWAOPDSUrl(settings);
  if (!rootUrl) throw new Error('CWA server URL is required');
  const result = await fetchCWAFeed(rootUrl, settings.username || '', settings.password || '');
  if (!result) throw new Error('CWA OPDS connection failed');
  return { title: result.feed.metadata?.title || CWA_CATALOG_NAME, url: result.baseURL };
};
