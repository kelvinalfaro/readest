import { describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import { persistDownloadedBook } from '@/app/opds/utils/persistDownloadedBook';

describe('persistDownloadedBook', () => {
  it('publishes a fresh library snapshot and waits for the durable save', async () => {
    const library = [{ hash: 'downloaded-book' }] as Book[];
    const setLibrary = vi.fn();
    let finishSave: (() => void) | undefined;
    const saveLibraryBooks = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );

    let finished = false;
    const persistence = persistDownloadedBook({ saveLibraryBooks }, library, setLibrary).then(
      () => {
        finished = true;
      },
    );

    expect(setLibrary).toHaveBeenCalledOnce();
    const published = setLibrary.mock.calls[0]?.[0] as Book[];
    expect(published).toEqual(library);
    expect(published).not.toBe(library);
    expect(saveLibraryBooks).toHaveBeenCalledWith(published);

    await Promise.resolve();
    expect(finished).toBe(false);

    finishSave?.();
    await persistence;
    expect(finished).toBe(true);
  });
});
