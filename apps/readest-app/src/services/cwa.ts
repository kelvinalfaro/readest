import { getFeed, isOPDSCatalog } from 'foliate-js/opds.js';
import type { Book, BookConfig } from '@/types/book';
import type { AppService } from '@/types/system';
import type { CWASettings, CWASubscription, SystemSettings } from '@/types/settings';
import type { OPDSCatalog, OPDSFeed, OPDSNavigationItem } from '@/types/opds';
import { fetchWithAuth } from '@/app/opds/utils/opdsReq';
import { looksLikeXMLContent, parseOPDSXML, resolveURL } from '@/app/opds/utils/opdsUtils';
import { isWebAppPlatform } from '@/services/environment';
import { DEFAULT_CWA_SETTINGS } from './constants';
import { syncSubscribedCatalogs } from './opds';
import { computeOpdsCatalogContentId } from './sync/adapters/opdsCatalog';

export const CWA_CATALOG_ID = 'cwa-library';
export const CWA_CATALOG_NAME = 'CWA Library';
export const CWA_DEFAULT_SUBSCRIPTION_LIMIT = 10;
export const CWA_DOWNLOAD_CONCURRENCY = 1;
export const CWA_DOWNLOAD_DELAY_MS = 2000;

export interface CWAShelfCandidate {
  id: string;
  name: string;
  url: string;
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

export const getCWASettings = (settings: SystemSettings): CWASettings => ({
  ...DEFAULT_CWA_SETTINGS,
  ...(settings.cwa ?? {}),
  subscriptions: settings.cwa?.subscriptions ?? DEFAULT_CWA_SETTINGS.subscriptions,
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

export const syncCWASubscriptions = async (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
) => {
  const cwa = getCWASettings(settings);
  if (!hasEnabledCWASubscriptions(settings)) {
    return { newBooks: [], totalNewBooks: 0, errors: [] };
  }
  const enabled = cwa.subscriptions.filter((sub) => sub.enabled);
  const catalogs = enabled.map((sub) => buildSubscriptionCatalog(cwa, sub));
  const byCatalogId = new Map(catalogs.map((catalog, index) => [catalog.id, enabled[index]!]));
  const limitByCatalogId = Object.fromEntries(
    catalogs.map((catalog, index) => [
      catalog.id,
      Math.max(1, enabled[index]!.limit || CWA_DEFAULT_SUBSCRIPTION_LIMIT),
    ]),
  );

  const result = await syncSubscribedCatalogs(catalogs, appService, books, {
    limitByCatalogId,
    downloadConcurrency: CWA_DOWNLOAD_CONCURRENCY,
    delayBetweenDownloadsMs: CWA_DOWNLOAD_DELAY_MS,
    onBookImported: ({ book, catalogId, catalogName, sourceUrl }) => {
      const subscription = byCatalogId.get(catalogId);
      if (!subscription) return;
      book.cwaSource = {
        subscriptionId: subscription.id,
        subscriptionName: subscription.name || catalogName,
        catalogId,
        sourceUrl,
        downloadedAt: Date.now(),
      };
    },
  });

  return result;
};

const hasUserNotes = (config: BookConfig): boolean => (config.booknotes ?? []).length > 0;

export const cleanupFinishedCWABooks = async (
  appService: AppService,
  settings: SystemSettings,
  books: Book[],
): Promise<Book[]> => {
  const cwa = getCWASettings(settings);
  const cleanupSubs = new Map(
    cwa.subscriptions
      .filter((sub) => sub.cleanupPolicy === 'finished')
      .map((sub) => [sub.id, sub]),
  );
  if (cleanupSubs.size === 0) return [];

  const cleaned: Book[] = [];
  for (const book of books) {
    if (book.deletedAt || book.readingStatus !== 'finished' || !book.cwaSource) continue;
    const subscription = cleanupSubs.get(book.cwaSource.subscriptionId);
    if (!subscription) continue;

    if (!subscription.allowCleanupWithNotes) {
      const config = await appService.loadBookConfig(book, settings);
      if (hasUserNotes(config)) continue;
    }

    await appService.deleteBook(book, 'local');
    book.deletedAt = Date.now();
    book.updatedAt = Date.now();
    book.downloadedAt = null;
    book.coverDownloadedAt = null;
    cleaned.push(book);
  }
  return cleaned;
};
