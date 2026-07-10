import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import {
  cleanupFinishedCWABooks,
  CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
  CWA_DEFAULT_QUEUE_TARGET,
  CWA_DEFAULT_SUBSCRIPTION_LIMIT,
  CWA_DOWNLOAD_CONCURRENCY,
  CWA_DOWNLOAD_DELAY_MS,
  discoverCWAShelves,
  getCWAKOSyncUrl,
  getCWAOPDSUrl,
  getCWASettings,
  hasEnabledCWASubscriptions,
  normalizeCWABaseUrl,
  recordFinishedCWAReadSuppressions,
  retryFailedCWASubscription,
  resetCWASyncHistory,
  syncCWASubscriptions,
} from '@/services/cwa';

const syncSubscribedCatalogs = vi.hoisted(() => vi.fn());
const fetchWithAuth = vi.hoisted(() => vi.fn());
const deleteSubscriptionState = vi.hoisted(() => vi.fn());
const loadSubscriptionState = vi.hoisted(() => vi.fn());
const saveSubscriptionState = vi.hoisted(() => vi.fn());

vi.mock('@/services/opds', () => ({
  syncSubscribedCatalogs,
}));

vi.mock('@/services/opds/subscriptionState', () => ({
  deleteSubscriptionState,
  loadSubscriptionState,
  saveSubscriptionState,
}));

vi.mock('@/app/opds/utils/opdsReq', () => ({
  fetchWithAuth,
}));

vi.mock('@/services/environment', () => ({
  isWebAppPlatform: () => false,
}));

beforeEach(() => {
  syncSubscribedCatalogs.mockReset();
  syncSubscribedCatalogs.mockResolvedValue({ newBooks: [], totalNewBooks: 0, errors: [] });
  fetchWithAuth.mockReset();
  deleteSubscriptionState.mockReset();
  loadSubscriptionState.mockReset();
  saveSubscriptionState.mockReset();
});

const makeSettings = (overrides: Partial<SystemSettings> = {}): SystemSettings =>
  ({
    cwa: {
      enabled: true,
      serverUrl: 'https://cwa.example/books',
      username: 'alice',
      password: 'secret',
      subscriptions: [
        {
          id: 'new',
          name: 'New',
          url: '/opds/new',
          enabled: true,
          limit: 10,
          formatPreference: ['epub', 'kepub', 'pdf'],
          cleanupPolicy: 'never',
        },
        {
          id: 'disabled',
          name: 'Disabled',
          url: '/opds/disabled',
          enabled: false,
          limit: 10,
          formatPreference: ['epub', 'kepub', 'pdf'],
          cleanupPolicy: 'never',
        },
      ],
    },
    ...overrides,
  }) as SystemSettings;

const makeBook = (overrides: Partial<Book> = {}): Book =>
  ({
    hash: 'h1',
    format: 'EPUB',
    title: 'Book',
    author: 'Author',
    createdAt: 1,
    updatedAt: 1,
    downloadedAt: 1,
    ...overrides,
  }) as Book;

const makeAppService = (overrides: Partial<AppService> = {}): AppService =>
  ({
    exists: vi.fn(async () => false),
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => {}),
    createDir: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    deleteBook: vi.fn(async () => {}),
    loadBookConfig: vi.fn(async () => ({ updatedAt: 1, booknotes: [] })),
    ...overrides,
  }) as unknown as AppService;

describe('CWA URL helpers', () => {
  it('uses blank public defaults', () => {
    const settings = getCWASettings({} as SystemSettings);

    expect(settings.enabled).toBe(false);
    expect(settings.serverUrl).toBe('');
    expect(settings.subscriptions).toEqual([]);
    expect(getCWAOPDSUrl(settings)).toBe('');
    expect(getCWAKOSyncUrl(settings)).toBe('');
    expect(hasEnabledCWASubscriptions({ cwa: settings } as SystemSettings)).toBe(false);
  });

  it('normalizes CWA base, OPDS, and KOSync URLs without duplicates', () => {
    expect(normalizeCWABaseUrl('https://cwa.example/books/')).toBe('https://cwa.example/books');
    expect(getCWAOPDSUrl({ serverUrl: 'https://cwa.example/books/kosync' })).toBe(
      'https://cwa.example/books/opds',
    );
    expect(getCWAKOSyncUrl({ serverUrl: 'https://cwa.example/books/kosync' })).toBe(
      'https://cwa.example/books/kosync',
    );
  });
});

describe('syncCWASubscriptions', () => {
  it('skips sync when CWA is not configured', async () => {
    const result = await syncCWASubscriptions(
      {} as AppService,
      { cwa: undefined } as unknown as SystemSettings,
      [],
    );

    expect(result).toMatchObject({ newBooks: [], totalNewBooks: 0, errors: [] });
    expect(syncSubscribedCatalogs).not.toHaveBeenCalled();
  });

  it('syncs only enabled subscriptions and stamps imported books', async () => {
    const imported = makeBook({ hash: 'imported' });
    syncSubscribedCatalogs.mockImplementationOnce(
      async (_catalogs, _appService, _books, options) => {
        await options.onBookImported({
          book: imported,
          catalogId: 'cwa-sub-new',
          catalogName: 'New',
          sourceUrl: 'https://cwa.example/books/get/1.epub',
          item: {
            entryId: '1',
            title: 'Book',
            acquisitionHref: '/get/1.epub',
            mimeType: 'application/epub+zip',
            baseURL: 'https://cwa.example/books/opds/new',
          },
        });
        return { newBooks: [imported], totalNewBooks: 1, errors: [] };
      },
    );

    await syncCWASubscriptions(makeAppService(), makeSettings(), []);

    const [catalogs, , , options] = syncSubscribedCatalogs.mock.calls[0]!;
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0].url).toBe('https://cwa.example/books/opds/new');
    expect(options.limitByCatalogId).toEqual({
      'cwa-sub-new': CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
    });
    expect(options.downloadConcurrency).toBe(CWA_DOWNLOAD_CONCURRENCY);
    expect(options.delayBetweenDownloadsMs).toBe(CWA_DOWNLOAD_DELAY_MS);
    expect(imported.cwaSource).toMatchObject({
      subscriptionId: 'new',
      subscriptionName: 'New',
      catalogId: 'cwa-sub-new',
      entryId: '1',
      sourceUrl: 'https://cwa.example/books/get/1.epub',
    });
  });

  it('migrates the legacy limit to a queue target with a patient per-sync cap', () => {
    const settings = getCWASettings(makeSettings());

    expect(settings.subscriptions[0]).toMatchObject({
      limit: CWA_DEFAULT_SUBSCRIPTION_LIMIT,
      queueTarget: CWA_DEFAULT_QUEUE_TARGET,
      maxDownloadsPerSync: CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
    });
  });

  it('does not contact a shelf when its local queue is full', async () => {
    const ready = Array.from({ length: CWA_DEFAULT_QUEUE_TARGET }, (_, index) =>
      makeBook({
        hash: `ready-${index}`,
        readingStatus: 'unread',
        cwaSource: {
          subscriptionId: 'new',
          subscriptionName: 'New',
          catalogId: 'cwa-sub-new',
          entryId: `entry-${index}`,
          sourceUrl: `https://cwa.example/books/get/${index}.epub`,
          downloadedAt: 1,
        },
      }),
    );
    const appService = makeAppService({ isBookAvailable: vi.fn(async () => true) });

    const result = await syncCWASubscriptions(appService, makeSettings(), ready);

    expect(syncSubscribedCatalogs).toHaveBeenCalledWith([], appService, ready, expect.any(Object));
    expect(result.report?.subscriptions[0]).toMatchObject({
      readyBefore: CWA_DEFAULT_QUEUE_TARGET,
      deficit: 0,
      planned: 0,
    });
  });

  it('limits replenishment to the queue deficit', async () => {
    syncSubscribedCatalogs.mockResolvedValueOnce({ newBooks: [], totalNewBooks: 0, errors: [] });
    const ready = Array.from({ length: CWA_DEFAULT_QUEUE_TARGET - 2 }, (_, index) =>
      makeBook({
        hash: `ready-${index}`,
        readingStatus: 'reading',
        cwaSource: {
          subscriptionId: 'new',
          subscriptionName: 'New',
          catalogId: 'cwa-sub-new',
          entryId: `entry-${index}`,
          sourceUrl: `https://cwa.example/books/get/${index}.epub`,
          downloadedAt: 1,
        },
      }),
    );

    await syncCWASubscriptions(
      makeAppService({ isBookAvailable: vi.fn(async () => true) }),
      makeSettings(),
      ready,
    );

    expect(syncSubscribedCatalogs.mock.calls[0]![3].limitByCatalogId).toEqual({
      'cwa-sub-new': 2,
    });
  });

  it('passes dry-run through without cleanup and records a preview report', async () => {
    syncSubscribedCatalogs.mockImplementationOnce(async (_catalogs, _service, _books, options) => {
      expect(options.dryRun).toBe(true);
      return { newBooks: [], totalNewBooks: 0, errors: [] };
    });
    const appService = makeAppService();

    const result = await syncCWASubscriptions(appService, makeSettings(), [], {
      trigger: 'preview',
      dryRun: true,
    });

    expect(result.report?.status).toBe('preview');
    expect(appService.deleteBook).not.toHaveBeenCalled();
  });

  it('keeps all CWA shelf memberships when an existing book is imported again', async () => {
    const imported = makeBook({
      hash: 'shared',
      cwaSource: {
        subscriptionId: 'older',
        subscriptionName: 'Older',
        catalogId: 'cwa-sub-older',
        entryId: 'old-entry',
        sourceUrl: 'https://cwa.example/books/get/shared.epub',
        downloadedAt: 1,
      },
    });
    syncSubscribedCatalogs.mockImplementationOnce(
      async (_catalogs, _appService, _books, options) => {
        await options.onBookImported({
          book: imported,
          catalogId: 'cwa-sub-new',
          catalogName: 'New',
          sourceUrl: 'https://cwa.example/books/get/shared.epub',
          item: {
            entryId: 'new-entry',
            title: 'Shared',
            acquisitionHref: '/get/shared.epub',
            mimeType: 'application/epub+zip',
            baseURL: 'https://cwa.example/books/opds/new',
          },
        });
        return { newBooks: [imported], totalNewBooks: 1, errors: [] };
      },
    );

    await syncCWASubscriptions(makeAppService(), makeSettings(), []);

    expect(imported.cwaSource?.sources?.map((source) => source.subscriptionId)).toEqual([
      'older',
      'new',
    ]);
  });

  it('retries only failed entries even when the shelf queue is full', async () => {
    loadSubscriptionState.mockResolvedValueOnce({
      catalogId: 'cwa-sub-new',
      lastCheckedAt: 1,
      knownEntryIds: ['failed-entry'],
      failedEntries: [
        {
          entryId: 'failed-entry',
          href: '/get/failed.epub',
          title: 'Failed',
          attempts: 3,
          lastAttemptAt: 1,
        },
      ],
    });
    const ready = Array.from({ length: CWA_DEFAULT_QUEUE_TARGET }, (_, index) =>
      makeBook({
        hash: `ready-${index}`,
        readingStatus: 'unread',
        cwaSource: {
          subscriptionId: 'new',
          subscriptionName: 'New',
          catalogId: 'cwa-sub-new',
          entryId: `ready-entry-${index}`,
          sourceUrl: `https://cwa.example/books/get/${index}.epub`,
          downloadedAt: 1,
        },
      }),
    );

    await retryFailedCWASubscription(
      makeAppService({ isBookAvailable: vi.fn(async () => true) }),
      makeSettings(),
      ready,
      'new',
    );

    expect(saveSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        knownEntryIds: [],
        failedEntries: [expect.objectContaining({ attempts: 0, lastAttemptAt: 0 })],
      }),
    );
    expect(syncSubscribedCatalogs.mock.calls[0]![3]).toMatchObject({
      limitByCatalogId: { 'cwa-sub-new': 1 },
      onlyEntryIdsByCatalogId: { 'cwa-sub-new': ['failed-entry'] },
    });
  });

  it('skips server-read and locally finished CWA items', async () => {
    syncSubscribedCatalogs.mockResolvedValueOnce({ newBooks: [], totalNewBooks: 0, errors: [] });
    const finished = makeBook({
      readingStatus: 'finished',
      cwaSource: {
        subscriptionId: 'new',
        subscriptionName: 'New',
        catalogId: 'cwa-sub-new',
        entryId: 'finished-entry',
        sourceUrl: 'https://cwa.example/books/get/finished.epub',
        downloadedAt: 1,
      },
    });
    const appService = makeAppService();

    await syncCWASubscriptions(appService, makeSettings(), [finished]);

    const [, , , options] = syncSubscribedCatalogs.mock.calls[0]!;
    await expect(
      Promise.resolve(
        options.shouldSkipItem({
          item: {
            entryId: 'server-read',
            title: 'Read',
            acquisitionHref: '/get/read.epub',
            mimeType: 'application/epub+zip',
            baseURL: 'https://cwa.example/books/opds/new',
            serverReadStatus: 'read',
          },
          catalogId: 'cwa-sub-new',
          catalogName: 'New',
          sourceUrl: 'https://cwa.example/books/get/read.epub',
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      Promise.resolve(
        options.shouldSkipItem({
          item: {
            entryId: 'finished-entry',
            title: 'Finished',
            acquisitionHref: '/get/finished.epub',
            mimeType: 'application/epub+zip',
            baseURL: 'https://cwa.example/books/opds/new',
            serverReadStatus: 'unknown',
          },
          catalogId: 'cwa-sub-new',
          catalogName: 'New',
          sourceUrl: 'https://cwa.example/books/get/finished.epub',
        }),
      ),
    ).resolves.toBe(true);
  });
});

describe('discoverCWAShelves', () => {
  it('discovers shelf-like OPDS navigation entries and nested shelf items', async () => {
    fetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://cwa.example/books/opds',
        text: async () => `<?xml version="1.0" encoding="utf-8"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <title>CWA</title>
            <link rel="self" href="/books/opds" />
            <entry>
              <title>Magic Shelves</title>
              <link type="application/atom+xml;profile=opds-catalog" href="/books/opds/magic" />
            </entry>
            <entry>
              <title>Unread Books</title>
              <link type="application/atom+xml;profile=opds-catalog" href="/books/opds/unread" />
            </entry>
          </feed>`,
      })
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://cwa.example/books/opds/magic',
        text: async () => `<?xml version="1.0" encoding="utf-8"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <title>Magic Shelves</title>
            <entry>
              <title>Currently Reading</title>
              <link type="application/atom+xml;profile=opds-catalog" href="/books/opds/magic/1" />
            </entry>
          </feed>`,
      });

    const shelves = await discoverCWAShelves({
      serverUrl: 'https://cwa.example/books',
      username: 'alice',
      password: 'secret',
    });

    expect(shelves.map((shelf) => shelf.name)).toEqual([
      'Currently Reading',
      'Magic Shelves',
      'Unread Books',
    ]);
    expect(shelves[0]!.url).toBe('https://cwa.example/books/opds/magic/1');
  });
});

describe('cleanupFinishedCWABooks', () => {
  it('removes only finished CWA books when cleanup is enabled', async () => {
    const finished = makeBook({
      hash: 'finished',
      readingStatus: 'finished',
      cwaSource: {
        subscriptionId: 'new',
        subscriptionName: 'New',
        catalogId: 'cwa-sub-new',
        sourceUrl: 'https://cwa.example/books/get/1.epub',
        downloadedAt: 1,
      },
    });
    const unread = makeBook({
      hash: 'unread',
      readingStatus: 'unread',
      cwaSource: finished.cwaSource,
    });
    const deleteBook = vi.fn(async () => {});
    const appService = makeAppService({
      deleteBook,
      loadBookConfig: vi.fn(async () => ({ updatedAt: 1, booknotes: [] })),
    });
    const settings = makeSettings({
      cwa: {
        ...makeSettings().cwa,
        subscriptions: [{ ...makeSettings().cwa.subscriptions[0]!, cleanupPolicy: 'finished' }],
      },
    });

    const cleaned = await cleanupFinishedCWABooks(appService, settings, [finished, unread]);

    expect(cleaned).toEqual([finished]);
    expect(deleteBook).toHaveBeenCalledWith(finished, 'local');
    expect(finished.deletedAt).toBeTypeOf('number');
    expect(unread.deletedAt).toBeUndefined();
  });

  it('preserves finished books with notes by default', async () => {
    const book = makeBook({
      readingStatus: 'finished',
      cwaSource: {
        subscriptionId: 'new',
        subscriptionName: 'New',
        catalogId: 'cwa-sub-new',
        sourceUrl: 'https://cwa.example/books/get/1.epub',
        downloadedAt: 1,
      },
    });
    const appService = makeAppService({
      deleteBook: vi.fn(async () => {}),
      loadBookConfig: vi.fn(async () => ({
        updatedAt: 1,
        booknotes: [
          { id: 'n1', type: 'bookmark' as const, cfi: '/2', note: '', createdAt: 1, updatedAt: 1 },
        ],
      })),
    });
    const settings = makeSettings({
      cwa: {
        ...makeSettings().cwa,
        subscriptions: [{ ...makeSettings().cwa.subscriptions[0]!, cleanupPolicy: 'finished' }],
      },
    });

    const cleaned = await cleanupFinishedCWABooks(appService, settings, [book]);

    expect(cleaned).toEqual([]);
    expect(appService.deleteBook).not.toHaveBeenCalled();
  });
});

describe('CWA read suppression state', () => {
  it('records finished CWA books for future suppression', async () => {
    const appService = makeAppService();
    const book = makeBook({
      readingStatus: 'finished',
      readingStatusUpdatedAt: 123,
      cwaSource: {
        subscriptionId: 'new',
        subscriptionName: 'New',
        catalogId: 'cwa-sub-new',
        entryId: 'entry-1',
        sourceUrl: 'https://cwa.example/books/get/1.epub',
        downloadedAt: 1,
      },
    });

    const recorded = await recordFinishedCWAReadSuppressions(appService, [book]);

    expect(recorded).toHaveLength(1);
    expect(appService.writeFile).toHaveBeenCalledWith(
      'CWA/read-suppression.json',
      'Data',
      expect.stringContaining('"entryId": "entry-1"'),
    );
  });

  it('resets only CWA subscription and read suppression state', async () => {
    const appService = makeAppService();

    await resetCWASyncHistory(appService, makeSettings());

    expect(deleteSubscriptionState).toHaveBeenCalledWith(appService, 'cwa-sub-new');
    expect(deleteSubscriptionState).toHaveBeenCalledWith(appService, 'cwa-sub-disabled');
    expect(appService.deleteFile).toHaveBeenCalledWith('CWA/read-suppression.json', 'Data');
    expect(appService.deleteFile).toHaveBeenCalledWith('CWA/sync-status.json', 'Data');
  });
});
