import type { OPDSAcquisitionLink } from '@/types/opds';
import type { AppService } from '@/types/system';
import { isContentURI, makeSafeFilename } from '@/utils/misc';
import { getFilename } from '@/utils/path';
import { parseMediaType } from '@/app/opds/utils/opdsUtils';

const AUDIOBOOK_EXTENSIONS = ['m4b', 'm4a', 'mp3'] as const;
type AudiobookExtension = (typeof AUDIOBOOK_EXTENSIONS)[number];

const extensionFrom = (value?: string): AudiobookExtension | null => {
  if (!value) return null;
  const pathname = value.split(/[?#]/, 1)[0] ?? '';
  const match = pathname.match(/\.([a-z0-9]+)$/i);
  const extension = match?.[1]?.toLowerCase();
  return AUDIOBOOK_EXTENSIONS.includes(extension as AudiobookExtension)
    ? (extension as AudiobookExtension)
    : null;
};

const extensionFromTitle = (title?: string): AudiobookExtension | null => {
  const match = title?.trim().match(/\b(m4b|m4a|mp3)\b/i);
  return match?.[1] ? (match[1].toLowerCase() as AudiobookExtension) : null;
};

const extensionFromMimeType = (type?: string): AudiobookExtension | null => {
  const mediaType = parseMediaType(type)?.mediaType;
  if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3') return 'mp3';
  if (mediaType === 'audio/x-m4b') return 'm4b';
  if (mediaType === 'audio/mp4' || mediaType === 'audio/x-m4a') return 'm4a';
  return null;
};

export const isAudiobookAcquisition = (link: OPDSAcquisitionLink): boolean => {
  return (
    extensionFromMimeType(link.type) !== null ||
    extensionFrom(link.href) !== null ||
    extensionFromTitle(link.title) !== null
  );
};

export const getAudiobookFilename = (
  link: OPDSAcquisitionLink,
  responseFilename: string,
  publicationTitle: string,
): string => {
  const responseBase = responseFilename ? getFilename(responseFilename) : '';
  const extension =
    extensionFrom(responseBase) ??
    extensionFrom(link.href) ??
    extensionFromTitle(link.title) ??
    extensionFromMimeType(link.type) ??
    'm4b';

  if (responseBase) {
    const safeResponseName = makeSafeFilename(responseBase);
    return extensionFrom(safeResponseName) ? safeResponseName : `${safeResponseName}.${extension}`;
  }

  const safeTitle = makeSafeFilename(publicationTitle.trim() || 'Audiobook');
  return `${safeTitle}.${extension}`;
};

/** Copies an already-downloaded audiobook without routing it through the JS heap. */
export const saveDownloadedAudiobook = async (
  appService: AppService,
  sourcePath: string,
  filename: string,
): Promise<boolean> => {
  if (appService.appPlatform !== 'tauri') {
    throw new Error('Saving OPDS audiobooks is currently available in the Readest app.');
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  const filePath = await save({
    defaultPath: filename,
    filters: [{ name: 'Audiobook', extensions: [...AUDIOBOOK_EXTENSIONS] }],
  });
  if (!filePath) return false;

  if (isContentURI(filePath)) {
    const { copyPathToURI } = await import('@/utils/bridge');
    const result = await copyPathToURI({ src: sourcePath, uri: filePath });
    if (!result.success) {
      throw new Error(result.error || 'Failed to save audiobook');
    }
  } else {
    await appService.copyFile(sourcePath, 'None', filePath, 'None');
  }
  return true;
};
