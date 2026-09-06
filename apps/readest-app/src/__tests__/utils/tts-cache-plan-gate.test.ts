import { describe, expect, test } from 'vitest';

import { TTS_CACHE_REQUIRES_PREMIUM, isTTSCacheAllowed, isTTSCacheInPlan } from '@/utils/access';

describe('isTTSCacheInPlan', () => {
  test('any paid plan can use the offline TTS audio cache', () => {
    expect(isTTSCacheInPlan('plus', false)).toBe(true);
    expect(isTTSCacheInPlan('pro', false)).toBe(true);
    expect(isTTSCacheInPlan('purchase', false)).toBe(false);
  });

  test('free plan cannot', () => {
    expect(isTTSCacheInPlan('free', false)).toBe(false);
  });
});

describe('isTTSCacheAllowed (build policy)', () => {
  test('offline TTS audio downloads are available to every plan in this build', () => {
    expect(TTS_CACHE_REQUIRES_PREMIUM).toBe(false);
    expect(isTTSCacheAllowed('free', false)).toBe(true);
    expect(isTTSCacheAllowed('plus', false)).toBe(true);
    expect(isTTSCacheAllowed('pro', false)).toBe(true);
    expect(isTTSCacheAllowed('purchase', false)).toBe(true);
  });
});
