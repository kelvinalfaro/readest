import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Book } from '@/types/book';
import BookshelfItem from '@/app/library/components/BookshelfItem';
import BookshelfStream from '@/app/library/components/BookshelfStream';
import { createBookshelf } from '@/services/bookshelves/definitions';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {}, appService: null }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (size: number) => size }));
vi.mock('@/app/library/hooks/useOpenBook', () => ({
  useOpenBook: () => ({ openBook: vi.fn() }),
}));
await import('@/styles/globals.css');
afterEach(async () => {
  cleanup();
  await page.viewport(1920, 1080);
});

const books: Book[] = ['Series Book', 'Standalone', 'Another Book'].map((title, index) => ({
  hash: `${index}`,
  title,
  author: 'Author',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 1,
  progress: [1, 10],
  ...(index === 0
    ? {
        metadata: {
          title,
          author: 'Author',
          language: 'en',
          series: 'Long Series',
          seriesIndex: 2,
        },
      }
    : {}),
}));
const props = {
  coverFit: 'crop' as const,
  isSelectMode: false,
  itemSelected: false,
  transferProgress: null,
  setLoading: vi.fn(),
  toggleSelection: vi.fn(),
  handleGroupBooks: vi.fn(),
  handleBookUpload: vi.fn(async () => true),
  handleBookDownload: vi.fn(async () => true),
  handleBookDelete: vi.fn(async () => true),
  handleSetSelectMode: vi.fn(),
  handleShowDetailsBook: vi.fn(),
  handleLibraryNavigation: vi.fn(),
  handleUpdateReadingStatus: vi.fn(),
  showTimeRemaining: false,
};
const shelf = { ...createBookshelf('Mixed Books', 'mixed'), layout: 'grid' as const };
const MixedShelf = ({ showSeriesIndex = false }: { showSeriesIndex?: boolean }) => (
  <div style={{ width: 375, height: 450 }}>
    <BookshelfStream
      sections={[{ definition: shelf, items: books, hideHeading: true }]}
      autoColumns={false}
      fixedColumns={3}
      renderItem={(item, mode) => (
        <BookshelfItem {...props} item={item} mode={mode} showSeriesIndex={showSeriesIndex} />
      )}
    />
  </div>
);
const geometry = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.book-item')).map((card) => {
    const cover = card.querySelector('.bookitem-main')!.getBoundingClientRect();
    const title = card.querySelector('h4')!.getBoundingClientRect();
    return {
      coverTop: cover.top,
      coverBottom: cover.bottom,
      titleTop: title.top,
      titleBottom: title.bottom,
    };
  });
const waitForCards = async (container: HTMLElement) => {
  await waitFor(() => expect(container.querySelectorAll('.book-item')).toHaveLength(3));
  await document.fonts.ready;
};

describe('mixed library grid alignment (#6347)', () => {
  it('aligns covers and titles when only one book has series metadata', async () => {
    await page.viewport(375, 800);
    const { container } = render(<MixedShelf />);
    await waitForCards(container);
    const bounds = geometry(container);
    expect(bounds[0]!.coverBottom).toBeGreaterThan(bounds[0]!.coverTop);
    for (const card of bounds.slice(1)) {
      expect(card.coverTop).toBeCloseTo(bounds[0]!.coverTop, 1);
      expect(card.coverBottom).toBeCloseTo(bounds[0]!.coverBottom, 1);
      expect(card.titleTop).toBeCloseTo(bounds[0]!.titleTop, 1);
      expect(card.titleBottom).toBeCloseTo(bounds[0]!.titleBottom, 1);
    }
    expect(screen.queryByText('Long Series #2')).toBeNull();
    expect(screen.queryByText('#2')).toBeNull();
  });

  it('keeps card geometry unchanged when a series-index badge appears', async () => {
    await page.viewport(375, 800);
    const { container, rerender } = render(<MixedShelf />);
    await waitForCards(container);
    const baseline = geometry(container);
    rerender(<MixedShelf showSeriesIndex />);
    const badge = await screen.findByText('#2');
    expect(container.querySelector('.bookitem-main')!.contains(badge)).toBe(true);
    const badged = geometry(container);
    badged.forEach((card, index) => {
      for (const key of ['coverTop', 'coverBottom', 'titleTop', 'titleBottom'] as const) {
        expect(card[key]).toBeCloseTo(baseline[index]![key], 1);
      }
    });
    expect(screen.queryByText('Long Series #2')).toBeNull();
  });
});
