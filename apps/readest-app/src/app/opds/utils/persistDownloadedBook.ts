import type { Book } from '@/types/book';

interface LibraryPersistence {
  saveLibraryBooks: (books: Book[]) => Promise<void>;
}

export const persistDownloadedBook = async (
  appService: LibraryPersistence,
  library: Book[],
  setLibrary: (books: Book[]) => void,
): Promise<void> => {
  const updatedLibrary = [...library];
  setLibrary(updatedLibrary);
  await appService.saveLibraryBooks(updatedLibrary);
};
