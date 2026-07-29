// Provision and launch a MANAGED ComfyUI install for the desktop app.
//
// ComfyUI becomes a third Python service alongside Mesh Tools and Rigging: its
// own uv-provisioned venv in the per-user data dir, started on demand, stoppable
// from Settings. Users who already run their own ComfyUI are untouched — this
// only fills in apis.comfyui.* when they opt into the managed install.
//
// Two things make this reliable rather than a coin flip:
//
//   1. A LOCK, not per-pack resolution. A working ComfyUI is a specific ~355
//      package resolution plus hand-built CUDA wheels; re-resolving each node
//      pack's requirements.txt on the user's machine drifts (numpy 2 vs 1.26,
//      transformers majors, torch ABI) and is the usual way an install breaks.
//      setup/comfyui-lock-*.txt is generated from a known-good env by
//      tools/gen-comfy-lock.mjs and installed as one atomic resolution.
//   2. No git, no compiler. Node packs come down as pinned GitHub tarballs, and
//      every binary dependency is a prebuilt wheel — either one shipped inside a
//      node repo (ComfyUI-Trellis2/wheels/**) or one served from the manifest's
//      wheelHost. Reachability of the hosted set is checked BEFORE the multi-GB
//      torch download, so a missing wheel fails in seconds, not 20 minutes.
//
// Models are NOT installed here. They live under the data dir (ComfyUI runs with
// --base-directory) and are downloaded by the existing in-app Setup Wizard, which
// is pointed at this install automatically.

const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');

const { runStream, ensureVenv, venvPython, depsMarker, killTree } = require('./pysetup.cjs');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Bump when the provisioning STEPS change in a way that needs a re-run. The lock
// filename already changes when dependencies change, and the marker records it,
// so a regenerated lock re-triggers setup on its own.
const COMFY_SETUP_TAG = 'comfyui-1';

// ---- manifest ---------------------------------------------------------------
function loadManifest(appRoot) {
  const p = path.join(appRoot, 'setup', 'comfyui.json');
  const raw = fs.readFileSync(p, 'utf8');
  const manifest = JSON.parse(raw);
  if (!manifest?.comfyui?.repo || !manifest?.comfyui?.ref) {
    throw new Error('setup/comfyui.json is missing comfyui.repo / comfyui.ref.');
  }
  return manifest;
}

// Max CUDA the installed NVIDIA driver can run, as a major.minor float. Same
// source of truth as the rigging setup's select_flash_attn.py, done in Node here
// because the pick has to happen before a Python exists.
function driverCuda() {
  const override = process.env.GENSTUDIO_COMFY_CUDA;
  if (override) {
    const forced = cudaKey(override);
    if (forced != null) return forced;
  }
  try {
    const r = spawnSync('nvidia-smi', [], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0 || !r.stdout) return null;
    const m = r.stdout.match(/CUDA(?:\s+\w+)?\s+Version:\s*(\d+)\.(\d+)/);
    return m ? Number(`${m[1]}.${m[2]}`) : null;
  } catch {
    return null;
  }
}

// Normalise a CUDA string ("13", "13.0", "13.0.0") to a comparable float.
function cudaKey(text) {
  const m = String(text).match(/\s*(\d+)(?:\.(\d+))?/);
    return m ? Number(`${m[1]}.${m[2] || 0}`) : null;
}

function platformKey() {
  return IS_WIN ? 'windows' : IS_MAC ? 'macos' : 'linux';
}

// Is a managed install even possible on THIS platform? The dependency lock is a
// resolution captured from a real machine — wheels are platform-tagged, and the
// torch version differs per platform — so a build has to be generated on each
// platform we ship (see docs/COMFYUI_MANAGED.md). The UI uses this to hide the
// install option rather than offering one that cannot succeed.
function isAvailableHere(manifest) {
  if (IS_MAC) return false;
  try {
    const m = manifest || {};
    return (m.builds || []).some((b) => b.platform === platformKey());
  } catch {
    return false;
  }
}

// Pick the newest CUDA build this driver can actually run, mirroring the rigging
// wheel-table logic: a build targeting CUDA newer than the driver will not run,
// an older one will.
function pickBuild(manifest) {
  if (IS_MAC) {
    throw new Error('The managed ComfyUI install needs an NVIDIA GPU (CUDA), which macOS does not provide. Point Settings → ComfyUI at a ComfyUI instance on another machine instead.');
  }
  const plat = platformKey();
  const builds = (manifest.builds || []).filter((b) => b.platform === plat);
  if (!builds.length) {
    const have = [...new Set((manifest.builds || []).map((b) => b.platform))].join(', ') || 'none';
    throw new Error(`The managed ComfyUI install is not available on ${plat} yet — this build of the app only ships a dependency set for: ${have}. Install ComfyUI yourself and point Settings → ComfyUI at it.`);
  }
  const cuda = driverCuda();
  if (cuda == null) {
    throw new Error('No NVIDIA GPU / CUDA driver detected. The managed ComfyUI install requires one.');
  }
  const usable = builds.filter((b) => {
    const k = cudaKey(b.cuda);
    return k != null && k <= cuda + 1e-6;
  });
  if (!usable.length) {
    const avail = builds.map((b) => b.cuda).join(', ');
    throw new Error(`Your NVIDIA driver supports CUDA ${cuda}, which is older than every available build (${avail}). Update your GPU driver and try again.`);
  }
  return usable.reduce((best, b) => (cudaKey(b.cuda) > cudaKey(best.cuda) ? b : best));
}

// ---- HTTP -------------------------------------------------------------------
// Follow redirects (GitHub's /archive/ URLs bounce to codeload) and hand back the
// response stream. Rejects on a non-2xx so callers get a real error instead of an
// HTML error page written to disk as a "tarball".
function httpGet(url, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': '3DGenStudio-desktop' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
        const next = new URL(headers.location, url).toString();
        return resolve(httpGet(next, redirectsLeft - 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} for ${url}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

// Cheap reachability probe. A HEAD is enough to prove a wheel URL resolves; some
// hosts (HF, GitHub release assets) answer HEAD with a redirect chain, which
// httpGet-style following handles.
function urlExists(url, redirectsLeft = 6) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': '3DGenStudio-desktop' } }, (res) => {
        res.resume();
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirectsLeft > 0) {
          const next = new URL(headers.location, url).toString();
          return urlExists(next, redirectsLeft - 1).then(done);
        }
        done(statusCode === 200);
      });
    } catch {
      return done(false);
    }
    req.on('error', () => done(false));
    req.setTimeout(30000, () => { req.destroy(); done(false); });
    req.end();
  });
}

// ---- tar.gz extraction ------------------------------------------------------
// GitHub serves every ref as a .tar.gz, so a pinned node pack needs no git binary
// and no zip library — just gunzip plus a ustar walk. Implemented here rather
// than shelling out because neither `tar` (GNU tar can't do zip, bsdtar isn't
// everywhere) nor an npm dependency is reliable across all three platforms.
//
// `strip` drops leading path components: GitHub wraps everything in a
// "<repo>-<sha>/" directory we don't want on disk.
async function extractTarGz(url, destDir, { strip = 1, onLine } = {}) {
  const emit = (s) => { if (onLine) try { onLine(s); } catch { /* ignore */ } };
  emit(`fetching ${url}\n`);
  const res = await httpGet(url);
  const gz = await new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
  const buf = zlib.gunzipSync(gz);
  fs.mkdirSync(destDir, { recursive: true });

  let offset = 0;
  let files = 0;
  // Set by a preceding GNU 'L' entry or a pax 'x' header; overrides the (100
  // byte) name field for the NEXT entry only.
  let pendingName = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;
    offset += 512;

    const readStr = (start, len) => {
      const slice = header.subarray(start, start + len);
      const end = slice.indexOf(0);
      return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
    };
    const readOctal = (start, len) => {
      const s = readStr(start, len).trim();
      return s ? parseInt(s, 8) || 0 : 0;
    };

    const rawName = readStr(0, 100);
    const size = readOctal(124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = readStr(345, 155);
    const padded = Math.ceil(size / 512) * 512;
    const body = buf.subarray(offset, offset + size);
    offset += padded;

    // GNU long name: the entry body IS the next entry's path.
    if (type === 'L') {
      pendingName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    // pax extended header: "<len> path=<value>\n" records.
    if (type === 'x' || type === 'X') {
      const text = body.toString('utf8');
      const m = text.match(/\d+ path=([^\n]+)\n/);
      if (m) pendingName = m[1];
      continue;
    }
    if (type === 'g') continue; // pax_global_header — GitHub emits one first

    let name = pendingName || (prefix ? `${prefix}/${rawName}` : rawName);
    pendingName = null;
    name = name.replace(/\\/g, '/');

    const parts = name.split('/').filter(Boolean).slice(strip);
    if (!parts.length) continue;
    // Refuse anything that escapes destDir — a tarball is untrusted input.
    if (parts.some((p) => p === '..')) {
      throw new Error(`Refusing to extract path traversal entry: ${name}`);
    }
    const target = path.join(destDir, ...parts);

    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (type !== '0' && type !== '\0' && String.fromCharCode(header[156]) !== '\0') {
      // Skip links/devices/fifos — node packs contain none, and silently not
      // creating them beats failing the whole install.
      if (type !== '0') continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    files += 1;
  }
  emit(`extracted ${files} file(s) to ${destDir}\n`);
  if (!files) throw new Error(`Archive at ${url} contained no files.`);
  return files;
}

function archiveUrl(repo, ref) {
  return `https://github.com/${repo}/archive/${ref}.tar.gz`;
}

// Stream a URL to disk. Used for the flash-attn wheel: pip/uv cannot resolve
// Hugging Face Xet URLs directly (they 403), but a plain redirect-following GET
// downloads them fine — so fetch first, then install the local file.
async function downloadFile(url, destPath, onLine) {
  const emit = (s) => { if (onLine) try { onLine(s); } catch { /* ignore */ } };
  emit(`downloading ${url}\n`);
  const res = await httpGet(url);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
  const size = fs.statSync(destPath).size;
  emit(`saved ${path.basename(destPath)} (${(size / 1048576).toFixed(1)} MB)\n`);
  if (size < 1024) throw new Error(`Download of ${url} produced a ${size}-byte file.`);
  return destPath;
}

// ---- flash-attn -------------------------------------------------------------
// flash-attn has no installable upstream build, so it comes from the SAME curated
// per-platform wheel table the rigging service uses
// (thirdparty/skintokens/flash_attention_{windows,linux}.txt). Reusing that table
// means one place to maintain, and its wheels are already hosted.
//
// The match is on BOTH torch version and CUDA, not CUDA alone: the wheel is
// ABI-bound to a specific torch, and this build's torch version is fixed by the
// prebuilt CUDA wheels the lock installs. Picking by CUDA alone could hand back a
// wheel for a different torch that installs cleanly and dies at import.
function flashAttnTablePath(appRoot) {
  const file = IS_WIN ? 'flash_attention_windows.txt' : 'flash_attention_linux.txt';
  return path.join(appRoot, 'thirdparty', 'skintokens', file);
}

// "torch==2.10.0 torchvision==... --index-url ..." -> "2.10.0"
function torchVersionOf(build) {
  const m = String(build.torchArgs || '').match(/torch[=~]=([0-9][^\s]*)/);
  return m ? m[1].replace(/\+.*$/, '') : null;
}

function selectFlashAttn({ appRoot, build, onLine }) {
  const tablePath = flashAttnTablePath(appRoot);
  if (!fs.existsSync(tablePath)) {
    throw new Error(`Missing flash-attn wheel table: ${path.basename(tablePath)}`);
  }
  const wantTorch = torchVersionOf(build);
  if (!wantTorch) {
    throw new Error('Could not read the torch version from this build\'s torchArgs.');
  }
  const driver = driverCuda();
  if (driver == null) throw new Error('No NVIDIA GPU / CUDA driver detected.');

  const rows = [];
  for (const line of fs.readFileSync(tablePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.toLowerCase().startsWith('torch;')) continue;
    const parts = t.split(';').map((s) => s.trim());
    if (parts.length < 3) continue;
    const cuda = cudaKey(parts[1]);
    if (cuda == null) continue;
    rows.push({ torch: parts[0].replace(/^~=/, ''), cuda, url: parts[2] });
  }

  const sameTorch = rows.filter((r) => r.torch === wantTorch);
  if (!sameTorch.length) {
    const have = [...new Set(rows.map((r) => r.torch))].join(', ') || 'none';
    throw new Error(`${path.basename(tablePath)} has no flash-attn wheel for torch ${wantTorch} (it lists: ${have}). Add a matching row for this ComfyUI build, or change the build's torch version.`);
  }
  const usable = sameTorch.filter((r) => r.cuda <= driver + 1e-6);
  if (!usable.length) {
    const avail = sameTorch.map((r) => r.cuda).join(', ');
    throw new Error(`Your NVIDIA driver supports CUDA ${driver}, older than every flash-attn wheel for torch ${wantTorch} (CUDA builds: ${avail}). Update your GPU driver.`);
  }
  const pick = usable.reduce((best, r) => (r.cuda > best.cuda ? r : best));
  if (onLine) onLine(`flash-attn: torch ${pick.torch} / CUDA ${pick.cuda} (driver supports ${driver})\n`);
  return pick.url;
}

// ---- lock file --------------------------------------------------------------
// The lock ships with placeholders because neither path is known until install
// time. ${NODE_DIR} resolves to this install's custom_nodes (wheels that ride
// along inside a node repo) and ${WHEEL_HOST} to the manifest's wheel base URL.
function materializeLock({ appRoot, build, manifest, installDir, venvDir }) {
  const src = path.join(appRoot, 'setup', build.lock);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing dependency lock file: setup/${build.lock}`);
  }
  const wheelHost = String(manifest.wheelHost || '').replace(/\/+$/, '');
  const text = fs.readFileSync(src, 'utf8');

  if (text.includes('${WHEEL_HOST}') && !wheelHost) {
    throw new Error('setup/comfyui.json has no "wheelHost", but the dependency lock needs prebuilt wheels from it. See tools/gen-comfy-lock.mjs for the list to publish.');
  }

  // A local path becomes a file:// URL for pip; encode it so spaces and the "#"
  // in a folder name like "CUDA 13.1" survive (an unencoded "#" would truncate
  // the URL at the fragment).
  const nodeDirUrl = pathToFileUrl(path.join(installDir, 'custom_nodes'));
  const out = text
    .replace(/\$\{NODE_DIR\}/g, nodeDirUrl)
    .replace(/\$\{WHEEL_HOST\}/g, wheelHost);

  const dest = path.join(venvDir, 'comfyui-lock.txt');
  fs.mkdirSync(venvDir, { recursive: true });
  fs.writeFileSync(dest, out);
  return dest;
}

function pathToFileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, '/');
  const withSlash = abs.startsWith('/') ? abs : `/${abs}`;
  // encodeURI leaves '/' and ':' alone but escapes spaces; '#' needs doing by hand.
  return `file://${encodeURI(withSlash).replace(/#/g, '%23')}`;
}

// Prove every ${WHEEL_HOST} wheel is actually downloadable before committing to
// a multi-GB torch install. A 404 here is a packaging mistake on our side and the
// message should say exactly which file is missing.
async function verifyHostedWheels({ build, manifest, onLine }) {
  const files = build.hostedWheels || [];
  if (!files.length) return;
  const wheelHost = String(manifest.wheelHost || '').replace(/\/+$/, '');
  const missing = [];
  for (const file of files) {
    const url = `${wheelHost}/${encodeURIComponent(file)}`;
    const ok = await urlExists(url);
    if (onLine) onLine(`${ok ? 'ok  ' : 'MISSING '} ${file}\n`);
    if (!ok) missing.push(file);
  }
  if (missing.length) {
    throw new Error(`${missing.length} prebuilt wheel(s) are not available at ${wheelHost}: ${missing.join(', ')}. The managed ComfyUI install cannot complete without them.`);
  }
}

// ---- provisioning -----------------------------------------------------------
// `onProgress` receives { kind:'phase'|'log'|'done'|'error', phase, pct, text },
// the same contract the other services use, so the setup window renders it with
// no special-casing.
async function setupComfyUI({ uv, appRoot, installDir, dataDir, venvDir, onProgress }) {
  const emit = (e) => onProgress(e);
  const log = (text) => emit({ kind: 'log', text });
  const phase = (label, pct) => emit({ kind: 'phase', phase: label, pct });

  const manifest = loadManifest(appRoot);
  const build = pickBuild(manifest);
  const pyVer = manifest.pythonVersion || '3.13';
  const vp = venvPython(venvDir);
  log(`Target: ComfyUI ${manifest.comfyui.tag || manifest.comfyui.ref.slice(0, 8)} · Python ${pyVer} · CUDA ${build.cuda}\n`);

  phase('Checking prebuilt wheels', 0.01);
  await verifyHostedWheels({ build, manifest, onLine: log });

  phase('Provisioning Python', 0.04);
  {
    const r = await runStream(uv, ['python', 'install', pyVer], { onLine: log });
    if (r.code !== 0) throw new Error(`Could not provision Python ${pyVer} (exit ${r.code}).`);
  }

  phase('Creating virtual environment', 0.08);
  {
    const code = await ensureVenv({ uv, serviceDir: appRoot, venvDir, onLine: log, pythonVersion: pyVer });
    if (code !== 0) throw new Error(`Could not create the ComfyUI virtual environment (exit ${code}).`);
  }

  // ComfyUI itself, then the node packs, BEFORE the lock install — the lock
  // references wheels that live inside ComfyUI-Trellis2/wheels/**, so those files
  // have to be on disk first.
  phase('Downloading ComfyUI', 0.12);
  fs.mkdirSync(installDir, { recursive: true });
  await extractTarGz(archiveUrl(manifest.comfyui.repo, manifest.comfyui.ref), installDir, { onLine: log });

  const nodes = manifest.customNodes || [];
  const nodesDir = path.join(installDir, 'custom_nodes');
  fs.mkdirSync(nodesDir, { recursive: true });
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    phase(`Downloading custom nodes (${i + 1}/${nodes.length}: ${node.name})`, 0.16 + 0.24 * (i / nodes.length));
    const dest = path.join(nodesDir, node.name);
    // Replace rather than merge: a half-extracted pack from an interrupted run
    // would otherwise mix two refs.
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
    await extractTarGz(archiveUrl(node.repo, node.ref), dest, { onLine: log });
  }

  // torch first, from its own CUDA index. The lock deliberately excludes torch:
  // it carries no index-url context, and every prebuilt wheel in it is ABI-matched
  // to exactly this torch version.
  phase('Installing PyTorch', 0.42);
  {
    const torchArgs = String(build.torchArgs || '').trim().split(/\s+/).filter(Boolean);
    if (!torchArgs.length) throw new Error('The selected build has no torchArgs in setup/comfyui.json.');
    const r = await runStream(uv, ['pip', 'install', '--python', vp, ...torchArgs], { onLine: log });
    if (r.code !== 0) throw new Error(`PyTorch install failed (exit ${r.code}).`);
  }

  // flash-attn from the shared wheel table, ABI-matched to the torch just
  // installed. Downloaded first because pip/uv can't resolve HF Xet URLs.
  phase('Installing flash-attn', 0.5);
  {
    const url = selectFlashAttn({ appRoot, build, onLine: log });
    const local = path.join(venvDir, 'wheels', decodeURIComponent(url.split('/').pop().split('?')[0]));
    await downloadFile(url, local, log);
    const r = await runStream(uv, ['pip', 'install', '--python', vp, local], { onLine: log });
    if (r.code !== 0) throw new Error(`flash-attn install failed (exit ${r.code}).`);
  }

  phase('Installing ComfyUI dependencies', 0.6);
  {
    const lockPath = materializeLock({ appRoot, build, manifest, installDir, venvDir });
    const r = await runStream(uv, ['pip', 'install', '--python', vp, '-r', lockPath], { onLine: log });
    if (r.code !== 0) throw new Error(`Dependency install failed (exit ${r.code}). See details.`);
  }

  // Prove the CUDA extensions actually LOAD. A wheel built against a different
  // torch ABI installs cleanly and only dies at import with "undefined symbol",
  // which would otherwise surface as a mystery node-import failure much later.
  phase('Verifying install', 0.92);
  {
    const required = manifest.verifyImports || ['torch'];
    // Optional modules are probed too, but only reported: these are guarded or
    // in-function imports whose absence costs a specific feature rather than
    // breaking the install (e.g. natten -> the Pixal3D-T model only).
    const optional = manifest.optionalImports || [];
    const probe = [
      'import importlib, sys',
      `required = ${JSON.stringify(required)}`,
      `optional = ${JSON.stringify(optional)}`,
      'bad = []',
      'def probe(m):',
      '    try:',
      '        importlib.import_module(m)',
      '        return True',
      '    except Exception as e:',
      '        print("     ", type(e).__name__, e)',
      '        return False',
      'for m in required:',
      '    if probe(m):',
      '        print("ok       ", m)',
      '    else:',
      '        print("FAIL     ", m)',
      '        bad.append(m)',
      'for m in optional:',
      '    print(("ok       " if probe(m) else "optional "), m)',
      'sys.exit(1 if bad else 0)',
    ].join('\n');
    const r = await runStream(vp, ['-c', probe], { cwd: installDir, onLine: log });
    if (r.code !== 0) {
      throw new Error('ComfyUI installed but some GPU modules will not import — most likely a torch ABI mismatch with a prebuilt wheel (see details).');
    }
  }

  // The data dir is ComfyUI's --base-directory: models/, input/, output/, user/
  // all live here. Kept separate from installDir so re-running setup never risks
  // the multi-GB model downloads.
  phase('Preparing data folders', 0.97);
  for (const sub of ['models', 'input', 'output', 'user']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  fs.writeFileSync(depsMarker(venvDir), `${COMFY_SETUP_TAG} ${build.lock} ${new Date().toISOString()}`);
  phase('ComfyUI ready', 1);
  emit({ kind: 'done' });

  return { installDir, dataDir, modelsPath: path.join(dataDir, 'models') };
}

// ---- launcher ---------------------------------------------------------------
function startComfyUI({ appRoot, installDir, dataDir, venvDir, port, logStream, log }) {
  const write = (s) => { try { logStream && logStream.write(s); } catch { /* ignore */ } };
  const vp = venvPython(venvDir);
  if (!fs.existsSync(vp) || !fs.existsSync(path.join(installDir, 'main.py'))) {
    log && log('ComfyUI is not installed yet — skipping launch.');
    return { stop() {} };
  }

  let extraArgs = [];
  try {
    extraArgs = loadManifest(appRoot).launchArgs || [];
  } catch { /* manifest problems already surfaced during setup */ }

  // Keep models/input/output/user/temp in the writable data dir so reinstalling
  // ComfyUI never touches the user's models.
  //
  // Deliberately NOT --base-directory: that also relocates custom_nodes, and
  // main.py's execute_prestartup_script() then does os.listdir(<base>/custom_nodes)
  // and dies with FileNotFoundError before the server ever binds — the node packs
  // live next to the code, in <installDir>/custom_nodes. These per-directory flags
  // each document "Overrides --base-directory", so they move exactly what we want
  // and leave custom_nodes resolving to the install dir.
  const dirs = {
    models: path.join(dataDir, 'models'),
    input: path.join(dataDir, 'input'),
    output: path.join(dataDir, 'output'),
    user: path.join(dataDir, 'user'),
    temp: path.join(dataDir, 'temp'),
  };
  // --user-directory and --models-directory are validated with is_valid_directory,
  // which REJECTS a path that doesn't exist — so create them before launching
  // (setup makes them too, but a user can delete them between runs).
  for (const dir of Object.values(dirs)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* surfaced by the launch failing */ }
  }

  const args = [
    'main.py',
    '--listen', '127.0.0.1',
    '--port', String(port),
    '--models-directory', dirs.models,
    '--input-directory', dirs.input,
    '--output-directory', dirs.output,
    '--user-directory', dirs.user,
    '--temp-directory', dirs.temp,
    ...extraArgs,
  ];

  let proc = null;
  // Last chunk of output, so a launch failure can be reported with its actual
  // cause instead of making the caller poll /system_stats until it times out.
  let tail = '';
  const keepTail = (s) => { tail = (tail + s).slice(-4000); };

  let settleExit;
  const exited = new Promise((resolve) => { settleExit = resolve; });

  try {
    log && log(`Starting ComfyUI on port ${port}…`);
    proc = spawn(vp, args, {
      cwd: installDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        // MANDATORY on Windows. We capture stdout/stderr through pipes, and for a
        // pipe Python defaults to the ANSI codepage (cp1252) rather than utf-8.
        // Several node packs log emoji at import time (rgthree's "Loaded 48
        // fantastic nodes. 🎉"), which then raises UnicodeEncodeError inside
        // logging and KILLS ComfyUI with exit code 1 partway through loading —
        // looking exactly like a mystery startup crash.
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so killTree can take down worker children too.
      detached: !IS_WIN,
    });
    proc.stdout.on('data', (d) => { const s = d.toString(); write(s); keepTail(s); });
    proc.stderr.on('data', (d) => { const s = d.toString(); write(s); keepTail(s); });
    proc.on('exit', (code, signal) => {
      log && log(`ComfyUI exited (code=${code} signal=${signal})`);
      settleExit({ code, signal, tail });
    });
    proc.on('error', (err) => {
      log && log(`ComfyUI failed to start: ${err.message}`);
      settleExit({ code: -1, signal: null, tail: err.message });
    });
  } catch (err) {
    log && log(`ComfyUI failed to start: ${err.message}`);
    settleExit({ code: -1, signal: null, tail: err.message });
  }

  let stopped = false;
  return {
    // Resolves when the process dies. ensureService races this against the health
    // poll so a crash surfaces at once rather than after the full timeout.
    exited,
    stop() {
      if (stopped) return;
      stopped = true;
      // ComfyUI spawns worker/subprocess children for some nodes; kill the tree.
      if (proc && proc.pid) killTree(proc.pid);
    },
  };
}

module.exports = {
  COMFY_SETUP_TAG,
  loadManifest,
  isAvailableHere,
  pickBuild,
  driverCuda,
  extractTarGz,
  selectFlashAttn,
  setupComfyUI,
  startComfyUI,
  // Exported for offline validation of a regenerated lock (see docs/COMFYUI_MANAGED.md).
  materializeLock,
  verifyHostedWheels,
};
