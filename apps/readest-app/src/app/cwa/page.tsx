'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BookOpen, RefreshCw, Settings } from 'lucide-react';
import BookCover from '@/components/BookCover';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import {
  getCWABookSources,
  getCWASettings,
  isCWAConfigured,
  loadCWASyncReport,
  resetCWASubscriptionHistory,
  retryFailedCWASubscription,
  syncCWASubscriptions,
  testCWAConnection,
} from '@/services/cwa';
import type { CWASyncReport } from '@/services/cwa';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { Book } from '@/types/book';
import { eventDispatcher } from '@/utils/event';
import { navigateToReader } from '@/utils/nav';

const isReadyBook = (book: Book) =>
  !book.deletedAt &&
  !!book.cwaSource &&
  [undefined, 'unread', 'reading'].includes(book.readingStatus) &&
  book.downloadedAt !== null;

export default function CWALibraryPage() {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const settings = useSettingsStore((state) => state.settings);
  const library = useLibraryStore((state) => state.library);
  const setLibrary = useLibraryStore((state) => state.setLibrary);
  const cwa = useMemo(() => getCWASettings(settings), [settings]);
  const [report, setReport] = useState<CWASyncReport | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refreshReport = useCallback(async () => {
    if (appService) setReport(await loadCWASyncReport(appService));
  }, [appService]);

  useEffect(() => {
    if (!isCWAConfigured(settings)) {
      const store = useSettingsStore.getState();
      store.setRequestedPanel('Integrations');
      store.setRequestedSubPage('cwa');
      store.setSettingsDialogOpen(true);
      router.replace('/library');
      return;
    }
    void refreshReport();
  }, [refreshReport, router, settings]);

  const readyBooks = useMemo(() => library.filter(isReadyBook), [library]);

  const saveResult = async (result: Awaited<ReturnType<typeof syncCWASubscriptions>>) => {
    const current = useLibraryStore.getState().library;
    const merged = Array.from(
      new Map([...current, ...result.newBooks].map((book) => [book.hash, book])).values(),
    );
    setLibrary(merged);
    await appService?.saveLibraryBooks(merged);
    if (result.report) setReport(result.report);
  };

  const runSync = async (preview = false) => {
    if (!appService || busyAction) return;
    setBusyAction(preview ? 'preview' : 'sync');
    try {
      const result = await syncCWASubscriptions(appService, settings, library, {
        trigger: preview ? 'preview' : 'manual',
        dryRun: preview,
      });
      await saveResult(result);
      eventDispatcher.dispatch('toast', {
        type: result.errors.length ? 'warning' : 'info',
        message: preview
          ? _('CWA preview is ready')
          : _('CWA sync complete: {{count}} new item(s)', { count: result.totalNewBooks }),
      });
    } catch (error) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const retryShelf = async (subscriptionId: string) => {
    if (!appService || busyAction) return;
    setBusyAction(`retry-${subscriptionId}`);
    try {
      const result = await retryFailedCWASubscription(
        appService,
        settings,
        library,
        subscriptionId,
      );
      await saveResult(result);
    } finally {
      setBusyAction(null);
    }
  };

  const testConnection = async () => {
    if (busyAction) return;
    setBusyAction('test');
    try {
      const result = await testCWAConnection(cwa);
      eventDispatcher.dispatch('toast', {
        type: 'success',
        message: _('Connected to {{name}}', { name: result.title }),
      });
    } catch (error) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const openSettings = () => {
    const store = useSettingsStore.getState();
    store.setRequestedPanel('Integrations');
    store.setRequestedSubPage('cwa');
    store.setSettingsDialogOpen(true);
    router.push('/library');
  };

  const openShelf = (subscriptionId: string) => {
    router.push(`/opds?from=cwa&cwaSubscriptionId=${encodeURIComponent(subscriptionId)}`);
  };

  const reportBySubscription = new Map(
    report?.subscriptions.map((item) => [item.subscriptionId, item]) ?? [],
  );
  const issueCount =
    report?.subscriptions.reduce((count, item) => count + item.failed + (item.error ? 1 : 0), 0) ??
    0;

  return (
    <div className='bg-base-100 text-base-content flex h-screen flex-col overflow-hidden'>
      <header className='border-base-content/10 flex h-14 items-center gap-2 border-b px-3'>
        <button className='btn btn-ghost btn-square btn-sm' onClick={() => router.push('/library')}>
          <ArrowLeft className='h-5 w-5' />
          <span className='sr-only'>{_('Back')}</span>
        </button>
        <BookOpen className='h-5 w-5' />
        <h1 className='min-w-0 flex-1 truncate text-base font-semibold'>{_('CWA Library')}</h1>
        <button
          className='btn btn-ghost btn-square btn-sm'
          title={_('Sync CWA now')}
          disabled={!!busyAction}
          onClick={() => void runSync(false)}
        >
          <RefreshCw className={busyAction === 'sync' ? 'h-5 w-5 animate-spin' : 'h-5 w-5'} />
        </button>
        <button
          className='btn btn-ghost btn-square btn-sm'
          title={_('Settings')}
          onClick={openSettings}
        >
          <Settings className='h-5 w-5' />
        </button>
      </header>

      <main className='min-h-0 flex-1 overflow-y-auto'>
        <section className='border-base-content/10 border-b px-4 py-3'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div>
              <p className='text-sm font-medium'>
                {_('{{count}} ready to read', { count: readyBooks.length })}
              </p>
              <p className='text-base-content/60 text-xs'>
                {report
                  ? _('Last sync {{time}} · {{count}} issue(s)', {
                      time: new Date(report.completedAt).toLocaleString(),
                      count: issueCount,
                    })
                  : _('No CWA sync has completed yet')}
              </p>
            </div>
            <div className='flex gap-2'>
              <button
                className='btn btn-outline btn-sm'
                disabled={!!busyAction}
                onClick={testConnection}
              >
                {_('Test')}
              </button>
              <button
                className='btn btn-outline btn-sm'
                disabled={!!busyAction}
                onClick={() => void runSync(true)}
              >
                {_('Preview')}
              </button>
            </div>
          </div>
        </section>

        {readyBooks.length > 0 && (
          <section className='border-base-content/10 border-b py-4'>
            <h2 className='text-base-content/60 mb-2 px-4 text-xs font-medium'>
              {_('Ready to read')}
            </h2>
            <div className='no-scrollbar flex gap-3 overflow-x-auto px-4'>
              {readyBooks.slice(0, 20).map((book) => (
                <button
                  key={book.hash}
                  className='w-24 flex-none text-left'
                  onClick={() => navigateToReader(router, [book.hash])}
                >
                  <div className='aspect-[28/41] overflow-hidden rounded shadow-sm'>
                    <BookCover mode='grid' book={book} coverFit='crop' showSpine={false} />
                  </div>
                  <span className='mt-1 block truncate text-xs'>{book.title}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className='px-4 py-4'>
          <h2 className='text-base-content/60 mb-2 text-xs font-medium'>
            {_('Subscribed shelves')}
          </h2>
          <div className='divide-base-content/10 border-base-content/10 divide-y border-y'>
            {cwa.subscriptions.map((subscription) => {
              const shelfReport = reportBySubscription.get(subscription.id);
              const localCount = readyBooks.filter((book) =>
                getCWABookSources(book).some((source) => source.subscriptionId === subscription.id),
              ).length;
              return (
                <div key={subscription.id} className='py-3'>
                  <div className='flex items-start justify-between gap-3'>
                    <button
                      className='min-w-0 flex-1 text-left'
                      onClick={() => openShelf(subscription.id)}
                    >
                      <span className='block truncate text-sm font-medium'>
                        {subscription.name}
                      </span>
                      <span className='text-base-content/60 block text-xs'>
                        {_('{{ready}} of {{target}} ready', {
                          ready: localCount,
                          target: subscription.queueTarget ?? 10,
                        })}
                        {shelfReport
                          ? ` · ${_('{{count}} planned', { count: shelfReport.planned })}`
                          : ''}
                      </span>
                      {shelfReport && (
                        <span className='text-base-content/60 mt-1 block text-xs'>
                          {_(
                            '{{downloaded}} downloaded · {{read}} read · {{suppressed}} finished · {{failed}} failed',
                            {
                              downloaded: shelfReport.downloaded,
                              read: shelfReport.skippedServerRead,
                              suppressed: shelfReport.skippedSuppressed,
                              failed: shelfReport.failed,
                            },
                          )}
                          {shelfReport.nextRetryAt
                            ? ` · ${_('Retry after {{time}}', {
                                time: new Date(shelfReport.nextRetryAt).toLocaleString(),
                              })}`
                            : ''}
                        </span>
                      )}
                      {shelfReport?.error && (
                        <span className='text-error mt-1 block text-xs'>{shelfReport.error}</span>
                      )}
                    </button>
                    <span
                      className={
                        subscription.enabled ? 'badge badge-success badge-sm' : 'badge badge-sm'
                      }
                    >
                      {subscription.enabled ? _('On') : _('Off')}
                    </span>
                  </div>
                  <div className='mt-2 flex flex-wrap gap-2'>
                    <button
                      className='btn btn-ghost btn-xs'
                      onClick={() => openShelf(subscription.id)}
                    >
                      {_('Browse')}
                    </button>
                    {(shelfReport?.failed ?? 0) > 0 && (
                      <button
                        className='btn btn-ghost btn-xs'
                        disabled={!!busyAction}
                        onClick={() => void retryShelf(subscription.id)}
                      >
                        {_('Retry failed')}
                      </button>
                    )}
                    <button
                      className='btn btn-ghost btn-xs'
                      onClick={async () => {
                        if (!appService) return;
                        await resetCWASubscriptionHistory(appService, subscription.id);
                        await refreshReport();
                      }}
                    >
                      {_('Reset history')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
