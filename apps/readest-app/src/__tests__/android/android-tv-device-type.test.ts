import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    onmessage?: (message: unknown) => void;
  },
}));

import { getAndroidDeviceType } from '@/utils/bridge';

describe('Android TV device type bridge', () => {
  beforeEach(() => invoke.mockReset());

  it('uses the native Android device-type command', async () => {
    invoke.mockResolvedValue({ isTV: true });

    await expect(getAndroidDeviceType()).resolves.toEqual({ isTV: true });
    expect(invoke).toHaveBeenCalledWith('plugin:native-bridge|get_android_device_type');
  });
});
