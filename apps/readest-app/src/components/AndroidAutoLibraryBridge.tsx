'use client';

import { useEffect, useMemo } from 'react';
import { addPluginListener, invoke, type PluginListener } from '@tauri-apps/api/core';
import type { Book } from '@/types/book';
import { useAppRouter } from '@/hooks/useAppRouter';
import { useLibraryStore } from '@/store/libraryStore';
import { isTauriAppPlatform } from '@/services/environment';
import { getOSPlatform } from '@/utils/misc';
import { isAudiobook } from '@/utils/audiobook';
import { setPendingTTSAutoplay } from '@/utils/ttsAutoplay';
import { navigateToReader } from '@/utils/nav';
import { eventDispatcher } from '@/utils/event';
import { isMainAppWindow } from '@/utils/window';

const MAX_ANDROID_AUTO_BOOKS = 100;

export interface AndroidAutoBook {
  hash: string;
  title: string;
  author: string;
}

export const getAndroidAutoLibraryBooks = (library: Book[]): AndroidAutoBook[] =>
  library
    .filter(
      (book) =>
        !book.deletedAt &&
        (book.downloadedAt !== null || !!book.filePath || !!book.url || book.format === 'ABS'),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ANDROID_AUTO_BOOKS)
    .map(({ hash, title, author }) => ({ hash, title, author }));

const AndroidAutoLibraryBridge = () => {
  const router = useAppRouter();
  const library = useLibraryStore((state) => state.library);
  const libraryLoaded = useLibraryStore((state) => state.libraryLoaded);
  const booksJson = useMemo(() => JSON.stringify(getAndroidAutoLibraryBooks(library)), [library]);

  useEffect(() => {
    if (!libraryLoaded || !isTauriAppPlatform() || getOSPlatform() !== 'android') return;
    void invoke('plugin:native-tts|update_media_library', {
      payload: { booksJson },
    }).catch((error) => console.warn('Failed to update Android Auto library:', error));
  }, [booksJson, libraryLoaded]);

  useEffect(() => {
    if (!isMainAppWindow() || !isTauriAppPlatform() || getOSPlatform() !== 'android') return;

    let listener: PluginListener | undefined;
    let cancelled = false;
    void addPluginListener(
      'native-tts',
      'media-session-play-book',
      ({ bookHash }: { bookHash?: string }) => {
        if (!bookHash) return;
        const book = useLibraryStore.getState().getBookByHash(bookHash);
        if (!book || book.deletedAt) return;

        if (isAudiobook(book)) {
          router.push(`/player?id=${encodeURIComponent(bookHash)}`);
          return;
        }

        setPendingTTSAutoplay(bookHash);
        if (window.location.pathname.startsWith('/reader')) {
          eventDispatcher.dispatch('open-book-in-reader', { bookHash });
        } else {
          navigateToReader(router, [bookHash]);
        }
      },
    )
      .then((registered) => {
        if (cancelled) {
          void registered.unregister();
        } else {
          listener = registered;
        }
      })
      .catch((error) => console.warn('Failed to listen for Android Auto selections:', error));

    return () => {
      cancelled = true;
      void listener?.unregister();
    };
  }, [router]);

  return null;
};

export default AndroidAutoLibraryBridge;
