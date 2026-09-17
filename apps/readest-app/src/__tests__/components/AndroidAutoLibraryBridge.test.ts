import { describe, expect, it } from 'vitest';
import type { Book } from '@/types/book';
import { getAndroidAutoLibraryBooks } from '@/components/AndroidAutoLibraryBridge';

const book = (overrides: Partial<Book>): Book => ({
  hash: 'hash',
  format: 'EPUB',
  title: 'Title',
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('AndroidAutoLibraryBridge', () => {
  it('publishes recent playable books and excludes deleted or cloud-only rows', () => {
    const books = getAndroidAutoLibraryBooks([
      book({ hash: 'older', title: 'Older', updatedAt: 10 }),
      book({ hash: 'newer', title: 'Newer', updatedAt: 20, downloadedAt: 20 }),
      book({ hash: 'cloud', title: 'Cloud only', updatedAt: 30, downloadedAt: null }),
      book({ hash: 'deleted', title: 'Deleted', updatedAt: 40, deletedAt: 40 }),
      book({ hash: 'audio', title: 'Audiobook', format: 'ABS', updatedAt: 50 }),
    ]);

    expect(books).toEqual([
      { hash: 'audio', title: 'Audiobook', author: 'Author' },
      { hash: 'newer', title: 'Newer', author: 'Author' },
      { hash: 'older', title: 'Older', author: 'Author' },
    ]);
  });
});
