import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TV_FEATURES = `    <!-- Android TV build profile -->
    <uses-feature android:name="android.software.leanback" android:required="false" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />
    <uses-feature android:name="android.hardware.faketouch" android:required="false" />`;

const TV_BANNER = '        android:banner="@drawable/tv_banner"\n';
const TV_LAUNCHER =
  '                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />\n';

export function configureAndroidTVManifest(source, enabled) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const manifest = source
    .replaceAll('\r\n', '\n')
    .replace(`${TV_FEATURES}\n\n`, '')
    .replace(TV_BANNER, '')
    .replace(TV_LAUNCHER, '');

  if (!enabled) return manifest.replaceAll('\n', eol);

  const applicationAnchor = '    <application\n';
  const iconAnchor = '        android:icon="@mipmap/ic_launcher"\n';
  const launcherAnchor =
    '                <category android:name="android.intent.category.LAUNCHER" />\n';

  for (const anchor of [applicationAnchor, iconAnchor, launcherAnchor]) {
    if (!manifest.includes(anchor)) {
      throw new Error(`Android manifest anchor not found: ${anchor.trim()}`);
    }
  }

  return manifest
    .replace(applicationAnchor, `${TV_FEATURES}\n\n${applicationAnchor}`)
    .replace(iconAnchor, `${TV_BANNER}${iconAnchor}`)
    .replace(launcherAnchor, `${launcherAnchor}${TV_LAUNCHER}`)
    .replaceAll('\n', eol);
}

async function main() {
  const mode = process.argv[2];
  const manifestPath = process.argv[3];
  if (!['--enable', '--disable'].includes(mode) || !manifestPath) {
    throw new Error(
      'Usage: node configure-android-tv-manifest.mjs <--enable|--disable> <AndroidManifest.xml>',
    );
  }

  const source = await readFile(manifestPath, 'utf8');
  const configured = configureAndroidTVManifest(source, mode === '--enable');
  await writeFile(manifestPath, configured, 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
