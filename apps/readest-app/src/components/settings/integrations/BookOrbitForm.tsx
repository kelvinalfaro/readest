import clsx from 'clsx';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { md5 } from 'js-md5';
import { type as osType } from '@tauri-apps/plugin-os';
import { useRouter } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { BookOrbitClient } from '@/services/bookorbit/BookOrbitClient';
import {
  discoverBookOrbitSmartScopes,
  getBookOrbitSettings,
  syncBookOrbitSubscriptions,
} from '@/services/bookorbit/librarySubscriptions';
import { CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC, CWA_DEFAULT_QUEUE_TARGET } from '@/services/cwa';
import { useLibraryStore } from '@/store/libraryStore';
import { KOSyncStrategy, type CWASubscription } from '@/types/settings';
import { debounce } from '@/utils/debounce';
import { getOSPlatform } from '@/utils/misc';
import {
  formatCustomHeadersInput,
  hasCustomHeaders,
  parseCustomHeadersInput,
} from '@/utils/customHeaders';
import SubPageHeader from '../SubPageHeader';
import { SectionTitle, SettingLabel, SettingsSelect, SettingsSwitchRow, Tips } from '../primitives';
import { Toggle } from '@/components/primitives/toggle';

interface BookOrbitFormProps {
  onBack: () => void;
}

type BookOrbitToggleField = 'syncProgress' | 'syncNotes' | 'syncStats' | 'syncBookStates';

const BookOrbitForm: React.FC<BookOrbitFormProps> = ({ onBack }) => {
  const _ = useTranslation();
  const router = useRouter();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const setLibrary = useLibraryStore((state) => state.setLibrary);
  const { envConfig, appService } = useEnv();

  const [url, setUrl] = useState(settings.bookorbit.serverUrl || '');
  const [username, setUsername] = useState(settings.bookorbit.username || '');
  const [password, setPassword] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [osName, setOsName] = useState('');
  const [customHeadersInput, setCustomHeadersInput] = useState(
    formatCustomHeadersInput(settings.bookorbit.customHeaders),
  );
  const [headerError, setHeaderError] = useState('');
  const [opdsUsername, setOpdsUsername] = useState(settings.bookorbit.opdsUsername || '');
  const [opdsPassword, setOpdsPassword] = useState(settings.bookorbit.opdsPassword || '');
  const [discoveringScopes, setDiscoveringScopes] = useState(false);
  const [syncingScopes, setSyncingScopes] = useState(false);
  const [discoveredScopes, setDiscoveredScopes] = useState<
    Awaited<ReturnType<typeof discoverBookOrbitSmartScopes>>
  >([]);
  const [selectedScopeUrl, setSelectedScopeUrl] = useState('');

  useEffect(() => {
    const formatOsName = (name: string): string => {
      if (!name) return '';
      if (name.toLowerCase() === 'macos') return 'macOS';
      if (name.toLowerCase() === 'ios') return 'iOS';
      return name.charAt(0).toUpperCase() + name.slice(1);
    };

    const getOsName = async () => {
      let name = '';
      if (appService?.appPlatform === 'tauri') {
        name = await osType();
      } else {
        const platform = getOSPlatform();
        if (platform !== 'unknown') {
          name = platform;
        }
      }
      setOsName(formatOsName(name));
    };
    getOsName();
  }, [appService]);

  useEffect(() => {
    const defaultName = osName ? `Readest (${osName})` : 'Readest';
    setDeviceName(settings.bookorbit.deviceName || defaultName);
  }, [settings.bookorbit.deviceName, osName]);

  const isConfigured = useMemo(() => !!settings.bookorbit.userkey, [settings.bookorbit.userkey]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedSaveDeviceName = useCallback(
    debounce((newDeviceName: string) => {
      const newSettings = {
        ...settings,
        bookorbit: { ...settings.bookorbit, deviceName: newDeviceName },
      };
      setSettings(newSettings);
      saveSettings(envConfig, newSettings);
    }, 500),
    [settings, setSettings, saveSettings, envConfig],
  );

  const handleDeviceNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setDeviceName(newName);
    debouncedSaveDeviceName(newName);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedSaveCustomHeaders = useCallback(
    debounce((input: string) => {
      const parsed = parseCustomHeadersInput(input);
      if (parsed.error) {
        setHeaderError(parsed.error);
        return;
      }
      setHeaderError('');
      const bookorbit = {
        ...settings.bookorbit,
        customHeaders: hasCustomHeaders(parsed.headers) ? parsed.headers : undefined,
      };
      const newSettings = { ...settings, bookorbit };
      setSettings(newSettings);
      saveSettings(envConfig, newSettings);
    }, 500),
    [settings, setSettings, saveSettings, envConfig],
  );

  const handleCustomHeadersChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newInput = e.target.value;
    setCustomHeadersInput(newInput);
    debouncedSaveCustomHeaders(newInput);
  };

  const handleConnect = async () => {
    const parsedHeaders = parseCustomHeadersInput(customHeadersInput);
    if (parsedHeaders.error) {
      setHeaderError(parsedHeaders.error);
      return;
    }
    setHeaderError('');
    setIsConnecting(true);
    const config = {
      ...settings.bookorbit,
      serverUrl: url,
      username,
      userkey: md5(password),
      password,
      deviceName,
      customHeaders: hasCustomHeaders(parsedHeaders.headers) ? parsedHeaders.headers : undefined,
      enabled: true,
    };
    const client = new BookOrbitClient(config);
    const result = await client.connect();

    if (result.success) {
      const newSettings = { ...settings, bookorbit: config };
      setSettings(newSettings);
      await saveSettings(envConfig, newSettings);
      if (result.message) {
        eventDispatcher.dispatch('toast', { message: _(result.message), type: 'info' });
      }
    } else {
      eventDispatcher.dispatch('toast', {
        message: `${_('Failed to connect')}: ${_(result.message || 'Connection error')}`,
        type: 'error',
      });
    }
    setIsConnecting(false);
    setPassword('');
  };

  const handleDisconnect = async () => {
    const bookorbit = { ...settings.bookorbit, userkey: '', password: '', enabled: false };
    const newSettings = { ...settings, bookorbit };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
    setUsername('');
    setHeaderError('');
    eventDispatcher.dispatch('toast', { message: _('Disconnected'), type: 'info' });
  };

  const handleToggleEnabled = async () => {
    const bookorbit = { ...settings.bookorbit, enabled: !settings.bookorbit.enabled };
    const newSettings = { ...settings, bookorbit };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const handleToggleField = (field: BookOrbitToggleField) => async () => {
    const bookorbit = { ...settings.bookorbit, [field]: !settings.bookorbit[field] };
    const newSettings = { ...settings, bookorbit };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const handleStrategyChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const bookorbit = { ...settings.bookorbit, strategy: e.target.value as KOSyncStrategy };
    const newSettings = { ...settings, bookorbit };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const persistBookOrbit = async (patch: Partial<typeof settings.bookorbit>) => {
    const latest = useSettingsStore.getState().settings;
    const bookorbit = { ...getBookOrbitSettings(latest), ...patch };
    const nextSettings = { ...latest, bookorbit };
    useSettingsStore.getState().setSettings(nextSettings);
    await useSettingsStore.getState().saveSettings(envConfig, nextSettings);
    return nextSettings;
  };

  const handleDiscoverScopes = async () => {
    if (!opdsUsername || !opdsPassword || discoveringScopes) return;
    setDiscoveringScopes(true);
    try {
      const nextSettings = await persistBookOrbit({ opdsUsername, opdsPassword });
      const scopes = await discoverBookOrbitSmartScopes(nextSettings.bookorbit);
      setDiscoveredScopes(scopes);
      setSelectedScopeUrl(scopes[0]?.url ?? '');
      eventDispatcher.dispatch('toast', {
        type: scopes.length ? 'info' : 'warning',
        message: scopes.length
          ? _('Found {{count}} BookOrbit SmartScope(s)', { count: scopes.length })
          : _('No BookOrbit SmartScopes found'),
      });
    } catch (error) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDiscoveringScopes(false);
    }
  };

  const handleAddScope = async () => {
    const scope = discoveredScopes.find((item) => item.url === selectedScopeUrl);
    if (!scope) return;
    const latest = getBookOrbitSettings(useSettingsStore.getState().settings);
    if (latest.subscriptions.some((subscription) => subscription.url === scope.url)) return;
    const subscription: CWASubscription = {
      id: scope.id,
      name: scope.name,
      url: scope.url,
      enabled: true,
      queueTarget: CWA_DEFAULT_QUEUE_TARGET,
      maxDownloadsPerSync: CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
      formatPreference: ['epub', 'kepub', 'pdf'],
      cleanupPolicy: 'never',
      excludeServerRead: true,
    };
    await persistBookOrbit({ subscriptions: [...latest.subscriptions, subscription] });
  };

  const updateScope = async (id: string, patch: Partial<CWASubscription>) => {
    const latest = getBookOrbitSettings(useSettingsStore.getState().settings);
    await persistBookOrbit({
      subscriptions: latest.subscriptions.map((subscription) =>
        subscription.id === id ? { ...subscription, ...patch } : subscription,
      ),
    });
  };

  const removeScope = async (id: string) => {
    const latest = getBookOrbitSettings(useSettingsStore.getState().settings);
    await persistBookOrbit({
      subscriptions: latest.subscriptions.filter((subscription) => subscription.id !== id),
    });
  };

  const handleSyncScopes = async () => {
    if (!appService || syncingScopes) return;
    setSyncingScopes(true);
    try {
      const latest = useSettingsStore.getState().settings;
      const library = useLibraryStore.getState().library;
      const result = await syncBookOrbitSubscriptions(appService, latest, library, {
        trigger: 'manual',
      });
      const merged = Array.from(
        new Map([...library, ...result.newBooks].map((book) => [book.hash, book])).values(),
      );
      setLibrary(merged);
      await appService.saveLibraryBooks(merged);
      await persistBookOrbit({ lastLibrarySyncedAt: Date.now() });
      eventDispatcher.dispatch('toast', {
        type: result.errors.length ? 'warning' : 'info',
        message: result.errors.length
          ? _('BookOrbit synced with {{count}} catalog error(s)', { count: result.errors.length })
          : _('BookOrbit sync complete: {{count}} new item(s)', {
              count: result.totalNewBooks,
            }),
      });
    } finally {
      setSyncingScopes(false);
    }
  };

  const description: string = isConfigured
    ? _('Sync as {{userDisplayName}}', { userDisplayName: settings.bookorbit.username })
    : _('Connect to your BookOrbit server.');

  return (
    <div className='w-full'>
      <SubPageHeader
        parentLabel={_('Integrations')}
        currentLabel={_('BookOrbit')}
        description={description}
        onBack={onBack}
      />

      {isConfigured ? (
        <div className='space-y-5'>
          <div className='card eink-bordered border-base-200 bg-base-100 overflow-hidden border'>
            <div className='divide-base-200 divide-y'>
              <label className='flex min-h-14 items-center justify-between px-4'>
                <SettingLabel>{_('Sync Server Connected')}</SettingLabel>
                <Toggle checked={settings.bookorbit.enabled} onChange={handleToggleEnabled} />
              </label>
              <div className='flex min-h-14 items-center justify-between gap-3 px-4'>
                <SettingLabel>{_('Sync Strategy')}</SettingLabel>
                <SettingsSelect
                  value={settings.bookorbit.strategy}
                  onChange={handleStrategyChange}
                  ariaLabel={_('Sync Strategy')}
                  options={[
                    { value: 'prompt', label: _('Ask on conflict') },
                    { value: 'silent', label: _('Always use latest') },
                    { value: 'send', label: _('Send only') },
                    { value: 'receive', label: _('Receive only') },
                  ]}
                />
              </div>
              <SettingsSwitchRow
                label={_('Sync Reading Progress')}
                checked={settings.bookorbit.syncProgress}
                onChange={handleToggleField('syncProgress')}
              />
              <SettingsSwitchRow
                label={_('Sync Highlights and Bookmarks')}
                checked={settings.bookorbit.syncNotes}
                onChange={handleToggleField('syncNotes')}
              />
              <SettingsSwitchRow
                label={_('Sync Reading Statistics')}
                checked={settings.bookorbit.syncStats}
                onChange={handleToggleField('syncStats')}
              />
              <SettingsSwitchRow
                label={_('Sync Reading Status')}
                checked={settings.bookorbit.syncBookStates}
                onChange={handleToggleField('syncBookStates')}
              />
              <div className='-me-2 flex min-h-14 items-center justify-between gap-3 px-4'>
                <SettingLabel>{_('Device Name')}</SettingLabel>
                <input
                  type='text'
                  placeholder={osName ? `Readest (${osName})` : 'Readest'}
                  className='input h-9 max-w-[60%] rounded-md !border-0 !bg-transparent !pe-3 !ps-2 text-end text-sm hover:!bg-transparent focus:!border-0 focus:!bg-transparent focus:!shadow-none focus:!outline-none focus:!ring-0'
                  value={deviceName}
                  onChange={handleDeviceNameChange}
                />
              </div>
            </div>
          </div>

          <div className='space-y-1.5'>
            <SectionTitle as='label' htmlFor='bookorbit-custom-headers' className='block'>
              {_('Custom Headers (optional)')}
            </SectionTitle>
            <textarea
              id='bookorbit-custom-headers'
              value={customHeadersInput}
              onChange={handleCustomHeadersChange}
              placeholder={formatCustomHeadersInput({
                'CF-Access-Client-Id': 'your-client-id',
                'CF-Access-Client-Secret': 'your-client-secret',
              })}
              className='textarea textarea-bordered eink-bordered w-full font-mono text-sm placeholder:text-xs'
              rows={4}
              spellCheck={false}
            />
            <span className='label-text-alt text-base-content/60'>
              {_('Add one header per line using "Header-Name: value".')}
            </span>
            {headerError && (
              <div className='pt-0.5'>
                <span className='label-text-alt text-error'>{headerError}</span>
              </div>
            )}
          </div>

          <div className='space-y-3'>
            <div>
              <SectionTitle>{_('SmartScope Downloads')}</SectionTitle>
              <p className='text-base-content/60 mt-1 text-xs'>
                {_(
                  'Use a separate BookOrbit OPDS account to keep a bounded local reading queue from selected SmartScopes.',
                )}
              </p>
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              <input
                type='text'
                className='input input-bordered eink-bordered h-10 w-full text-sm'
                placeholder={_('OPDS Username')}
                value={opdsUsername}
                onChange={(event) => setOpdsUsername(event.target.value)}
                autoComplete='username'
              />
              <input
                type='password'
                className='input input-bordered eink-bordered h-10 w-full text-sm'
                placeholder={_('OPDS Password')}
                value={opdsPassword}
                onChange={(event) => setOpdsPassword(event.target.value)}
                autoComplete='current-password'
              />
            </div>
            <div className='flex flex-wrap gap-2'>
              <button
                type='button'
                className='btn btn-outline btn-sm'
                disabled={!opdsUsername || !opdsPassword || discoveringScopes}
                onClick={handleDiscoverScopes}
              >
                {discoveringScopes ? _('Discovering...') : _('Discover SmartScopes')}
              </button>
              <button
                type='button'
                className='btn btn-outline btn-sm'
                disabled={
                  syncingScopes || !(settings.bookorbit.subscriptions ?? []).some((s) => s.enabled)
                }
                onClick={handleSyncScopes}
              >
                {syncingScopes ? _('Syncing...') : _('Sync Downloads Now')}
              </button>
            </div>
            {discoveredScopes.length > 0 && (
              <div className='flex gap-2'>
                <select
                  className='select select-bordered select-sm min-w-0 flex-1'
                  value={selectedScopeUrl}
                  onChange={(event) => setSelectedScopeUrl(event.target.value)}
                >
                  {discoveredScopes.map((scope) => (
                    <option key={scope.id} value={scope.url}>
                      {scope.name}
                    </option>
                  ))}
                </select>
                <button type='button' className='btn btn-outline btn-sm' onClick={handleAddScope}>
                  {_('Add')}
                </button>
              </div>
            )}
            {(settings.bookorbit.subscriptions ?? []).map((subscription) => (
              <div
                key={subscription.id}
                className='eink-bordered border-base-200 space-y-3 rounded-lg border p-3'
              >
                <div className='flex items-center justify-between gap-3'>
                  <div className='min-w-0'>
                    <SettingLabel>{subscription.name}</SettingLabel>
                    <div className='text-base-content/50 truncate text-xs'>{subscription.url}</div>
                  </div>
                  <Toggle
                    checked={subscription.enabled}
                    onChange={() =>
                      updateScope(subscription.id, { enabled: !subscription.enabled })
                    }
                  />
                </div>
                <div className='grid grid-cols-2 gap-3'>
                  <label className='form-control'>
                    <span className='label-text text-xs'>{_('Queue target')}</span>
                    <input
                      type='number'
                      min={1}
                      max={50}
                      className='input input-bordered input-sm'
                      value={subscription.queueTarget ?? CWA_DEFAULT_QUEUE_TARGET}
                      onChange={(event) =>
                        updateScope(subscription.id, {
                          queueTarget: Number(event.target.value) || CWA_DEFAULT_QUEUE_TARGET,
                        })
                      }
                    />
                  </label>
                  <label className='form-control'>
                    <span className='label-text text-xs'>{_('Per sync')}</span>
                    <input
                      type='number'
                      min={1}
                      max={10}
                      className='input input-bordered input-sm'
                      value={subscription.maxDownloadsPerSync ?? CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC}
                      onChange={(event) =>
                        updateScope(subscription.id, {
                          maxDownloadsPerSync:
                            Number(event.target.value) || CWA_DEFAULT_MAX_DOWNLOADS_PER_SYNC,
                        })
                      }
                    />
                  </label>
                </div>
                <div className='flex justify-end gap-2'>
                  <button
                    type='button'
                    className='btn btn-ghost btn-xs'
                    onClick={() =>
                      router.push(
                        `/opds?from=bookorbit&bookorbitSubscriptionId=${encodeURIComponent(subscription.id)}`,
                      )
                    }
                  >
                    {_('Browse')}
                  </button>
                  <button
                    type='button'
                    className='btn btn-ghost btn-xs text-error'
                    onClick={() => removeScope(subscription.id)}
                  >
                    {_('Remove')}
                  </button>
                </div>
              </div>
            ))}
            <Tips>
              <li>
                {_(
                  'Create OPDS credentials in BookOrbit under Settings > OPDS. These are separate from KOReader credentials.',
                )}
              </li>
            </Tips>
          </div>

          <div className='flex justify-end'>
            <button
              type='button'
              onClick={handleDisconnect}
              className={clsx(
                'eink-bordered',
                'h-10 rounded-lg px-4 text-sm font-medium',
                'text-error hover:bg-error/10',
                'transition-colors duration-150',
                'focus-visible:ring-error/40 focus-visible:outline-none focus-visible:ring-2',
              )}
            >
              {_('Disconnect')}
            </button>
          </div>
        </div>
      ) : (
        <div className='space-y-5'>
          <form
            className='space-y-4'
            onSubmit={(e) => {
              e.preventDefault();
              handleConnect();
            }}
          >
            <div className='space-y-1.5'>
              <SectionTitle as='label' htmlFor='bookorbit-server-url' className='block'>
                {_('Server URL')}
              </SectionTitle>
              <input
                id='bookorbit-server-url'
                type='text'
                placeholder='https://books.example.com'
                className='input input-bordered eink-bordered h-11 w-full text-sm focus:outline-none'
                spellCheck='false'
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>

            <div className='space-y-1.5'>
              <SectionTitle as='label' htmlFor='bookorbit-username' className='block'>
                {_('Username')}
              </SectionTitle>
              <input
                id='bookorbit-username'
                type='text'
                placeholder={_('Your Username')}
                className='input input-bordered eink-bordered h-11 w-full text-sm focus:outline-none'
                spellCheck='false'
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete='username'
              />
            </div>

            <div className='space-y-1.5'>
              <SectionTitle as='label' htmlFor='bookorbit-password' className='block'>
                {_('Password')}
              </SectionTitle>
              <input
                id='bookorbit-password'
                type='password'
                placeholder={_('Your Password')}
                className='input input-bordered eink-bordered h-11 w-full text-sm focus:outline-none'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete='current-password'
              />
            </div>

            <div className='space-y-1.5'>
              <SectionTitle as='label' htmlFor='bookorbit-custom-headers' className='block'>
                {_('Custom Headers (optional)')}
              </SectionTitle>
              <textarea
                id='bookorbit-custom-headers'
                value={customHeadersInput}
                onChange={(e) => {
                  setCustomHeadersInput(e.target.value);
                  setHeaderError('');
                }}
                placeholder={formatCustomHeadersInput({
                  'CF-Access-Client-Id': 'your-client-id',
                  'CF-Access-Client-Secret': 'your-client-secret',
                })}
                className='textarea textarea-bordered eink-bordered w-full font-mono text-sm placeholder:text-xs'
                rows={4}
                spellCheck={false}
              />
              <span className='label-text-alt text-base-content/60'>
                {_('Add one header per line using "Header-Name: value".')}
              </span>
              {headerError && (
                <div className='pt-0.5'>
                  <span className='label-text-alt text-error'>{headerError}</span>
                </div>
              )}
            </div>

            <Tips>
              <li>
                {_(
                  'Create KOReader credentials in BookOrbit under Settings > Integrations > KOReader, then enter them here with your server address.',
                )}
              </li>
            </Tips>

            <div className='flex justify-end pt-1'>
              <button
                type='submit'
                disabled={isConnecting || !url || !username || !password}
                className={clsx(
                  'btn btn-primary',
                  'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
                  'focus-visible:ring-primary/40 focus-visible:outline-none focus-visible:ring-2',
                  isConnecting && 'opacity-60',
                )}
              >
                {isConnecting ? (
                  <span className='loading loading-spinner loading-sm' />
                ) : (
                  _('Connect')
                )}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default BookOrbitForm;
