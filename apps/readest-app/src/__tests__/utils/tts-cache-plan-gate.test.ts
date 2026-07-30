import { describe, expect, test } from 'vitest';

import { TTS_CACHE_REQUIRES_PREMIUM, isTTSCacheAllowed, isTTSCacheInPlan } from '@/utils/access';

describe('isTTSCacheInPlan', () => {
  test('any paid plan can use the offline TTS audio cache', () => {
    expect(isTTSCacheInPlan('plus')).toBe(true);
    expect(isTTSCacheInPlan('pro')).toBe(true);
    expect(isTTSCacheInPlan('purchase')).toBe(true); // lifetime
  });

  test('free plan cannot', () => {
    expect(isTTSCacheInPlan('free')).toBe(false);
  });
});

describe('isTTSCacheAllowed (build policy)', () => {
  test('offline TTS audio downloads are available to every plan in this build', () => {
    expect(TTS_CACHE_REQUIRES_PREMIUM).toBe(false);
    expect(isTTSCacheAllowed('free')).toBe(true);
    expect(isTTSCacheAllowed('plus')).toBe(true);
    expect(isTTSCacheAllowed('pro')).toBe(true);
    expect(isTTSCacheAllowed('purchase')).toBe(true);
  });
});
