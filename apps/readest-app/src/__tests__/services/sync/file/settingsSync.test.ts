import { beforeEach, describe, expect, it } from 'vitest';
import type { FileSyncProvider } from '@/services/sync/file/provider';
import type { SystemSettings } from '@/types/settings';
import {
  type SettingsBaselineStore,
  syncPortableSettings,
} from '@/services/sync/file/settingsSync';

const makeSettings = (overrides: Partial<SystemSettings> = {}): SystemSettings =>
  ({
    version: 5,
    migrationVersion: 3,
    localBooksDir: '/device/books',
    libraryColumns: 2,
    cwa: {
      enabled: true,
      serverUrl: 'https://books.example',
      username: 'local-user',
      password: 'local-secret',
      subscriptions: [],
    },
    googleDrive: { enabled: true, accountLabel: 'reader@example.com' },
    globalReadSettings: {},
    globalViewSettings: {},
    ...overrides,
  }) as unknown as SystemSettings;

const makeBaselineStore = (): SettingsBaselineStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
  };
};

const makeProvider = (initial: string | null = null) => {
  let remote = initial;
  const provider = {
    rootPath: '/',
    readText: async () => remote,
    writeText: async (_path: string, body: string) => {
      remote = body;
    },
    ensureDir: async () => {},
  } as unknown as FileSyncProvider;
  return { provider, readRemote: () => remote };
};

const remoteSnapshot = (settings: Partial<SystemSettings>, updatedAt = 100): string =>
  JSON.stringify({
    schemaVersion: 1,
    settings,
    updatedAt,
    writerDeviceId: 'phone',
  });

describe('syncPortableSettings', () => {
  let baselineStore: ReturnType<typeof makeBaselineStore>;

  beforeEach(() => {
    baselineStore = makeBaselineStore();
  });

  it('restores remote settings on a device with no prior baseline', async () => {
    const { provider } = makeProvider(
      remoteSnapshot({
        libraryColumns: 6,
        cwa: { enabled: true, serverUrl: 'https://books.example', subscriptions: [] },
      } as unknown as Partial<SystemSettings>),
    );

    const result = await syncPortableSettings(provider, makeSettings(), {
      deviceId: 'leaf',
      baselineId: 'gdrive:reader@example.com',
      baselineStore,
      now: () => 200,
    });

    expect(result.localChanged).toBe(true);
    expect(result.settings.libraryColumns).toBe(6);
    expect(result.settings.localBooksDir).toBe('/device/books');
    expect(result.settings.cwa.username).toBe('local-user');
    expect(result.settings.cwa.password).toBe('local-secret');
  });

  it('creates a credential-free remote snapshot when none exists', async () => {
    const { provider, readRemote } = makeProvider();

    const result = await syncPortableSettings(provider, makeSettings(), {
      deviceId: 'phone',
      baselineId: 'gdrive:reader@example.com',
      baselineStore,
      now: () => 200,
    });

    expect(result.remoteChanged).toBe(true);
    const remote = JSON.parse(readRemote()!);
    expect(remote.settings.libraryColumns).toBe(2);
    expect(remote.settings.localBooksDir).toBeUndefined();
    expect(remote.settings.cwa.username).toBeUndefined();
    expect(remote.settings.cwa.password).toBeUndefined();
  });

  it('pushes a local change when the remote still matches the baseline', async () => {
    const original = makeSettings();
    const { provider, readRemote } = makeProvider();
    const options = {
      deviceId: 'phone',
      baselineId: 'gdrive:reader@example.com',
      baselineStore,
      now: () => 200,
    };
    await syncPortableSettings(provider, original, options);

    await syncPortableSettings(provider, { ...original, libraryColumns: 5 }, options);

    expect(JSON.parse(readRemote()!).settings.libraryColumns).toBe(5);
  });

  it('three-way merges independent local and remote changes', async () => {
    const original = makeSettings({ librarySortAscending: true });
    const remote = makeProvider();
    const options = {
      deviceId: 'phone',
      baselineId: 'gdrive:reader@example.com',
      baselineStore,
      now: () => 200,
    };
    await syncPortableSettings(remote.provider, original, options);

    const prior = JSON.parse(remote.readRemote()!);
    prior.settings.librarySortAscending = false;
    const remoteAfterPeerChange = makeProvider(JSON.stringify(prior));
    const result = await syncPortableSettings(
      remoteAfterPeerChange.provider,
      { ...original, libraryColumns: 5 },
      options,
    );

    expect(result.settings.libraryColumns).toBe(5);
    expect(result.settings.librarySortAscending).toBe(false);
    const mergedRemote = JSON.parse(remoteAfterPeerChange.readRemote()!);
    expect(mergedRemote.settings.libraryColumns).toBe(5);
    expect(mergedRemote.settings.librarySortAscending).toBe(false);
  });
});
