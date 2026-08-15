import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/supabase', () => ({ supabase: {} }));
vi.mock('@/services/environment', () => ({ isWebAppPlatform: () => false }));
vi.mock('@/services/translators/utils', () => ({ getDailyUsage: () => 0 }));
vi.mock('@/services/runtimeConfig', () => ({ getRuntimeConfig: () => undefined }));

import { getUserProfilePlan } from '@/utils/access';

const token = (payload: Record<string, unknown>) => {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
};

describe('getUserProfilePlan', () => {
  it('uses the signed-in JWT plan instead of a fork override', () => {
    expect(getUserProfilePlan(token({ plan: 'purchase' }))).toBe('purchase');
    expect(getUserProfilePlan(token({ plan: 'plus' }))).toBe('plus');
  });

  it('keeps the lifetime storage-purchase fallback for older tokens', () => {
    expect(getUserProfilePlan(token({ plan: 'free', storage_purchased_bytes: 1024 }))).toBe(
      'purchase',
    );
  });
});
