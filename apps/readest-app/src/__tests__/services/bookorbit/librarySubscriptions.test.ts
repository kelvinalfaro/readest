import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import {
  cleanupFinishedBookOrbitBooks,
  discoverBookOrbitSmartScopes,
  getBookOrbitOPDSUrl,
  hasEnabledBookOrbitSubscriptions,
  syncBookOrbitSubscriptions,
} from '@/services/bookorbit/librarySubscriptions';
import { CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC, CWA_DEFAULT_QUEUE_TARGET } from '@/services/cwa';

const syncSubscribedCatalogs = vi.hoisted(() => vi.fn());
const fetchWithAuth = vi.hoisted(() => vi.fn());
const getWatermark = vi.hoisted(() => vi.fn());

vi.mock('@/services/opds', () => ({ syncSubscribedCatalogs }));
vi.mock('@/app/opds/utils/opdsReq', () => ({ fetchWithAuth }));
vi.mock('@/services/bookorbit/BookOrbitSyncStore', () => ({
  BookOrbitSyncStore: class {
    getWatermark = getWatermark;
  },
}));
vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => 'https://web.readest.com/api',
  isTauriAppPlatform: () => false,
  isWebAppPlatform: () => false,
}));

const makeSettings = (): SystemSettings =>
  ({
    bookorbit: {
      enabled: true,
      serverUrl: 'https://books.example.com/',
      username: 'ko-user',
      userkey: 'ko-key',
      deviceId: 'device',
      deviceName: 'Readest',
      strategy: 'prompt',
      syncProgress: true,
      syncNotes: true,
      syncStats: true,
      syncBookStates: true,
      opdsUsername: 'readest-opds',
      opdsPassword: 'secret',
      subscriptions: [
        {
          id: 'scope-1',
          name: 'Unread Gems',
          url: 'https://books.example.com/api/v1/opds/smart-scopes/1',
          enabled: true,
          queueTarget: CWA_DEFAULT_QUEUE_TARGET,
          maxDownloadsPerSync: CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
          formatPreference: ['epub', 'kepub', 'pdf'],
          cleanupPolicy: 'never',
          excludeServerRead: true,
        },
      ],
    },
  }) as SystemSettings;

const makeBook = (overrides: Partial<Book> = {}): Book =>
  ({
    hash: 'book',
    format: 'EPUB',
    title: 'Book',
    author: 'Author',
    createdAt: 1,
    updatedAt: 1,
    downloadedAt: 1,
    ...overrides,
  }) as Book;

const appService = {
  isBookAvailable: vi.fn(async () => true),
} as unknown as AppService;

beforeEach(() => {
  fetchWithAuth.mockReset();
  syncSubscribedCatalogs.mockReset();
  getWatermark.mockReset();
  syncSubscribedCatalogs.mockResolvedValue({ newBooks: [], totalNewBooks: 0, errors: [] });
});

describe('BookOrbit SmartScope discovery', () => {
  it('uses the BookOrbit OPDS root and returns only nested SmartScopes', async () => {
    fetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://books.example.com/api/v1/opds',
        text: async () => `<?xml version="1.0" encoding="utf-8"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <title>BookOrbit</title>
            <entry><title>All Books</title><link type="application/atom+xml;profile=opds-catalog" href="/api/v1/opds/books" /></entry>
            <entry><title>SmartScopes</title><link type="application/atom+xml;profile=opds-catalog" href="/api/v1/opds/smart-scopes" /></entry>
          </feed>`,
      })
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://books.example.com/api/v1/opds/smart-scopes',
        text: async () => `<?xml version="1.0" encoding="utf-8"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <title>SmartScopes</title>
            <entry><title>Unread Gems</title><link type="application/atom+xml;profile=opds-catalog" href="/api/v1/opds/smart-scopes/1" /></entry>
          </feed>`,
      });

    const scopes = await discoverBookOrbitSmartScopes(makeSettings().bookorbit);

    expect(getBookOrbitOPDSUrl(makeSettings().bookorbit)).toBe(
      'https://books.example.com/api/v1/opds',
    );
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      name: 'Unread Gems',
      url: 'https://books.example.com/api/v1/opds/smart-scopes/1',
    });
  });
});

describe('BookOrbit bounded subscriptions', () => {
  it('pushes finished state and deletes a finished download after its notes are synced', async () => {
    const finished = makeBook({
      hash: 'finished',
      readingStatus: 'finished',
      readingStatusUpdatedAt: 80,
      bookorbitSource: {
        subscriptionId: 'scope-1',
        subscriptionName: 'Unread Gems',
        catalogId: 'bookorbit-sub-scope-1',
        entryId: 'urn:bookorbit:book:7',
        sourceUrl: 'https://books.example.com/api/v1/opds/7/download',
        downloadedAt: 1,
      },
    });
    getWatermark.mockResolvedValue(100);
    const deleteBook = vi.fn(async () => {});
    let requestInit: RequestInit | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetch);
    const service = {
      isBookAvailable: vi.fn(async () => true),
      loadBookConfig: vi.fn(async () => ({
        updatedAt: 50,
        booknotes: [
          {
            id: 'note-1',
            type: 'annotation' as const,
            cfi: '/6/2',
            xpointer0: '/body/DocFragment[1]',
            text: 'Highlight',
            note: 'Note',
            createdAt: 40,
            updatedAt: 50,
          },
        ],
      })),
      deleteBook,
    } as unknown as AppService;

    const cleaned = await cleanupFinishedBookOrbitBooks(service, makeSettings(), [finished]);

    expect(cleaned).toEqual([finished]);
    expect(fetch).toHaveBeenCalledOnce();
    const request = JSON.parse(String(requestInit?.body)) as {
      endpoint: string;
      body: { books: Array<{ hash: string; status: string }> };
    };
    expect(request.endpoint).toBe('/plugin/book-states');
    expect(request.body.books).toEqual([
      { hash: 'finished', status: 'complete', statusModified: '1970-01-01' },
    ]);
    expect(deleteBook).toHaveBeenCalledWith(finished, 'local');
    expect(finished.deletedAt).toBeTypeOf('number');
    vi.unstubAllGlobals();
  });

  it('keeps a finished download until its latest annotation is confirmed synced', async () => {
    const finished = makeBook({
      hash: 'finished',
      readingStatus: 'finished',
      bookorbitSource: {
        subscriptionId: 'scope-1',
        subscriptionName: 'Unread Gems',
        catalogId: 'bookorbit-sub-scope-1',
        sourceUrl: 'https://books.example.com/api/v1/opds/7/download',
        downloadedAt: 1,
      },
    });
    getWatermark.mockResolvedValue(49);
    const deleteBook = vi.fn(async () => {});
    const service = {
      loadBookConfig: vi.fn(async () => ({
        updatedAt: 50,
        booknotes: [
          {
            id: 'note-1',
            type: 'annotation' as const,
            cfi: '/6/2',
            xpointer0: '/body/DocFragment[1]',
            text: 'Highlight',
            note: 'Unsynced note',
            createdAt: 40,
            updatedAt: 50,
          },
        ],
      })),
      deleteBook,
    } as unknown as AppService;

    const cleaned = await cleanupFinishedBookOrbitBooks(service, makeSettings(), [finished]);

    expect(cleaned).toEqual([]);
    expect(deleteBook).not.toHaveBeenCalled();
  });

  it('keeps a finished download when the finished-state push fails', async () => {
    const finished = makeBook({
      hash: 'finished',
      readingStatus: 'finished',
      bookorbitSource: {
        subscriptionId: 'scope-1',
        subscriptionName: 'Unread Gems',
        catalogId: 'bookorbit-sub-scope-1',
        sourceUrl: 'https://books.example.com/api/v1/opds/7/download',
        downloadedAt: 1,
      },
    });
    const deleteBook = vi.fn(async () => {});
    const service = {
      loadBookConfig: vi.fn(async () => ({ updatedAt: 50, booknotes: [] })),
      deleteBook,
    } as unknown as AppService;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => 'Unavailable' })),
    );

    const cleaned = await cleanupFinishedBookOrbitBooks(service, makeSettings(), [finished]);

    expect(cleaned).toEqual([]);
    expect(deleteBook).not.toHaveBeenCalled();
    expect(finished.deletedAt).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('requires OPDS credentials and an enabled SmartScope', () => {
    expect(hasEnabledBookOrbitSubscriptions(makeSettings())).toBe(true);
    const settings = makeSettings();
    settings.bookorbit.opdsPassword = '';
    expect(hasEnabledBookOrbitSubscriptions(settings)).toBe(false);
  });

  it('uses the CWA queue defaults and stamps imported books separately', async () => {
    const imported = makeBook({ hash: 'imported' });
    syncSubscribedCatalogs.mockImplementationOnce(async (_catalogs, _service, _books, options) => {
      await options.onBookImported({
        book: imported,
        catalogId: 'bookorbit-sub-scope-1',
        catalogName: 'Unread Gems',
        sourceUrl: 'https://books.example.com/api/v1/opds/download/1',
        item: {
          entryId: '1',
          title: 'Book',
          acquisitionHref: '/download/1',
          mimeType: 'application/epub+zip',
          baseURL: 'https://books.example.com/api/v1/opds/smart-scopes/1',
        },
      });
      return { newBooks: [imported], totalNewBooks: 1, errors: [] };
    });

    await syncBookOrbitSubscriptions(appService, makeSettings(), []);

    const [catalogs, , , options] = syncSubscribedCatalogs.mock.calls[0]!;
    expect(catalogs[0]).toMatchObject({
      id: 'bookorbit-sub-scope-1',
      username: 'readest-opds',
      password: 'secret',
    });
    expect(options.limitByCatalogId).toEqual({
      'bookorbit-sub-scope-1': CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
    });
    expect(imported.bookorbitSource).toMatchObject({
      subscriptionId: 'scope-1',
      subscriptionName: 'Unread Gems',
      entryId: '1',
    });
    expect(imported.cwaSource).toBeUndefined();
  });

  it('does not contact BookOrbit while the local queue is full', async () => {
    const ready = Array.from({ length: CWA_DEFAULT_QUEUE_TARGET }, (_, index) =>
      makeBook({
        hash: `ready-${index}`,
        readingStatus: 'unread',
        bookorbitSource: {
          subscriptionId: 'scope-1',
          subscriptionName: 'Unread Gems',
          catalogId: 'bookorbit-sub-scope-1',
          entryId: String(index),
          sourceUrl: `https://books.example.com/api/v1/opds/download/${index}`,
          downloadedAt: 1,
        },
      }),
    );

    await syncBookOrbitSubscriptions(appService, makeSettings(), ready);

    expect(syncSubscribedCatalogs).toHaveBeenCalledWith([], appService, ready, expect.any(Object));
  });

  it('excludes read and skimmed books and prioritizes publication date over feed order', async () => {
    const details = new Map<number, Record<string, unknown>>([
      [1, { id: 1, readStatus: null, publishedDate: '2019-01-01', publishedYear: 2019 }],
      [2, { id: 2, readStatus: 'skimmed', publishedDate: '2026-01-01', publishedYear: 2026 }],
      [3, { id: 3, readStatus: 'reading', publishedDate: '2024-05-01', publishedYear: 2024 }],
      [4, { id: 4, readStatus: 'read', publishedDate: '2025-01-01', publishedYear: 2025 }],
      [5, { id: 5, readStatus: 'abandoned', publishedDate: null, publishedYear: 2022 }],
    ]);
    const settings = makeSettings();
    settings.bookorbit.subscriptions![0]!.excludeServerRead = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body)) as { endpoint: string };
        const id = Number(payload.endpoint.split('/').at(-1));
        return {
          ok: true,
          status: 200,
          json: async () => details.get(id),
        };
      }),
    );
    const eligibleEntryIds: string[] = [];
    syncSubscribedCatalogs.mockImplementationOnce(async (_catalogs, _service, _books, options) => {
      const items = [1, 2, 3, 4, 5].map((id) => ({
        entryId: `urn:bookorbit:book:${id}`,
        title: `Book ${id}`,
        acquisitionHref: `/api/v1/opds/${id}/download`,
        mimeType: 'application/epub+zip',
        baseURL: 'https://books.example.com/api/v1/opds/catalog?smartScopeId=1',
      }));
      const sorted = await options.sortItems({
        items,
        catalogId: 'bookorbit-sub-scope-1',
        catalogName: 'Unread Gems',
      });
      for (const item of sorted) {
        const skip = await options.shouldSkipItem({
          item,
          catalogId: 'bookorbit-sub-scope-1',
          catalogName: 'Unread Gems',
          sourceUrl: item.acquisitionHref,
        });
        if (!skip) eligibleEntryIds.push(item.entryId);
      }
      return { newBooks: [], totalNewBooks: 0, errors: [] };
    });

    await syncBookOrbitSubscriptions(appService, settings, []);

    expect(eligibleEntryIds).toEqual([
      'urn:bookorbit:book:3',
      'urn:bookorbit:book:5',
      'urn:bookorbit:book:1',
    ]);
    vi.unstubAllGlobals();
  });
});
