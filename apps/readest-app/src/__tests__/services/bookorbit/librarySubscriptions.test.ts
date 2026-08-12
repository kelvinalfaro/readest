import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import {
  discoverBookOrbitSmartScopes,
  getBookOrbitOPDSUrl,
  hasEnabledBookOrbitSubscriptions,
  syncBookOrbitSubscriptions,
} from '@/services/bookorbit/librarySubscriptions';
import { CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC, CWA_DEFAULT_QUEUE_TARGET } from '@/services/cwa';

const syncSubscribedCatalogs = vi.hoisted(() => vi.fn());
const fetchWithAuth = vi.hoisted(() => vi.fn());

vi.mock('@/services/opds', () => ({ syncSubscribedCatalogs }));
vi.mock('@/app/opds/utils/opdsReq', () => ({ fetchWithAuth }));
vi.mock('@/services/environment', () => ({ isWebAppPlatform: () => false }));

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
});
