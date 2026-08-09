import { describe, expect, test, vi } from 'vitest';
import { runGoogleTvDeviceFlow } from '@/services/sync/providers/gdrive/googleTvDeviceFlow';
import type { FetchFn } from '@/services/sync/providers/oauth/tokenEndpoint';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('runGoogleTvDeviceFlow', () => {
  test('shows the code, polls pending authorization, and returns tokens', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_url: 'https://www.google.com/device',
          expires_in: 1800,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(json({ error: 'authorization_pending' }, 400))
      .mockResolvedValueOnce(
        json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
      ) as unknown as FetchFn;
    const onPrompt = vi.fn();
    const sleep = vi.fn(async () => undefined);

    const tokens = await runGoogleTvDeviceFlow({
      clientId: 'tv-client',
      clientSecret: 'tv-secret',
      scope: 'drive.file',
      fetchFn,
      onPrompt,
      sleep,
    });

    expect(onPrompt).toHaveBeenCalledWith({
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://www.google.com/device',
    });
    expect(tokens).toMatchObject({ accessToken: 'AT', refreshToken: 'RT' });
    expect(sleep).toHaveBeenCalledTimes(2);
    const tokenRequest = vi.mocked(fetchFn).mock.calls[1]!;
    const form = new URLSearchParams(tokenRequest[1].body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(form.get('client_secret')).toBe('tv-secret');
  });

  test('surfaces access denial instead of polling forever', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_url: 'https://www.google.com/device',
          expires_in: 1800,
        }),
      )
      .mockResolvedValueOnce(json({ error: 'access_denied' }, 400)) as unknown as FetchFn;

    await expect(
      runGoogleTvDeviceFlow({
        clientId: 'tv-client',
        clientSecret: 'tv-secret',
        scope: 'drive.file',
        fetchFn,
        onPrompt: vi.fn(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/access_denied/);
  });
});
