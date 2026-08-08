import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '../../.github/workflows/cwa-android-release.yml'),
  'utf8',
);
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
const nativeBridge = readFileSync(
  resolve(
    process.cwd(),
    'src-tauri/plugins/tauri-plugin-native-bridge/android/src/main/java/NativeBridgePlugin.kt',
  ),
  'utf8',
);
const nativeAppService = readFileSync(
  resolve(process.cwd(), 'src/services/nativeAppService.ts'),
  'utf8',
);

describe('CWA Android release ABIs', () => {
  it('builds the phone APK for arm64 and the TV APK for the Streamer armv7 ABI', () => {
    expect(workflow).toMatch(/build phone release APK[\s\S]*android build -t aarch64/);
    expect(workflow).toMatch(/build Android TV release APK[\s\S]*android build -t armv7/);
  });

  it('publishes architecture-labelled assets and verifies their native libraries', () => {
    expect(workflow).toContain(`Readest_CWA_\${version}_phone-arm64.apk`);
    expect(workflow).toContain(`Readest_CWA_\${version}_android-tv-armv7.apk`);
    expect(workflow).toContain('lib/arm64-v8a/libreadestlib.so');
    expect(workflow).toContain('lib/armeabi-v7a/libreadestlib.so');
    expect(workflow).toContain('"android-armv7": {url: $tv_url}');
  });

  it('uses a new app version for the corrected TV package', () => {
    expect(packageJson.version).toBe('0.12.4');
  });

  it('routes Android backup ZIP selection through the document framework', () => {
    expect(nativeBridge).toContain('Intent(Intent.ACTION_OPEN_DOCUMENT)');
    expect(nativeBridge).toContain('type = "application/zip"');
    expect(nativeBridge).toContain('fun select_backup_file(invoke: Invoke)');
    expect(nativeBridge).toContain('Environment.DIRECTORY_DOWNLOADS');
    expect(nativeBridge).toContain('file.name.startsWith("readest-backup-")');
    expect(nativeBridge).toContain('file.name.endsWith(".zip", ignoreCase = true)');
    expect(nativeAppService).toContain("extensions[0]?.toLowerCase() === 'zip'");
    expect(nativeAppService).toContain('await selectBackupFile()');
  });
});
