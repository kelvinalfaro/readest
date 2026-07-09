import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RiBookOpenLine, RiRefreshLine } from 'react-icons/ri';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomOPDSStore } from '@/store/customOPDSStore';
import { eventDispatcher } from '@/utils/event';
import {
  buildCWACatalog,
  cleanupFinishedCWABooks,
  getCWAKOSyncUrl,
  getCWAOPDSUrl,
  getCWASettings,
  normalizeCWABaseUrl,
  syncCWASubscriptions,
} from '@/services/cwa';
import type { CWASettings, CWASubscription } from '@/types/settings';
import SubPageHeader from '../SubPageHeader';
import { BoxedList, SectionTitle, SettingLabel, Tips } from '../primitives';

interface CWAFormProps {
  onBack: () => void;
}

const CWAForm: React.FC<CWAFormProps> = ({ onBack }) => {
  const _ = useTranslation();
  const router = useRouter();
  const { envConfig, appService } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { library, setLibrary } = useLibraryStore();
  const cwa = useMemo(() => getCWASettings(settings), [settings]);
  const [serverUrl, setServerUrl] = useState(cwa.serverUrl);
  const [username, setUsername] = useState(cwa.username);
  const [password, setPassword] = useState(cwa.password);
  const [syncing, setSyncing] = useState(false);
  const [newSubName, setNewSubName] = useState('');
  const [newSubUrl, setNewSubUrl] = useState('');

  const persistCWA = async (patch: Partial<CWASettings>) => {
    const latest = useSettingsStore.getState().settings;
    const nextCWA = { ...getCWASettings(latest), ...patch };
    const next = { ...latest, cwa: nextCWA };
    setSettings(next);
    await saveSettings(envConfig, next);
    return next;
  };

  const persistConnection = async () => {
    await persistCWA({
      enabled: true,
      serverUrl: normalizeCWABaseUrl(serverUrl),
      username,
      password,
    });
    eventDispatcher.dispatch('toast', {
      type: 'info',
      timeout: 1500,
      message: _('CWA settings saved'),
    });
  };

  const ensureCatalogAndOpen = async () => {
    await persistConnection();
    const latest = getCWASettings(useSettingsStore.getState().settings);
    const catalog = buildCWACatalog(latest);
    await useCustomOPDSStore.getState().loadCustomOPDSCatalogs(envConfig);
    const saved = useCustomOPDSStore.getState().addCatalog(catalog);
    await useCustomOPDSStore.getState().saveCustomOPDSCatalogs(envConfig);
    const url = `/opds?id=${encodeURIComponent(saved.id)}&url=${encodeURIComponent(saved.url)}`;
    router.push(url);
  };

  const updateSubscription = async (id: string, patch: Partial<CWASubscription>) => {
    const latest = getCWASettings(useSettingsStore.getState().settings);
    const subscriptions = latest.subscriptions.map((sub) =>
      sub.id === id ? { ...sub, ...patch } : sub,
    );
    await persistCWA({ subscriptions });
  };

  const addSubscription = async () => {
    if (!newSubName.trim() || !newSubUrl.trim()) return;
    const latest = getCWASettings(useSettingsStore.getState().settings);
    const subscription: CWASubscription = {
      id: `cwa-${Date.now()}`,
      name: newSubName.trim(),
      url: newSubUrl.trim(),
      enabled: true,
      limit: 25,
      formatPreference: ['epub', 'kepub', 'pdf'],
      cleanupPolicy: 'never',
    };
    await persistCWA({ subscriptions: [...latest.subscriptions, subscription] });
    setNewSubName('');
    setNewSubUrl('');
  };

  const removeSubscription = async (id: string) => {
    const latest = getCWASettings(useSettingsStore.getState().settings);
    await persistCWA({ subscriptions: latest.subscriptions.filter((sub) => sub.id !== id) });
  };

  const handleSyncNow = async () => {
    if (!appService || syncing) return;
    setSyncing(true);
    try {
      const nextSettings = await persistCWA({
        enabled: true,
        serverUrl: normalizeCWABaseUrl(serverUrl),
        username,
        password,
      });
      const result = await syncCWASubscriptions(appService, nextSettings, library);
      const merged = Array.from(
        new Map([...library, ...result.newBooks].map((book) => [book.hash, book])).values(),
      );
      const cleaned = await cleanupFinishedCWABooks(appService, nextSettings, merged);
      setLibrary(merged);
      await appService.saveLibraryBooks(merged);
      await persistCWA({ lastSyncedAt: Date.now() });
      eventDispatcher.dispatch('toast', {
        type: result.errors.length ? 'warning' : 'info',
        timeout: 2500,
        message: result.errors.length
          ? _('CWA synced with {{count}} catalog error(s)', { count: result.errors.length })
          : _('CWA sync complete: {{count}} new item(s)', { count: result.totalNewBooks }),
      });
      if (cleaned.length > 0) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 2500,
          message: _('Removed {{count}} finished CWA local copy/copies', {
            count: cleaned.length,
          }),
        });
      }
    } catch (error) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        timeout: 4000,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <SubPageHeader
        parentLabel={_('Integrations')}
        currentLabel={_('CWA Library')}
        description={_('Browse and sync your Calibre-Web-Automated library through OPDS.')}
        onBack={onBack}
      />

      <div className='space-y-5'>
        <div className='space-y-3'>
          <div className='space-y-1.5'>
            <SectionTitle as='label' htmlFor='cwa-server-url' className='block'>
              {_('Server URL')}
            </SectionTitle>
            <input
              id='cwa-server-url'
              type='text'
              className='input input-bordered w-full'
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </div>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <SectionTitle as='label' htmlFor='cwa-username' className='block'>
                {_('Username')}
              </SectionTitle>
              <input
                id='cwa-username'
                type='text'
                className='input input-bordered w-full'
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className='space-y-1.5'>
              <SectionTitle as='label' htmlFor='cwa-password' className='block'>
                {_('Password')}
              </SectionTitle>
              <input
                id='cwa-password'
                type='password'
                className='input input-bordered w-full'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <div className='text-base-content/70 text-sm'>
            <div>{_('OPDS')}: {getCWAOPDSUrl({ serverUrl })}</div>
            <div>{_('KOSync')}: {getCWAKOSyncUrl({ serverUrl })}</div>
          </div>
          <div className='flex flex-wrap gap-2'>
            <button className='btn btn-primary btn-sm' type='button' onClick={ensureCatalogAndOpen}>
              <RiBookOpenLine className='h-4 w-4' />
              {_('Open CWA Library')}
            </button>
            <button
              className='btn btn-outline btn-sm'
              type='button'
              disabled={syncing}
              onClick={handleSyncNow}
            >
              <RiRefreshLine className='h-4 w-4' />
              {syncing ? _('Syncing...') : _('Sync CWA Now')}
            </button>
          </div>
        </div>

        <div>
          <SectionTitle className='mb-2'>{_('CWA Subscriptions')}</SectionTitle>
          <div className='mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]'>
            <input
              type='text'
              className='input input-bordered input-sm'
              placeholder={_('Shelf name')}
              value={newSubName}
              onChange={(e) => setNewSubName(e.target.value)}
            />
            <input
              type='text'
              className='input input-bordered input-sm'
              placeholder='/opds/magicshelf/25'
              value={newSubUrl}
              onChange={(e) => setNewSubUrl(e.target.value)}
            />
            <button className='btn btn-outline btn-sm' type='button' onClick={addSubscription}>
              {_('Add')}
            </button>
          </div>
          <BoxedList>
            {cwa.subscriptions.map((sub) => (
              <div key={sub.id} className='space-y-3 px-4 py-3'>
                <div className='flex items-center justify-between gap-3'>
                  <div className='min-w-0'>
                    <SettingLabel>{sub.name}</SettingLabel>
                    <div className='text-base-content/60 truncate text-xs'>
                      {resolveSubscriptionUrl(cwa, sub)}
                    </div>
                  </div>
                  <input
                    type='checkbox'
                    className='toggle'
                    checked={sub.enabled}
                    onChange={(e) => updateSubscription(sub.id, { enabled: e.target.checked })}
                  />
                </div>
                <button
                  type='button'
                  className='btn btn-ghost btn-xs text-error'
                  onClick={() => removeSubscription(sub.id)}
                >
                  {_('Remove')}
                </button>
                <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                  <label className='form-control'>
                    <span className='label-text'>{_('Download limit')}</span>
                    <input
                      type='number'
                      min={1}
                      max={500}
                      className='input input-bordered input-sm'
                      value={sub.limit}
                      onChange={(e) =>
                        updateSubscription(sub.id, { limit: Number(e.target.value) || 25 })
                      }
                    />
                  </label>
                  <label className='form-control'>
                    <span className='label-text'>{_('Cleanup')}</span>
                    <select
                      className='select select-bordered select-sm'
                      value={sub.cleanupPolicy}
                      onChange={(e) =>
                        updateSubscription(sub.id, {
                          cleanupPolicy: e.target.value as CWASubscription['cleanupPolicy'],
                        })
                      }
                    >
                      <option value='never'>{_('Never remove local copy')}</option>
                      <option value='finished'>{_('Remove when finished')}</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
          </BoxedList>
        </div>

        <Tips>
          <li>{_('CWA uses OPDS for library discovery and KOSync for reading progress.')}</li>
          <li>{_('Cleanup removes only Readest local copies; books stay untouched in CWA.')}</li>
        </Tips>
      </div>
    </>
  );
};

const resolveSubscriptionUrl = (cwa: CWASettings, sub: CWASubscription) => {
  if (/^https?:\/\//i.test(sub.url)) return sub.url;
  const base = normalizeCWABaseUrl(cwa.serverUrl);
  return `${base}${sub.url.startsWith('/') ? sub.url : `/${sub.url}`}`;
};

export default CWAForm;
