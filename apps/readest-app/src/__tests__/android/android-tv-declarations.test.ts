import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { configureAndroidTVManifest } from '../../../scripts/configure-android-tv-manifest.mjs';

const phoneManifest = readFileSync(
  resolve(process.cwd(), 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
  'utf-8',
);
const tvManifest = configureAndroidTVManifest(phoneManifest, true);

describe('Android build profiles', () => {
  it('keeps TV-only declarations out of the phone APK', () => {
    expect(phoneManifest).not.toContain('android.software.leanback');
    expect(phoneManifest).not.toContain('android.intent.category.LEANBACK_LAUNCHER');
    expect(phoneManifest).not.toContain('android:banner="@drawable/tv_banner"');
  });

  it('makes the TV APK launchable without requiring touch hardware', () => {
    expect(tvManifest).toContain(
      '<uses-feature android:name="android.software.leanback" android:required="false" />',
    );
    expect(tvManifest).toContain(
      '<uses-feature android:name="android.hardware.touchscreen" android:required="false" />',
    );
    expect(tvManifest).toContain(
      '<uses-feature android:name="android.hardware.faketouch" android:required="false" />',
    );
    expect(tvManifest).toContain('android.intent.category.LEANBACK_LAUNCHER');
    expect(tvManifest).toContain('android:banner="@drawable/tv_banner"');
  });

  it('can return the TV manifest to the phone profile without residue', () => {
    expect(configureAndroidTVManifest(tvManifest, false)).toBe(phoneManifest);
  });

  it('uses an exact 320 by 180 TV banner', () => {
    const png = readFileSync(
      resolve(process.cwd(), 'src-tauri/gen/android/app/src/main/res/drawable-nodpi/tv_banner.png'),
    );
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(180);
  });
});
