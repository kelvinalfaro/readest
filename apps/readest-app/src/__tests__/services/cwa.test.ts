import { describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import {
  cleanupFinishedCWABooks,
  getCWAKOSyncUrl,
  getCWAOPDSUrl,
  normalizeCWABaseUrl,
  syncCWASubscriptions,
} from '@/services/cwa';

const syncSubscribedCatalogs = vi.hoisted(() => vi.fn());

vi.mock('@/services/opds', () => ({
  syncSubscribedCatalogs,
}));

const makeSettings = (overrides: Partial<SystemSettings> = {}): SystemSettings =>
  ({
    cwa: {
      enabled: true,
      serverUrl: 'https://books.alfaro.io/books',
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

describe('CWA URL helpers', () => {
  it('normalizes CWA base, OPDS, and KOSync URLs without duplicates', () => {
    expect(normalizeCWABaseUrl('https://books.alfaro.io/books/')).toBe(
      'https://books.alfaro.io/books',
    );
    expect(getCWAOPDSUrl({ serverUrl: 'https://books.alfaro.io/books/kosync' })).toBe(
      'https://books.alfaro.io/books/opds',
    );
    expect(getCWAKOSyncUrl({ serverUrl: 'https://books.alfaro.io/books/kosync' })).toBe(
      'https://books.alfaro.io/books/kosync',
    );
  });
});

describe('syncCWASubscriptions', () => {
  it('syncs only enabled subscriptions and stamps imported books', async () => {
    const imported = makeBook({ hash: 'imported' });
    syncSubscribedCatalogs.mockImplementationOnce(
      async (_catalogs, _appService, _books, options) => {
        await options.onBookImported({
          book: imported,
          catalogId: 'cwa-sub-new',
          catalogName: 'New',
          sourceUrl: 'https://books.alfaro.io/books/get/1.epub',
          item: {
            entryId: '1',
            title: 'Book',
            acquisitionHref: '/get/1.epub',
            mimeType: 'application/epub+zip',
            baseURL: 'https://books.alfaro.io/books/opds/new',
          },
        });
        return { newBooks: [imported], totalNewBooks: 1, errors: [] };
      },
    );

    await syncCWASubscriptions({} as AppService, makeSettings(), []);

    const [catalogs, , , options] = syncSubscribedCatalogs.mock.calls[0]!;
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0].url).toBe('https://books.alfaro.io/books/opds/new');
    expect(options.limitByCatalogId).toEqual({ 'cwa-sub-new': 10 });
    expect(imported.cwaSource).toMatchObject({
      subscriptionId: 'new',
      subscriptionName: 'New',
      catalogId: 'cwa-sub-new',
      sourceUrl: 'https://books.alfaro.io/books/get/1.epub',
    });
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
        sourceUrl: 'https://books.alfaro.io/books/get/1.epub',
        downloadedAt: 1,
      },
    });
    const unread = makeBook({
      hash: 'unread',
      readingStatus: 'unread',
      cwaSource: finished.cwaSource,
    });
    const deleteBook = vi.fn(async () => {});
    const appService = {
      deleteBook,
      loadBookConfig: vi.fn(async () => ({ booknotes: [] })),
    } as unknown as AppService;
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
        sourceUrl: 'https://books.alfaro.io/books/get/1.epub',
        downloadedAt: 1,
      },
    });
    const appService = {
      deleteBook: vi.fn(async () => {}),
      loadBookConfig: vi.fn(async () => ({ booknotes: [{ id: 'n1' }] })),
    } as unknown as AppService;
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
