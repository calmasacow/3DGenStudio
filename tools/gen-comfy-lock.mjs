#!/usr/bin/env node
// Generate the desktop app's ComfyUI provisioning artifacts from a WORKING
// ComfyUI install. Run this on a machine where ComfyUI + all the node packs the
// shipped workflows need actually run, and it emits:
//
//   setup/comfyui.json                          -- node-pack manifest (repo + pinned SHA)
//   setup/comfyui-lock-<os>-py<ver>-cu<cuda>.txt -- the full resolved dependency set
//
// Why a LOCK rather than resolving each pack's requirements.txt at install time:
// a working ComfyUI is a specific ~360-package resolution plus a handful of
// hand-built CUDA wheels. Re-resolving per pack on the user's machine drifts
// (numpy 2 vs 1.26, transformers majors, torch ABI) and is the single most common
// way a ComfyUI install ends up broken. Installing a frozen set that is KNOWN to
// work is deterministic and much faster.
//
// Local-wheel entries in the freeze are rewritten to one of two placeholders,
// substituted at install time by electron/comfysetup.cjs:
//
//   ${NODE_DIR}  wheels that ship INSIDE a node repo (ComfyUI-Trellis2/wheels/**)
//                -> no hosting needed, the repo download brings them along
//   ${WHEEL_HOST} hand-built wheels with no upstream home (diso, drtk, custom
//                open3d, torch_cluster/scatter, custom_rasterizer, autoretopo)
//                -> these MUST be published somewhere reachable; the script
//                   prints the exact list at the end
//
// `git+https://...@<sha>` deps are rewritten to the equivalent GitHub tarball URL
// so installs never need a git binary.
//
// Usage:
//   node tools/gen-comfy-lock.mjs --comfy C:/Git/ComfyUI --venv C:/Git/ComfyUI/venv_313 \
//        --cuda 13.0 --wheel-host https://github.com/visualbruno/3DGenStudio-wheels/releases/download/v1
//
// Only --comfy is required; --venv is guessed, --cuda read from nvidia-smi.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const IS_WIN = process.platform === 'win32';

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else { out[key] = true; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const COMFY = path.resolve(args.comfy || 'C:/Git/ComfyUI');
const OUT_DIR = path.resolve(args.out || path.join(REPO_ROOT, 'setup'));
const WHEEL_HOST = typeof args['wheel-host'] === 'string' ? args['wheel-host'].replace(/\/+$/, '') : '';

if (!fs.existsSync(COMFY)) die(`ComfyUI folder not found: ${COMFY}`);
if (!fs.existsSync(path.join(COMFY, 'main.py'))) die(`Not a ComfyUI folder (no main.py): ${COMFY}`);

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// Read the existing manifest up front: several hand-maintained fields
// (excludePackages, wheelHost, launchArgs, verifyImports) steer generation and
// must survive a regeneration.
const MANIFEST_PATH = path.join(OUT_DIR, 'comfyui.json');
let prevManifestEarly = {};
try {
  prevManifestEarly = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
} catch { /* first run */ }

// ---- locate the venv --------------------------------------------------------
// Prefer an explicit --venv; otherwise look for the conventional layouts. The
// version-suffixed names (venv_313) are how the reference install is set up.
function findVenvPython() {
  if (typeof args.venv === 'string') {
    const p = venvPython(path.resolve(args.venv));
    if (!fs.existsSync(p)) die(`No python in --venv: ${p}`);
    return p;
  }
  const candidates = ['venv_313', '.venv_313', 'venv', '.venv', 'python_embeded'];
  for (const c of candidates) {
    const dir = path.join(COMFY, c);
    const p = c === 'python_embeded' ? path.join(dir, 'python.exe') : venvPython(dir);
    if (fs.existsSync(p)) return p;
  }
  die(`Could not find a ComfyUI venv under ${COMFY}. Pass --venv <path>.`);
}

function venvPython(dir) {
  return IS_WIN ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}

const PY = findVenvPython();

function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message) };
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---- environment facts ------------------------------------------------------
const pyVer = (() => {
  const r = run(PY, ['-c', 'import sys;print(f"{sys.version_info.major}.{sys.version_info.minor}")']);
  if (r.code !== 0) die(`Could not run ${PY}: ${r.stderr.trim()}`);
  return r.stdout.trim();
})();

const torchInfo = (() => {
  const r = run(PY, ['-c', 'import torch;print(torch.__version__);print(torch.version.cuda or "")']);
  if (r.code !== 0) return { version: '', cuda: '' };
  const [version = '', cuda = ''] = r.stdout.trim().split(/\r?\n/);
  return { version: version.trim(), cuda: cuda.trim() };
})();

// The CUDA key names the lock file and is matched against the user's driver at
// install time. Prefer --cuda, then the CUDA torch was built against.
const cudaKey = (typeof args.cuda === 'string' ? args.cuda : torchInfo.cuda) || '';
if (!cudaKey) die('Could not determine the CUDA version. Pass --cuda 13.0.');

const osKey = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const cudaTag = `cu${cudaKey.replace(/\./g, '')}`;
const lockName = `comfyui-lock-${osKey}-py${pyVer.replace('.', '')}-${cudaTag}.txt`;

// ---- freeze -----------------------------------------------------------------
const freeze = (() => {
  const r = run(PY, ['-m', 'pip', 'freeze'], COMFY);
  if (r.code !== 0) die(`pip freeze failed: ${r.stderr.trim()}`);
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
})();

// Packages COMPILED FROM SOURCE in the reference env (`pip install .` against a
// local CUDA toolkit) land as a bare `name==version` in the freeze but do not
// exist on PyPI under that version — custom_rasterizer is the usual culprit.
// Left alone they turn into a confident-looking lock that fails halfway through
// on a user's machine, so detect them here and route them through ${WHEEL_HOST}
// like any other hand-built wheel. Signature: legacy .egg-info metadata (or a
// missing installer record) with no direct_url.json.
const PROBE_DISTS = `
import json
from importlib.metadata import distributions
out = []
for d in distributions():
    try:
        name = d.metadata['Name']
    except Exception:
        continue
    if not name:
        continue
    origin = None
    try:
        raw = d.read_text('direct_url.json')
        if raw:
            origin = json.loads(raw).get('url')
    except Exception:
        pass
    try:
        installer = (d.read_text('INSTALLER') or '').strip()
    except Exception:
        installer = ''
    out.append({
        'name': name,
        'version': d.version,
        'origin': origin,
        'installer': installer,
        'path': str(getattr(d, '_path', '')),
    })
print(json.dumps(out))
`;

const sourceBuilt = new Map(); // normalized name -> { name, version }
{
  const r = run(PY, ['-c', PROBE_DISTS], COMFY);
  if (r.code !== 0) {
    console.error(`warning: could not inspect installed distributions (${r.stderr.trim()}); ` +
      'source-built packages will not be detected.');
  } else {
    let dists = [];
    try { dists = JSON.parse(r.stdout); } catch { dists = []; }
    for (const d of dists) {
      if (d.origin) continue;                          // came from a URL/file we already rewrite
      if (!/\.egg-info$/i.test(d.path || '')) continue; // modern wheel install
      sourceBuilt.set(normalizeName(d.name), { name: d.name, version: d.version });
    }
  }
}

function normalizeName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

// The filename a source-built package's wheel is EXPECTED to have once built and
// published. `pip wheel .` in the reference env produces exactly this, so the
// name is predictable rather than a guess the user has to reverse-engineer.
function expectedWheelName(name, version) {
  const tag = `cp${pyVer.replace('.', '')}`;
  const plat = IS_WIN ? 'win_amd64' : osKey === 'macos' ? 'macosx_11_0_arm64' : 'linux_x86_64';
  return `${String(name).replace(/-/g, '_')}-${version}-${tag}-${tag}-${plat}.whl`;
}

// ---- node packs -------------------------------------------------------------
// A pack is shipped only if it is a git checkout (we need a remote + SHA to pin).
// Anything else (a hand-copied folder, __pycache__, a loose .py) is reported and
// skipped — it cannot be reproduced on a user's machine.
function gitInfo(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const url = run('git', ['-C', dir, 'config', '--get', 'remote.origin.url']).stdout.trim();
  const sha = run('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.trim();
  if (!url || !sha) return null;
  const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!m) return null;

  // Users receive the TARBALL of this exact commit, so two states of the
  // reference checkout are shipping hazards and neither is visible in the
  // generated manifest:
  //
  //   unpushed  HEAD isn't on any remote branch -> the archive URL 404s for
  //             every user. Hard error.
  //   dirty     tracked files are modified locally -> the reference env behaves
  //             differently from what ships, because uncommitted work is not in
  //             the tarball. Warning.
  //
  // (Untracked files are ignored: downloaded checkpoints and IDE folders litter
  // these checkouts and never affect what ships.)
  const onRemote = run('git', ['-C', dir, 'branch', '-r', '--contains', sha]).stdout.trim() !== '';
  const modified = run('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no']).stdout
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // Is the checkout behind its own remote branch? Not fatal — pinning an older
  // commit is legitimate — but worth surfacing so a forgotten pull is obvious.
  const behind = Number(run('git', ['-C', dir, 'rev-list', '--count', `${sha}..origin/HEAD`]).stdout.trim()) || 0;

  return { repo: `${m[1]}/${m[2]}`, ref: sha, onRemote, modified, behind };
}

const comfyGit = gitInfo(COMFY);
if (!comfyGit) die(`${COMFY} is not a GitHub git checkout — cannot pin a ComfyUI version.`);
const comfyTag = run('git', ['-C', COMFY, 'describe', '--tags', '--abbrev=0']).stdout.trim();

const nodesDir = path.join(COMFY, 'custom_nodes');
// Packs present on the reference machine that we deliberately DON'T ship: no
// bundled workflow uses any of their nodes. Hand-maintained (a heuristic
// workflow->pack mapper would eventually drop a pack that IS needed, which is a
// much worse failure than shipping one too many), and preserved across
// regenerations. See docs/COMFYUI_MANAGED.md for the current rationale per pack.
const excludeNodes = new Set(prevManifestEarly.excludeNodes || []);
const excludedNodes = [];
const skipped = [];
const nodes = [];
const packAudit = [];
for (const entry of fs.readdirSync(nodesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory() || entry.name === '__pycache__') continue;
  if (excludeNodes.has(entry.name)) { excludedNodes.push(entry.name); continue; }
  const dir = path.join(nodesDir, entry.name);
  const info = gitInfo(dir);
  if (!info) { skipped.push(entry.name); continue; }
  // Record whether the pack carries its own prebuilt wheels, so the installer
  // knows to look inside it after unpacking (ComfyUI-Trellis2 does).
  // The audit fields are for this script's report only — keep them out of the
  // manifest, which should carry just what the installer needs.
  const { onRemote, modified, behind, ...pin } = info;
  packAudit.push({ name: entry.name, onRemote, modified, behind });
  const node = { name: entry.name, ...pin };
  if (fs.existsSync(path.join(dir, 'wheels'))) node.hasWheels = true;
  nodes.push(node);
}

// ---- rewrite the freeze into a portable lock --------------------------------
const nodeWheels = [];   // wheels found inside a node repo -> ${NODE_DIR}
const hostWheels = [];   // hand-built wheels with no home  -> ${WHEEL_HOST}
const tarballs = [];     // git+ deps rewritten to archive tarballs

// A file:// URL in a freeze is percent-encoded; decode before matching paths.
// fileURLToPath rather than a hand-rolled strip: the two platforms disagree about
// the third slash. "file:///C:/x" -> "C:/x" (drop it) but "file:///home/x" ->
// "/home/x" (KEEP it — it's the root). Dropping it on Linux yields a RELATIVE
// path, which then resolves against this script's cwd, so every node-local wheel
// looks like it lives outside custom_nodes and gets misrouted to ${WHEEL_HOST}.
function decodeFileUrl(url) {
  try {
    return fileURLToPath(url).replace(/\\/g, '/');
  } catch {
    // Not a well-formed file URL (a bare path, a UNC oddity) — fall back to the
    // literal text so the caller still gets something to match on.
    return decodeURIComponent(url.replace(/^file:\/\//, '')).replace(/\\/g, '/');
  }
}

function rewriteLine(line) {
  // "name @ file:///C:/..." -> placeholder form
  const fileMatch = line.match(/^(\S+)\s*@\s*(file:\/\/\S+)$/i);
  if (fileMatch) {
    const [, name, url] = fileMatch;
    const abs = decodeFileUrl(url);
    const rel = path.relative(nodesDir, abs).replace(/\\/g, '/');
    if (!rel.startsWith('..')) {
      nodeWheels.push({ name, rel });
      // Percent-encode: ComfyUI-Trellis2 ships wheels under "CUDA 13.1", and a
      // raw space in a requirements URL is at best installer-dependent.
      return `${name} @ \${NODE_DIR}/${encodeURI(rel).replace(/#/g, '%23')}`;
    }
    const base = path.basename(abs);
    hostWheels.push({ name, file: base });
    return `${name} @ \${WHEEL_HOST}/${base}`;
  }

  // "name @ git+https://github.com/o/r@sha" -> codeload tarball (no git needed)
  const gitMatch = line.match(/^(\S+)\s*@\s*git\+https:\/\/github\.com\/([^/]+)\/([^@/]+?)(?:\.git)?@([0-9a-f]{7,40})$/i);
  if (gitMatch) {
    const [, name, owner, repo, sha] = gitMatch;
    const url = `https://github.com/${owner}/${repo}/archive/${sha}.tar.gz`;
    tarballs.push({ name, url });
    return `${name} @ ${url}`;
  }

  // "name==version" for something compiled from source here -> hosted wheel.
  const pinMatch = line.match(/^([A-Za-z0-9._-]+)==(.+)$/);
  if (pinMatch) {
    const [, name, version] = pinMatch;
    const built = sourceBuilt.get(normalizeName(name));
    if (built) {
      const file = expectedWheelName(name, version);
      hostWheels.push({ name, file, built: true });
      return `${name} @ \${WHEEL_HOST}/${file}`;
    }
  }

  return line;
}

// Drop packages that must never come from the lock: torch is installed FIRST
// from its own CUDA index (the lock has no index-url context), and pip/setuptools/
// wheel/uv are the installer's own tools.
const TORCH_PKGS = new Set(['torch', 'torchvision', 'torchaudio']);
const TOOL_PKGS = new Set(['pip', 'setuptools', 'wheel', 'uv']);

// Packages present in the reference env but deliberately OMITTED from the lock,
// because they are optional at runtime (guarded or in-function imports) and have
// no publishable wheel. Keeping them in would make every install depend on
// hosting a wheel that nothing actually needs. Hand-maintained in the manifest;
// see optionalImports for how their absence is reported.
const excludePackages = new Set(
  (prevManifestEarly.excludePackages || []).map((n) => normalizeName(n))
);
const excluded = [];

const lockLines = [];
const torchPins = {};
for (const line of freeze) {
  const name = (line.match(/^([A-Za-z0-9._-]+)/) || [])[1] || '';
  const key = name.toLowerCase().replace(/_/g, '-');
  if (TORCH_PKGS.has(key)) {
    const ver = (line.split('==')[1] || '').trim();
    if (ver) torchPins[key] = ver;
    continue;
  }
  if (TOOL_PKGS.has(key)) continue;
  if (excludePackages.has(normalizeName(name))) { excluded.push(name); continue; }
  lockLines.push(rewriteLine(line));
}

// ---- torch install command --------------------------------------------------
// Reuse the shape the rigging setup already relies on: explicit pins + the CUDA
// wheel index. Versions come from the reference env so the ABI matches every
// prebuilt wheel in the lock.
const torchArgs = [
  torchPins.torch ? `torch==${torchPins.torch.replace(/\+.*$/, '')}` : null,
  torchPins.torchvision ? `torchvision==${torchPins.torchvision.replace(/\+.*$/, '')}` : null,
  torchPins.torchaudio ? `torchaudio==${torchPins.torchaudio.replace(/\+.*$/, '')}` : null,
  '--index-url', `https://download.pytorch.org/whl/${cudaTag}`,
].filter(Boolean).join(' ');

// ---- write ------------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true });

const lockHeader = [
  `# GENERATED by tools/gen-comfy-lock.mjs — do not hand-edit.`,
  `# Reference env: ${COMFY}`,
  `# Python ${pyVer} · torch ${torchInfo.version} · CUDA ${cudaKey} · ${osKey}`,
  // Written without the ${...} braces so the installer's own placeholder
  // substitution doesn't rewrite this comment and confuse the setup log.
  `# Placeholders: NODE_DIR = <install>/custom_nodes, WHEEL_HOST = manifest wheelHost`,
  '',
].join('\n');
fs.writeFileSync(path.join(OUT_DIR, lockName), lockHeader + lockLines.join('\n') + '\n');

const manifestPath = MANIFEST_PATH;
// Deployment/runtime config, not facts discoverable from the reference machine,
// so a regeneration must not stomp them.
const prevManifest = prevManifestEarly;

const manifest = {
  $comment: 'GENERATED by tools/gen-comfy-lock.mjs. wheelHost, launchArgs, verifyImports, optionalImports and excludePackages are hand-maintained and preserved across regenerations.',
  comfyui: { repo: comfyGit.repo, ref: comfyGit.ref, tag: comfyTag || undefined },
  pythonVersion: pyVer,
  wheelHost: WHEEL_HOST || prevManifest.wheelHost || '',
  // Extra flags for `python main.py` on launch.
  launchArgs: prevManifest.launchArgs || ['--use-flash-attention'],
  // Modules the installer imports to prove the GPU wheels actually load — a wheel
  // built against a different torch ABI installs fine and only fails at import.
  // A failure here FAILS the install.
  verifyImports: prevManifest.verifyImports || ['torch'],
  // Same probe, but non-fatal: capabilities that degrade rather than break when
  // absent (guarded or in-function imports). Reported in the setup log so it's
  // visible which optional features this machine won't have.
  optionalImports: prevManifest.optionalImports || [],
  // Omitted from the generated lock entirely — see the excludePackages comment
  // in the loop above.
  excludePackages: prevManifest.excludePackages || [],
  // custom_nodes folders on the reference machine that we don't ship.
  excludeNodes: prevManifest.excludeNodes || [],
  builds: [
    {
      platform: osKey,
      cuda: cudaKey,
      torchArgs,
      lock: lockName,
      // Wheels the lock pulls from ${WHEEL_HOST}; the installer verifies every
      // one is reachable BEFORE downloading multiple GB of torch.
      hostedWheels: [...new Set(hostWheels.map((w) => w.file))].sort(),
    },
  ],
  customNodes: nodes,
};

// Merge this build into any builds already recorded for other platforms/CUDA
// versions instead of clobbering them.
try {
  const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Array.isArray(prev.builds)) {
    const keep = prev.builds.filter((b) => !(b.platform === osKey && b.cuda === cudaKey));
    manifest.builds = [...keep, ...manifest.builds];
  }
} catch { /* first run */ }

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// ---- sanity: can this reference env actually satisfy the install gate? -------
// The installer's last step imports manifest.verifyImports and FAILS if any are
// missing. If they aren't importable HERE, the lock we just wrote can't satisfy
// that gate on a user's machine either — better to say so now than to ship a
// manifest whose own install is guaranteed to fail at 92%.
const gateMissing = [];
{
  const mods = manifest.verifyImports || [];
  if (mods.length) {
    const probe = [
      'import importlib, sys',
      `mods = ${JSON.stringify(mods)}`,
      'for m in mods:',
      '    try:',
      '        importlib.import_module(m)',
      '    except Exception:',
      '        print(m)',
    ].join('\n');
    const r = run(PY, ['-c', probe], COMFY);
    if (r.code === 0) {
      gateMissing.push(...r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    }
  }
}

// ---- report -----------------------------------------------------------------
const rel = (p) => path.relative(REPO_ROOT, p).replace(/\\/g, '/');
console.log(`Python ${pyVer} · torch ${torchInfo.version} · CUDA ${cudaKey} · ${osKey}`);
console.log(`torch install: ${torchArgs}`);
console.log(`wrote ${rel(path.join(OUT_DIR, lockName))} (${lockLines.length} packages)`);
console.log(`wrote ${rel(manifestPath)} (${nodes.length} node packs)`);
if (tarballs.length) {
  console.log(`\nrewrote ${tarballs.length} git dependency(ies) to tarballs (no git needed at install time):`);
  for (const t of tarballs) console.log(`  ${t.name} -> ${t.url}`);
}
if (nodeWheels.length) {
  console.log(`\n${nodeWheels.length} wheel(s) resolve from inside a node repo — nothing to host:`);
  for (const w of nodeWheels) console.log(`  ${w.name} -> \${NODE_DIR}/${w.rel}`);
}
if (excluded.length) {
  console.log(`\nexcluded from the lock by manifest.excludePackages (optional at runtime): ${excluded.join(', ')}`);
}
if (excludedNodes.length) {
  console.log(`\nnot shipped, per manifest.excludeNodes (${excludedNodes.length} pack(s) no bundled workflow uses):`);
  console.log(`  ${excludedNodes.join(', ')}`);
  console.log('  NOTE: the lock is still a freeze of THIS machine, so it may carry dependencies');
  console.log('  only those packs needed. For a minimal lock, generate from an env with just the');
  console.log('  shipped packs installed.');
}
if (skipped.length) {
  console.log(`\nWARNING: ${skipped.length} custom_nodes folder(s) are not GitHub checkouts and were SKIPPED`);
  console.log(`(they cannot be reproduced on a user's machine): ${skipped.join(', ')}`);
}
// Pinned commits that aren't on a remote branch would 404 for every user, so this
// is fatal. Local modifications only mean the reference env differs from what
// ships — worth shouting about, but not fatal.
{
  const unpushed = packAudit.filter((p) => !p.onRemote);
  const dirty = packAudit.filter((p) => p.modified.length);
  const behind = packAudit.filter((p) => p.behind > 0);

  if (unpushed.length) {
    console.log(`\n${'!'.repeat(72)}`);
    console.log(`UNPUSHED COMMITS: ${unpushed.length} pack(s) are pinned to a commit that is not on`);
    console.log('any remote branch. The install downloads github.com/<repo>/archive/<ref>.tar.gz,');
    console.log('so these would 404 for every user. Push them, then re-run:');
    for (const p of unpushed) console.log(`  ${p.name}`);
    console.log('!'.repeat(72));
    process.exitCode = 1;
  }
  if (dirty.length) {
    console.log(`\nWARNING: ${dirty.length} pack(s) have locally MODIFIED tracked files. Users get the`);
    console.log('tarball of the pinned commit, so those edits do NOT ship — the reference env');
    console.log('can appear to work while the shipped pack behaves differently:');
    for (const p of dirty) {
      console.log(`  ${p.name} (${p.modified.length} file(s)): ${p.modified.slice(0, 3).map((s) => s.replace(/^\S+\s+/, '')).join(', ')}${p.modified.length > 3 ? ', …' : ''}`);
    }
    console.log('  Commit and push anything that needs to reach users, then re-run.');
  }
  if (behind.length) {
    console.log(`\nNOTE: ${behind.length} pack(s) are pinned behind their remote branch` +
      ' (fine if deliberate):');
    for (const p of behind) console.log(`  ${p.name} — ${p.behind} commit(s) behind origin`);
  }
}

if (gateMissing.length) {
  console.log(`\n${'!'.repeat(72)}`);
  console.log(`INCOMPLETE REFERENCE ENV: ${gateMissing.length} module(s) in manifest.verifyImports`);
  console.log(`cannot be imported from ${rel(PY)}:`);
  for (const m of gateMissing) console.log(`  ${m}`);
  console.log('');
  console.log('The installer fails the install when these are missing, so the lock just');
  console.log('written CANNOT produce a working install. Either:');
  console.log('  - install them into the reference env and re-run this script, or');
  console.log('  - move them to optionalImports if the bundled workflows do not need them.');
  console.log('!'.repeat(72));
  process.exitCode = 1;
}
if (hostWheels.length) {
  const files = [...new Set(hostWheels.map((w) => w.file))].sort();
  const builtFiles = new Set(hostWheels.filter((w) => w.built).map((w) => w.file));
  console.log(`\n${'='.repeat(72)}`);
  console.log(`ACTION REQUIRED: ${files.length} hand-built wheel(s) have no upstream download.`);
  console.log(`Publish these (e.g. as GitHub release assets) and set "wheelHost" in`);
  console.log(`setup/comfyui.json to the base URL that serves them:`);
  for (const f of files) {
    // A "build me" entry has no wheel on the reference machine either — it was
    // `pip install .`d from source, so the wheel has to be produced first.
    console.log(`  ${f}${builtFiles.has(f) ? '   <- BUILD FIRST: pip wheel <source dir> (compiled from source here)' : ''}`);
  }
  if (!manifest.wheelHost) console.log(`\n  wheelHost is currently EMPTY — the installer will refuse to run.`);
  else console.log(`\n  wheelHost = ${manifest.wheelHost}`);
  console.log('='.repeat(72));
}
if (os.platform() !== 'win32') {
  console.log('\nNote: run this on each platform you ship (the lock is platform-specific).');
}
