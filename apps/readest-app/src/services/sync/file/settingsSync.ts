import type { SystemSettings } from '@/types/settings';
import { mergeRestoredSettings, sanitizeSettingsForBackup } from '@/services/backupService';
import type { FileSyncProvider } from './provider';
import { ancestorsOf, buildSettingsPath } from './layout';

const SETTINGS_SYNC_SCHEMA_VERSION = 1;
const BASELINE_KEY_PREFIX = 'readest_file_settings_baseline_v1:';

interface RemoteSettingsSnapshot {
  schemaVersion: 1;
  settings: Partial<SystemSettings>;
  updatedAt: number;
  writerDeviceId: string;
}

export interface SettingsBaselineStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface SettingsSyncOptions {
  deviceId: string;
  baselineId: string;
  strategy?: 'silent' | 'send' | 'receive' | 'prompt';
  baselineStore?: SettingsBaselineStore;
  now?: () => number;
}

export interface SettingsSyncResult {
  settings: SystemSettings;
  localChanged: boolean;
  remoteChanged: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const cloneValue = <T>(value: T): T => structuredClone(value);

/**
 * Merge two changed snapshots against their last common baseline. Objects merge
 * recursively, while arrays and scalars are atomic. A true same-field conflict
 * follows the provider strategy; silent/prompt keep the local choice.
 */
const mergeThreeWayValue = (
  baseline: unknown,
  local: unknown,
  remote: unknown,
  strategy: SettingsSyncOptions['strategy'],
): unknown => {
  if (equal(local, remote)) return cloneValue(local);
  if (equal(local, baseline)) return cloneValue(remote);
  if (equal(remote, baseline)) return cloneValue(local);

  if (isPlainObject(local) && isPlainObject(remote)) {
    const base = isPlainObject(baseline) ? baseline : {};
    const merged: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const value = mergeThreeWayValue(base[key], local[key], remote[key], strategy);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }

  return cloneValue(strategy === 'receive' ? remote : local);
};

const defaultBaselineStore = (): SettingsBaselineStore | null => {
  try {
    if (typeof localStorage === 'undefined') return null;
    return {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
    };
  } catch {
    return null;
  }
};

const parseRemoteSnapshot = (raw: string | null): RemoteSettingsSnapshot | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RemoteSettingsSnapshot>;
    if (
      value.schemaVersion !== SETTINGS_SYNC_SCHEMA_VERSION ||
      !isPlainObject(value.settings) ||
      typeof value.updatedAt !== 'number' ||
      typeof value.writerDeviceId !== 'string'
    ) {
      return null;
    }
    return value as RemoteSettingsSnapshot;
  } catch {
    return null;
  }
};

const parseBaseline = (raw: string | null): Partial<SystemSettings> | null => {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isPlainObject(value) ? (value as Partial<SystemSettings>) : null;
  } catch {
    return null;
  }
};

/**
 * Reconcile the portable, credential-free settings snapshot in a file backend.
 * With no local baseline, an existing remote is authoritative so a fresh device
 * restores it before local defaults can overwrite it. Later passes use a
 * three-way merge against the last successfully synchronized snapshot.
 */
export const syncPortableSettings = async (
  provider: FileSyncProvider,
  current: SystemSettings,
  options: SettingsSyncOptions,
): Promise<SettingsSyncResult> => {
  const path = buildSettingsPath(provider.rootPath);
  const remote = parseRemoteSnapshot(await provider.readText(path));
  const localPortable = sanitizeSettingsForBackup(current);
  const store = options.baselineStore ?? defaultBaselineStore();
  const baselineKey = `${BASELINE_KEY_PREFIX}${options.baselineId}`;
  const baseline = parseBaseline(store?.get(baselineKey) ?? null);

  let mergedPortable: Partial<SystemSettings>;
  if (!remote) {
    mergedPortable = localPortable;
  } else if (!baseline) {
    // First contact on this device: restore the established remote snapshot,
    // then retain any newer fields an older snapshot did not know about.
    mergedPortable = sanitizeSettingsForBackup(mergeRestoredSettings(current, remote.settings));
  } else {
    mergedPortable = mergeThreeWayValue(
      baseline,
      localPortable,
      remote.settings,
      options.strategy,
    ) as Partial<SystemSettings>;
  }

  const settings = mergeRestoredSettings(current, mergedPortable);
  const localChanged = !equal(localPortable, mergedPortable);
  const remoteChanged = !remote || !equal(remote.settings, mergedPortable);

  if (remoteChanged) {
    const snapshot: RemoteSettingsSnapshot = {
      schemaVersion: SETTINGS_SYNC_SCHEMA_VERSION,
      settings: mergedPortable,
      updatedAt: (options.now ?? Date.now)(),
      writerDeviceId: options.deviceId,
    };
    await provider.ensureDir(ancestorsOf(path));
    await provider.writeText(path, JSON.stringify(snapshot, null, 2), 'application/json');
  }

  store?.set(baselineKey, JSON.stringify(mergedPortable));
  return { settings, localChanged, remoteChanged };
};
