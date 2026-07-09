import type { Book, BookConfig } from '@/types/book';
import type { AppService } from '@/types/system';
import type { CWASettings, CWASubscription, SystemSettings } from '@/types/settings';
import type { OPDSCatalog } from '@/types/opds';
import { DEFAULT_CWA_SETTINGS } from './constants';
import { syncSubscribedCatalogs } from './opds';
import { computeOpdsCatalogContentId } from './sync/adapters/opdsCatalog';

export const CWA_CATALOG_ID = 'alfaro-cwa';
export const CWA_CATALOG_NAME = 'Alfaro CWA';

const trimTrailingSlashes = (value: string): string => value.trim().replace(/\/+$/, '');
const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);

export const normalizeCWABaseUrl = (url?: string): string => {
  const raw = trimTrailingSlashes(url || DEFAULT_CWA_SETTINGS.serverUrl);
  if (/\/opds$/i.test(raw)) return trimTrailingSlashes(raw.replace(/\/opds$/i, ''));
  if (/\/kosync$/i.test(raw)) return trimTrailingSlashes(raw.replace(/\/kosync$/i, ''));
  return raw;
};

export const getCWAOPDSUrl = (settings?: Partial<CWASettings>): string =>
  `${normalizeCWABaseUrl(settings?.serverUrl)}/opds`;

export const getCWAKOSyncUrl = (settings?: Partial<CWASettings>): string =>
  `${normalizeCWABaseUrl(settings?.serverUrl)}/kosync`;

export const resolveCWAUrl = (settings: Partial<CWASettings> | undefined, pathOrUrl: string) => {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${normalizeCWABaseUrl(settings?.serverUrl)}${ensureLeadingSlash(pathOrUrl)}`;
};

export const getCWASettings = (settings: SystemSettings): CWASettings => ({
  ...DEFAULT_CWA_SETTINGS,
  ...(settings.cwa ?? {}),
  subscriptions: settings.cwa?.subscriptions ?? DEFAULT_CWA_SETTINGS.subscriptions,
});

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
  const enabled = cwa.subscriptions.filter((sub) => sub.enabled);
  const catalogs = enabled.map((sub) => buildSubscriptionCatalog(cwa, sub));
  const byCatalogId = new Map(catalogs.map((catalog, index) => [catalog.id, enabled[index]!]));
  const limitByCatalogId = Object.fromEntries(
    catalogs.map((catalog, index) => [catalog.id, Math.max(1, enabled[index]!.limit || 25)]),
  );

  const result = await syncSubscribedCatalogs(catalogs, appService, books, {
    limitByCatalogId,
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
