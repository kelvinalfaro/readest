import type { FetchFn, TokenSet } from '@/services/sync/providers/oauth/tokenEndpoint';

const DEVICE_CODE_ENDPOINT = 'https://oauth2.googleapis.com/device/code';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const EXPIRY_MARGIN_SECONDS = 60;

export interface GoogleTvDevicePrompt {
  userCode: string;
  verificationUrl: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url?: string;
  verification_uri?: string;
  expires_in: number;
  interval?: number;
}

interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface GoogleTvDeviceFlowOptions {
  clientId: string;
  clientSecret: string;
  scope: string;
  fetchFn: FetchFn;
  onPrompt: (prompt: GoogleTvDevicePrompt) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const postForm = (fetchFn: FetchFn, url: string, params: URLSearchParams): Promise<Response> =>
  fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

/** Google OAuth device authorization for TVs and other limited-input devices. */
export const runGoogleTvDeviceFlow = async (
  options: GoogleTvDeviceFlowOptions,
): Promise<TokenSet> => {
  const deviceParams = new URLSearchParams({
    client_id: options.clientId,
    scope: options.scope,
  });
  const deviceResponse = await postForm(options.fetchFn, DEVICE_CODE_ENDPOINT, deviceParams);
  const device = (await deviceResponse.json()) as DeviceCodeResponse & DeviceTokenResponse;
  if (!deviceResponse.ok || !device.device_code || !device.user_code) {
    throw new Error(`Google TV authorization failed${device.error ? `: ${device.error}` : ''}`);
  }
  const verificationUrl = device.verification_url ?? device.verification_uri;
  if (!verificationUrl) throw new Error('Google TV authorization returned no verification URL');

  options.onPrompt({ userCode: device.user_code, verificationUrl });

  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalSeconds = Math.max(1, device.interval ?? 5);

  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const tokenParams = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      device_code: device.device_code,
      grant_type: DEVICE_GRANT_TYPE,
    });
    const tokenResponse = await postForm(options.fetchFn, TOKEN_ENDPOINT, tokenParams);
    const token = (await tokenResponse.json()) as DeviceTokenResponse;

    if (tokenResponse.ok && token.access_token && token.expires_in !== undefined) {
      if (!token.refresh_token) {
        throw new Error('Google TV authorization returned no refresh token');
      }
      return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + Math.max(0, token.expires_in - EXPIRY_MARGIN_SECONDS) * 1000,
      };
    }

    if (token.error === 'authorization_pending') continue;
    if (token.error === 'slow_down') {
      intervalSeconds += 5;
      continue;
    }
    throw new Error(
      `Google TV authorization failed: ${token.error_description ?? token.error ?? 'unknown error'}`,
    );
  }

  throw new Error('Google TV authorization code expired');
};
