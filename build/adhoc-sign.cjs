/**
 * electron-builder `afterPack` hook — ad-hoc code signing fallback for macOS.
 *
 * WHY THIS EXISTS
 * Without a Developer ID certificate, electron-builder skips macOS signing
 * entirely ("skipped macOS code signing ... cannot find valid Developer ID").
 * The packaged bundle is then *worse* than unsigned: electron-builder edits
 * Info.plist and renames the main executable, which invalidates the ad-hoc
 * signature the prebuilt Electron binaries shipped with. macOS sees a bundle
 * whose signature does not match its contents and reports:
 *
 *     "3D Gen Studio" is damaged and can't be opened. You should move it to the Bin.
 *
 * — a hard refusal with no "Open Anyway" path, and on Apple Silicon the binary
 * cannot even be exec'd (arm64 requires a valid signature).
 *
 * Re-signing ad-hoc (`codesign --sign -`) makes the signature match the
 * contents again. The app then gets the ordinary, *bypassable* first-launch
 * warning ("Apple could not verify ... is free of malware" → System Settings →
 * Privacy & Security → Open Anyway) instead of "damaged".
 *
 * This is a fallback, not a substitute for signing: a Developer ID +
 * notarization is still the only way to get a warning-free install. When
 * CSC_LINK / CSC_NAME is set (or a Developer ID lives in the keychain) this
 * hook stands down and lets electron-builder do the real thing.
 *
 * Deliberately NOT enabling hardened runtime here: hardened runtime turns on
 * library validation, which would refuse to load the unsigned native modules
 * (sqlite3 .node) and the user-provisioned Python. Hardened runtime belongs to
 * the real-signing path, where `build/entitlements.mac.plist` relaxes it.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Mach-O files codesign's --deep pass does not cover on its own. */
const NESTED_BINARY_EXT = new Set(['.node', '.dylib', '.so']);

function hasRealIdentity() {
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEY_PASSWORD) return true;
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return false;
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    return out.includes('Developer ID Application');
  } catch {
    return false;
  }
}

function collectNestedBinaries(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectNestedBinaries(full, found);
    } else if (NESTED_BINARY_EXT.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

function codesign(args) {
  execFileSync('codesign', args, { stdio: 'pipe', encoding: 'utf8' });
}

async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') return; // codesign only exists on macOS

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  if (!fs.existsSync(appPath)) {
    console.warn(`  • ad-hoc signing skipped: ${appPath} not found`);
    return;
  }

  if (hasRealIdentity()) {
    console.log('  • ad-hoc signing skipped: a Developer ID is available, electron-builder will sign');
    return;
  }

  console.log(`  • no Developer ID found — ad-hoc signing ${path.basename(appPath)} (${context.arch})`);

  try {
    // Inner Mach-O files first: --deep seals them as plain resources, so giving
    // them their own signature keeps `codesign --verify --deep --strict` clean.
    const nested = collectNestedBinaries(appPath);
    for (const file of nested) {
      try {
        codesign(['--force', '--sign', '-', '--timestamp=none', file]);
      } catch (err) {
        console.warn(`    - could not sign ${path.relative(appPath, file)}: ${err.message.trim()}`);
      }
    }
    if (nested.length) console.log(`    - signed ${nested.length} nested binaries`);

    // Then the bundle itself (helpers + frameworks + outer app).
    codesign(['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);

    codesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    console.log('    - ad-hoc signature verified');
  } catch (err) {
    // Never fail the build over this: an unsigned build is still uploadable and
    // the CI diagnose step reports the resulting Gatekeeper verdict.
    console.warn('  • ad-hoc signing FAILED — the .app will be rejected as "damaged" on ' +
      `download: ${err.message.trim()}`);
  }
}

// electron-builder looks for the named export first, then `default`.
exports.afterPack = adhocSign;
exports.default = adhocSign;
