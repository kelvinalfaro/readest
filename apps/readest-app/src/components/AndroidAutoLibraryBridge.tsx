'use client';

import { useEffect, useMemo, useState } from 'react';
import { addPluginListener, invoke, type PluginListener } from '@tauri-apps/api/core';
import type { Book } from '@/types/book';
import { useAppRouter } from '@/hooks/useAppRouter';
import { useLibraryStore } from '@/store/libraryStore';
import { getInitializedAppService, isTauriAppPlatform } from '@/services/environment';
import { getOSPlatform } from '@/utils/misc';
import { isAudiobook } from '@/utils/audiobook';
import { setPendingTTSAutoplay } from '@/utils/ttsAutoplay';
import { navigateToReader } from '@/utils/nav';
import { eventDispatcher } from '@/utils/event';
import { isMainAppWindow } from '@/utils/window';
import { getConfigFilename } from '@/utils/book';

const MAX_ANDROID_AUTO_BOOKS = 100;

export interface AndroidAutoBook {
  hash: string;
  title: string;
  author: string;
  isAudiobook: boolean;
  format: Book['format'];
  coverHash: string | null;
  artworkReady: boolean;
}

interface AndroidAutoPlaybackSource {
  sourcePath: string | null;
  configPath: string | null;
}

type CoverThumbnail = { coverHash: string | null; url: string };

export const getAndroidAutoLibraryBooks = (
  library: Book[],
  coverThumbnails: Map<string, CoverThumbnail> = new Map(),
): AndroidAutoBook[] =>
  library
    .filter(
      (book) =>
        !book.deletedAt &&
        (book.downloadedAt !== null || !!book.filePath || !!book.url || book.format === 'ABS'),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ANDROID_AUTO_BOOKS)
    .map((book) => {
      const { hash, title, author, coverHash } = book;
      const normalizedCoverHash = coverHash ?? null;
      const thumbnail = coverThumbnails.get(hash);
      return {
        hash,
        title,
        author,
        isAudiobook: isAudiobook(book),
        format: book.format,
        coverHash: normalizedCoverHash,
        artworkReady: !!thumbnail && thumbnail.coverHash === normalizedCoverHash,
      };
    });

const AndroidAutoLibraryBridge = () => {
  const router = useAppRouter();
  const library = useLibraryStore((state) => state.library);
  const libraryLoaded = useLibraryStore((state) => state.libraryLoaded);
  const coverThumbnails = useLibraryStore((state) => state.coverThumbnails);
  const [selectionListenerReady, setSelectionListenerReady] = useState(false);
  const [playbackSources, setPlaybackSources] = useState<Map<string, AndroidAutoPlaybackSource>>(
    new Map(),
  );
  const baseAndroidAutoBooks = useMemo(
    () => getAndroidAutoLibraryBooks(library, coverThumbnails),
    [coverThumbnails, library],
  );
  const androidAutoBooks = useMemo(
    () =>
      baseAndroidAutoBooks.map((book) => ({
        ...book,
        sourcePath: playbackSources.get(book.hash)?.sourcePath ?? null,
        configPath: playbackSources.get(book.hash)?.configPath ?? null,
      })),
    [baseAndroidAutoBooks, playbackSources],
  );
  const booksJson = useMemo(() => JSON.stringify(androidAutoBooks), [androidAutoBooks]);

  useEffect(() => {
    if (!libraryLoaded || !isTauriAppPlatform() || getOSPlatform() !== 'android') return;

    // Android Auto artwork must be exposed as a local content:// URI. Reuse
    // Readest's bounded JPEG thumbnail cache rather than parceling full cover
    // bitmaps through the media browser. Thumbnail-ready events update the
    // store above, which republishes the library and refreshes the car UI.
    const selectedHashes = new Set(getAndroidAutoLibraryBooks(library).map((book) => book.hash));
    const appService = getInitializedAppService();
    if (appService?.supportsCoverThumbnailOptimization) {
      for (const book of library) {
        if (selectedHashes.has(book.hash)) appService.requestCoverThumbnail(book);
      }
    }
  }, [library, libraryLoaded]);

  useEffect(() => {
    if (!libraryLoaded || !isTauriAppPlatform() || getOSPlatform() !== 'android') return;
    const appService = getInitializedAppService();
    if (!appService) return;

    let cancelled = false;
    void Promise.all(
      getAndroidAutoLibraryBooks(library).map(async ({ hash }) => {
        const book = library.find((candidate) => candidate.hash === hash);
        if (!book) return [hash, { sourcePath: null, configPath: null }] as const;
        const [sourcePath, configPath] = await Promise.all([
          appService.resolveNativeBookFilePath(book),
          appService.resolveFilePath(getConfigFilename(book), 'Books').catch(() => null),
        ]);
        return [hash, { sourcePath, configPath }] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setPlaybackSources(new Map(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [library, libraryLoaded]);

  useEffect(() => {
    if (
      !libraryLoaded ||
      !selectionListenerReady ||
      !isTauriAppPlatform() ||
      getOSPlatform() !== 'android'
    )
      return;
    void invoke('plugin:native-tts|update_media_library', {
      payload: { booksJson },
    }).catch((error) => console.warn('Failed to update Android Auto library:', error));
  }, [booksJson, libraryLoaded, selectionListenerReady]);

  useEffect(() => {
    if (!isMainAppWindow() || !isTauriAppPlatform() || getOSPlatform() !== 'android') return;

    let listeners: PluginListener[] = [];
    let cancelled = false;
    void Promise.all([
      addPluginListener(
        'native-tts',
        'media-session-play-book',
        ({ bookHash }: { bookHash?: string }) => {
          if (!bookHash) return;
          const book = useLibraryStore.getState().getBookByHash(bookHash);
          if (!book || book.deletedAt) return;

          if (isAudiobook(book)) {
            router.push(`/player?id=${encodeURIComponent(bookHash)}&autoplay=1`);
            return;
          }

          setPendingTTSAutoplay(bookHash);
          if (window.location.pathname.startsWith('/reader')) {
            eventDispatcher.dispatch('open-book-in-reader', { bookHash });
          } else {
            navigateToReader(router, [bookHash]);
          }
        },
      ),
      // Before a controller exists, the ordinary media-session handler has
      // nothing to pause. Cancel the queued one-shot start explicitly.
      addPluginListener('native-tts', 'media-session-pause', () => {
        setPendingTTSAutoplay(null);
      }),
    ])
      .then((registered) => {
        if (cancelled) {
          for (const listener of registered) void listener.unregister();
        } else {
          listeners = registered;
          // update_media_library installs the native-to-WebView event bridge
          // and drains any book selected while the process was cold. Publish
          // only after this listener exists so that one-shot event cannot be
          // lost during startup.
          setSelectionListenerReady(true);
        }
      })
      .catch((error) => console.warn('Failed to listen for Android Auto selections:', error));

    return () => {
      cancelled = true;
      for (const listener of listeners) void listener.unregister();
    };
  }, [router]);

  return null;
};

export default AndroidAutoLibraryBridge;
