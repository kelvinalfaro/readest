import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import {
  getAudiobookFilename,
  isAudiobookAcquisition,
  saveDownloadedAudiobook,
} from '@/services/opds/audiobookAsset';

const saveDialog = vi.hoisted(() => vi.fn());
const copyPathToURI = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveDialog }));
vi.mock('@/utils/bridge', () => ({ copyPathToURI }));

describe('OPDS audiobook assets', () => {
  beforeEach(() => {
    saveDialog.mockReset();
    copyPathToURI.mockReset();
  });

  it('recognizes BookOrbit M4B links without treating EPUB as audio', () => {
    expect(
      isAudiobookAcquisition({ href: '/api/books/7/download', type: 'audio/mp4', title: 'M4B' }),
    ).toBe(true);
    expect(
      isAudiobookAcquisition({ href: '/api/books/7/book.epub', type: 'application/epub+zip' }),
    ).toBe(false);
    expect(isAudiobookAcquisition({ href: '/api/books/7/audio', type: 'audio/flac' })).toBe(false);
  });

  it('streams to an Android document URI selected by the save dialog', async () => {
    const uri = 'content://com.android.providers.downloads/document/42';
    saveDialog.mockResolvedValue(uri);
    copyPathToURI.mockResolvedValue({ success: true });
    const copyFile = vi.fn();
    const appService = { appPlatform: 'tauri', copyFile } as unknown as AppService;

    await expect(
      saveDownloadedAudiobook(appService, '/cache/download.m4b', 'You Are Here.m4b'),
    ).resolves.toBe(true);

    expect(copyPathToURI).toHaveBeenCalledWith({ src: '/cache/download.m4b', uri });
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('preserves an M4B response filename and falls back to the link title', () => {
    const link = { href: '/api/books/7/download', type: 'audio/mp4', title: 'M4B' };
    expect(getAudiobookFilename(link, 'You Are Here.m4b', 'Ignored')).toBe('You Are Here.m4b');
    expect(getAudiobookFilename(link, '', 'You Are Here')).toBe('You Are Here.m4b');
  });

  it('copies the cache file to the user-selected native location', async () => {
    saveDialog.mockResolvedValue('/storage/Downloads/You Are Here.m4b');
    const copyFile = vi.fn().mockResolvedValue(undefined);
    const appService = { appPlatform: 'tauri', copyFile } as unknown as AppService;

    await expect(
      saveDownloadedAudiobook(appService, '/cache/download.m4b', 'You Are Here.m4b'),
    ).resolves.toBe(true);

    expect(copyFile).toHaveBeenCalledWith(
      '/cache/download.m4b',
      'None',
      '/storage/Downloads/You Are Here.m4b',
      'None',
    );
  });

  it('does not copy when the save dialog is cancelled', async () => {
    saveDialog.mockResolvedValue(null);
    const copyFile = vi.fn();
    const appService = { appPlatform: 'tauri', copyFile } as unknown as AppService;

    await expect(
      saveDownloadedAudiobook(appService, '/cache/download.m4b', 'You Are Here.m4b'),
    ).resolves.toBe(false);
    expect(copyFile).not.toHaveBeenCalled();
  });
});
