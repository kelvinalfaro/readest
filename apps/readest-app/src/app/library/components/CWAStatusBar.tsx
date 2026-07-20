'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, ChevronRight } from 'lucide-react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { hasEnabledCWASubscriptions, loadCWASyncReport } from '@/services/cwa';
import type { CWASyncReport } from '@/services/cwa';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';

export default function CWAStatusBar() {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const settings = useSettingsStore((state) => state.settings);
  const library = useLibraryStore((state) => state.library);
  const [report, setReport] = useState<CWASyncReport | null>(null);

  useEffect(() => {
    if (appService) void loadCWASyncReport(appService).then(setReport);
  }, [appService, library]);

  if (!hasEnabledCWASubscriptions(settings)) return null;

  const ready = library.filter(
    (book) =>
      !book.deletedAt &&
      !!book.cwaSource &&
      [undefined, 'unread', 'reading'].includes(book.readingStatus) &&
      book.downloadedAt !== null,
  ).length;
  const issues =
    report?.subscriptions.reduce((sum, shelf) => sum + shelf.failed + (shelf.error ? 1 : 0), 0) ??
    0;

  return (
    <button
      type='button'
      className='border-base-content/10 hover:bg-base-200 flex w-full items-center gap-3 border-b px-4 py-2 text-left sm:px-6'
      onClick={() => router.push('/cwa')}
    >
      <BookOpen className='h-4 w-4 flex-none' />
      <span className='min-w-0 flex-1 truncate text-xs'>
        {_('CWA: {{count}} ready', { count: ready })}
        {report ? ` · ${_('{{count}} issue(s)', { count: issues })}` : ''}
      </span>
      <ChevronRight className='h-4 w-4 flex-none' />
    </button>
  );
}
