# Managed ComfyUI (desktop app)

The desktop app can install and run its **own** ComfyUI, so a new user doesn't
have to set one up by hand. It becomes a third Python service alongside Mesh
Tools and Rigging: its own uv-provisioned venv in the per-user data dir, started
on demand, stoppable from Settings.

Users who already run their own ComfyUI are unaffected — the managed install is
opt-in and only writes `apis.comfyui.*` when they choose it.

---

## Layout

Everything lives under the per-user data dir (`app.getPath('userData')`, or
`GENSTUDIO_DATA_ROOT`), because the installed app folder is read-only on
macOS/Linux and under `C:\Program Files` on Windows.

| Path | Contents |
| :--- | :--- |
| `<data>/comfyui/` | ComfyUI code + `custom_nodes/` (replaceable) |
| `<data>/comfy-venv/` | The Python environment |
| `<data>/comfy-data/` | `models/`, `input/`, `output/`, `user/` — ComfyUI's `--base-directory` |
| `<data>/logs/comfyui.log` | Service output |

Code and data are deliberately separate: reinstalling or upgrading ComfyUI never
touches the multi-GB model downloads.

On a successful install the app sets:

```
apis.comfyui.managed    = true          <- "this install is ours to start/stop"
apis.comfyui.path       = <data>/comfyui
apis.comfyui.modelsPath = <data>/comfy-data/models
apis.comfyui.port       = first free port from 8188
```

`managed` is what distinguishes it from a user-supplied ComfyUI. The port is
picked at install time so it never collides with a ComfyUI the user already runs.

Models are **not** installed here — the existing in-app Setup Wizard downloads
them, and it reads `path`/`modelsPath`, so it targets this install automatically.

---

## Why a lock file, not per-pack `requirements.txt`

A working ComfyUI is a specific ~355-package resolution plus a handful of
hand-built CUDA wheels. Resolving each node pack's `requirements.txt` on the
user's machine drifts — numpy 2 vs 1.26, transformers majors, torch ABI — and is
the single most common way a ComfyUI install ends up subtly broken.

So the app ships a **lock generated from a known-good environment** and installs
it as one atomic resolution:

```
setup/comfyui.json                            manifest: ComfyUI pin, node packs, builds
setup/comfyui-lock-windows-py313-cu130.txt    the resolved dependency set
```

`torch` is excluded from the lock and installed first from its own CUDA index —
the lock carries no index-url context, and every prebuilt wheel in it is
ABI-matched to exactly that torch version.

## No git, no compiler

- Node packs download as **pinned GitHub tarballs** (`/archive/<sha>.tar.gz`),
  extracted by a small pure-Node ustar walk in `electron/comfysetup.cjs`. No git
  binary, no zip library, no platform-specific `tar`.
- `git+https://…@<sha>` dependencies in the lock are rewritten to the equivalent
  tarball URL for the same reason.
- Every binary dependency is a prebuilt wheel, from one of two places:
  - **inside a node repo** (`ComfyUI-Trellis2/wheels/**`) — the download brings
    it along, nothing to host;
  - **`wheelHost`** — hand-built wheels with no upstream home.

> [!IMPORTANT]
> Because node packs are tarballs rather than git checkouts, ComfyUI-Manager
> cannot update them in place. Upgrades happen by regenerating the manifest and
> shipping a new app version — which the user then applies from **Settings →
> ComfyUI → Update ComfyUI**. See [Updating an existing install](#updating-an-existing-install).

---

## The reference environment

The artifacts are generated from a real, working ComfyUI install. The repo's own
reference env lives at `comfyui/` (gitignored — it's multi-GB code + venv +
models, and only `setup/comfyui.json` and the lock get committed):

```
comfyui/                ComfyUI v0.29.0
comfyui/venv/           Python 3.13 · torch 2.10.0+cu130
comfyui/custom_nodes/   exactly the 11 shipped packs
```

Keeping the reference env minimal matters: the lock is a freeze of whatever is
installed there, so extra packs mean extra install weight for every user. This env
yields **230 packages**; one with 28 packs installed yielded 355.

## Which node packs ship

Only the packs the bundled workflows actually need — **11**:

| Pack | Nodes used |
| :--- | :--- |
| ComfyUI-Trellis2 | 21 |
| ComfyUI-Hunyuan3DWrapper | 6 |
| ComfyUI-Hunyuan3d-2-1 | 5 |
| ComfyUI_essentials | 4 |
| ComfyUI-KJNodes | 3 |
| ComfyUI-QwenVL | 2 |
| comfyui-flux2fun-controlnet | 2 |
| comfyui_controlnet_aux | 1 |
| ComfyUI-RMBG | 1 |
| ComfyUI-GGUF | 1 |
| rgthree-comfy | Display Any, Image Comparer |

The rest are listed in `excludeNodes` and not shipped. Pruning them is also what
makes the `open3d` / `torch_scatter` / `torch_cluster` exclusions safe: LATO.2 and
ComfyUI-Tools import those at module level, so shipping them without the wheels
would log pack-load errors on every startup.

`ComfyUI-Manager` is excluded deliberately. It can't manage tarball-pinned packs
properly, and an "update all" would silently break the locked environment the
whole design depends on. Add it back to `customNodes` if you decide the
node-browsing UI is worth that risk.

### What `ref` means

Each entry's `ref` is an exact commit SHA, and the installer downloads
`github.com/<repo>/archive/<ref>.tar.gz`. It is a **hard pin**: pushing to a
pack's default branch changes nothing for users until `ref` is updated here. That
is the point — it's what makes installs reproducible — but it has three
consequences worth internalising:

- Updating a pack means bumping `ref`, not just pushing.
- **Uncommitted work in the reference checkout never ships.** The tarball contains
  the commit, not your working tree, so the reference env can run a workflow
  perfectly while users get a pack missing that code.
- A `ref` that isn't on a remote branch makes the archive URL 404 for every user.

The generator checks the last two and reports them (`UNPUSHED COMMITS` is fatal,
locally-modified tracked files are a warning). Since it derives `ref` from each
checkout's `HEAD`, hand-editing a `ref` here is undone by the next run — move the
checkout to the commit you want pinned instead.

> [!CAUTION]
> When adding a bundled workflow that uses a new pack, add the pack to
> `customNodes` (or remove it from `excludeNodes`) by hand. The generator does
> **not** infer this from the workflows — a heuristic mapper would eventually drop
> a pack that IS needed, which fails much worse than shipping one too many. Note
> that `ComfyUI_essentials`, `rgthree-comfy` and the SAM3 packs register their
> nodes indirectly, so a naive grep for a class name gives false negatives; and
> `SAM3_Detect`, `TextEncodeBooguEdit`, `ImageScaleToMaxDimension` and `Preview3D`
> are ComfyUI **core**, not custom packs.

### Keep the reference env in sync

`excludeNodes` only stops a pack being *shipped*; it does not stop its
dependencies leaking into the lock, because the lock is a freeze of whatever is
installed in the reference env. So when you drop a pack from `customNodes`, also
uninstall it from `comfyui/custom_nodes/` (and rebuild the venv if its deps are
heavy) before regenerating.

## Regenerating after a ComfyUI or node upgrade

Run this against a reference env where ComfyUI **and all the packs the bundled
workflows need** actually work:

```bash
node tools/gen-comfy-lock.mjs \
  --comfy ./comfyui \
  --venv  ./comfyui/venv \
  --cuda  13.0
```

The script exits non-zero and prints an `INCOMPLETE REFERENCE ENV` banner if any
`verifyImports` module can't be imported there — that means the lock it just wrote
cannot produce a working install, so fix the env (or reclassify the module) and
re-run. Don't commit a lock that produced that banner.

It rewrites `setup/comfyui.json` and the matching lock, and preserves the
hand-maintained fields (`wheelHost`, `launchArgs`, `verifyImports`). The lock is
platform-specific, so run it once per platform you ship; each run merges its
build into the manifest rather than replacing the others.

> [!WARNING]
> **Only `builds[]` is per-platform.** `comfyui.repo`, `comfyui.ref`,
> `pythonVersion` and the entire `customNodes` array are GLOBAL, and every run
> overwrites them from whatever the machine it ran on happens to have checked out.
> So a generator run on platform B silently re-pins the code that platform A's lock
> was frozen against — and a pack missing from B's `custom_nodes` is dropped from
> the manifest entirely, breaking A.
>
> Before regenerating on a second platform, make its reference env match the
> committed pins (or accept that the other platform's lock now needs regenerating
> too). Diff `customNodes` and `comfyui.ref` against `git diff setup/comfyui.json`
> afterwards — the change is easy to miss because the lock itself looks fine.

The script reports three things you should read every time:

- **git dependencies rewritten to tarballs** — informational.
- **`custom_nodes` folders that are not GitHub checkouts** — these are SKIPPED.
  They can't be reproduced on a user's machine.
- **hand-built wheels with no upstream download** — see below.

### Hosted wheels

> [!NOTE]
> The current Windows build needs **none** — `hostedWheels` is empty and
> `wheelHost` is unset. This section applies only if a future build reintroduces a
> package with no installable upstream wheel.

Some CUDA extensions have no installable upstream build for the pinned
Python/torch combination. The generator lists them and the installer refuses to
start until they're reachable, so a missing wheel fails in seconds rather than 20
minutes into a torch download.

1. Publish the wheels somewhere with stable URLs (GitHub release assets work).
2. Set `wheelHost` in `setup/comfyui.json` to the base URL serving them.

Entries marked `BUILD FIRST` were compiled from source in the reference
environment (`pip install .`), so no wheel exists yet — build one with
`pip wheel <source dir>` and publish it under the exact filename the generator
printed. Before doing that, check whether the package is actually needed: several
CUDA extensions are imported lazily or inside `try/except`, and belong in
`optionalImports` / `excludePackages` instead (see below).

### Required vs optional modules

The installer's final step imports two lists from the manifest:

| Field | On failure | For |
| :--- | :--- | :--- |
| `verifyImports` | **fails the install** | wheels the bundled workflows genuinely need |
| `optionalImports` | logged as `optional`, install proceeds | capabilities that degrade rather than break |

A third field, `excludePackages`, drops a package from the generated lock
entirely. Use it for something optional that has no publishable wheel — otherwise
every install would depend on hosting a wheel nothing needs.

Currently classified optional, with the evidence:

| Package | Why it's optional |
| :--- | :--- |
| `natten` | Only the `TencentARC/Pixal3D-T` model needs it. Nothing in ComfyUI-Trellis2 imports it; `transformers` declares it as an *extra*, not a dependency. No bundled workflow uses that model. Kept in the Windows lock because the wheel ships inside the Trellis2 repo and costs nothing. |
| `custom_rasterizer` | In-function import (`mesh_render.py:161`, Hy 2.1 `MeshRender.py:373`) on the Hunyuan **texture-paint** path. The bundled Hunyuan workflows are "Gen Mesh Only" and never reach it; the node packs load fine without it. |
| `mesh_inpaint_processor` | Wrapped in `try/except` (Hy 2.1 `MeshRender.py:36`). |
| `udf_ext` | Nothing in the tree imports it by name. |
| `open3d` | **Cannot be installed at all on Python 3.13** — the newest release (0.19.0) publishes cp38–cp312 wheels only, on every platform. Excluded rather than merely optional. In ComfyUI-Trellis2 only `Trellis2PostProcessMesh` and `Trellis2LaplacianSmoothingWithOpen3d` use it, both in-function, and no bundled workflow uses either node. Every other importer belongs to a pack we don't ship. |
| `torch_cluster` | Top-level import only in ComfyUI-Tools (`unirig`), a pack no bundled workflow needs. In the Hunyuan packs it's an in-function import in the point-cloud FPS encoder, which the image→mesh workflows don't reach. |
| `torch_scatter` | Top-level import only in ComfyUI-LATO.2 and ComfyUI-Tools — neither needed by a bundled workflow. |

| `diso` | Only the `dmc` surface-extraction path uses it (`DMCSurfaceExtractor.run` → `from diso import DiffDMC`, lazy). The bundled Hunyuan workflows set `mc_algo: "mc"`, which routes to `MCSurfaceExtractor` → `skimage.measure.marching_cubes` (scikit-image is in the lock). Switch a workflow back to `"dmc"` and you must ship a `diso` wheel again. |

Dropped entirely (not even probed — nothing in the tree references them):
`autoretopo`, `drtk`.

**Net result: neither shipped build needs hosted wheels at all.** `wheelHost` can
stay empty; every binary dependency either comes from PyPI, from the CUDA torch
index, from inside the ComfyUI-Trellis2 repo, or from the flash-attn table.

> [!TIP]
> If a regeneration reports `ACTION REQUIRED` for wheels you know live inside
> `custom_nodes/`, suspect the `file://` decoding before you start publishing
> anything. Windows and Linux disagree about the third slash — `file:///C:/x` drops
> it, `file:///home/x` must keep it — and dropping it on Linux yields a relative
> path that no longer looks like it's under `custom_nodes`, so every node-local
> wheel gets misrouted to `${WHEEL_HOST}`.

### flash-attn comes from the shared wheel table

flash-attn is **not** in the lock and needs no hosting. It's selected at install
time from the same curated tables the rigging service uses:

```
thirdparty/skintokens/flash_attention_windows.txt
thirdparty/skintokens/flash_attention_linux.txt
```

One table to maintain for both services, and those wheels are already hosted.
The match is on **torch version AND CUDA**, not CUDA alone — the wheel is
ABI-bound to a specific torch, and this build's torch is fixed by the prebuilt
CUDA wheels in the lock. A CUDA-only match could return a wheel for a different
torch that installs cleanly and dies at `import`.

The wheel is downloaded to disk first and then installed from the local file:
pip/uv cannot resolve Hugging Face Xet URLs (they 403), but a plain
redirect-following GET fetches them fine.

> [!IMPORTANT]
> If a build's torch version has no row in the table, the install fails with a
> message naming the version and what the table does offer. The Linux build (torch
> 2.11.0) needed a row added for exactly this reason; see Platform support below.

> [!NOTE]
> Hunyuan3DWrapper's own `mesh_processor` needs no wheel either: it ships a pure
> Python `mesh_processor.py` beside a cp312 `.pyd`, and on cp313 the `.pyd`'s ABI
> tag doesn't match, so Python loads the `.py`.

### Validating that the packs still load

The strongest check available offline: start ComfyUI with `--quick-test-for-ci`
(loads every node, then exits) and confirm each node class the bundled workflows
use is registered. To prove a package really is unnecessary, shadow it with a stub
that raises `ImportError` and re-run — that simulates a user's machine where it was
never installed.

```bash
# a stub dir that makes `import open3d` fail, plus a hook that dumps the registry
mkdir -p stub/open3d
echo 'raise ImportError("simulated absence")' > stub/open3d/__init__.py
cat > stub/sitecustomize.py <<'EOF'
import atexit, os
def dump():
    import nodes
    open(os.environ['NODE_DUMP'], 'w', encoding='utf-8').write('\n'.join(sorted(nodes.NODE_CLASS_MAPPINGS)))
atexit.register(dump)
EOF

cd comfyui
PYTHONPATH=../stub NODE_DUMP=../registered.txt PYTHONIOENCODING=utf-8 \
  ./venv/Scripts/python.exe main.py --quick-test-for-ci --cpu
# then diff the workflow node classes against registered.txt
```

Verified this way with **both `open3d` and `diso` absent**: all 11 packs load and
every workflow node class registers (0 missing of 95). `PYTHONIOENCODING=utf-8`
matters — without it ComfyUI's logger crashes on non-ASCII output under some
consoles and the run exits 1 for reasons unrelated to node loading.

> [!NOTE]
> Don't check the registry by calling `nodes.init_extra_nodes()` from your own
> script. rgthree-comfy needs `PromptServer.instance`, which only exists once
> main.py has created the server, so it silently fails to register and you get
> false "missing node" results.

**One known pre-existing gap:** `AILab_QwenVL_GGUF_PromptEnhancer` fails to load
(`No module named 'llama_cpp'`). No bundled workflow uses it, and the rest of
ComfyUI-QwenVL loads fine, so it's left alone — add `llama-cpp-python` to the
reference env if you ever ship a workflow using that node.

### Validating a regenerated lock without a full install

`materializeLock` and `verifyHostedWheels` are exported for this:

```js
const cs = require('./electron/comfysetup.cjs');
const m = cs.loadManifest('.');
m.wheelHost = 'file:///C:/Git/ComfyUI';        // stand-in for a real host
const build = cs.pickBuild(m);
const lock = cs.materializeLock({ appRoot: '.', build, manifest: m,
  installDir: 'C:/Git/ComfyUI', venvDir: process.env.TEMP });
// then: uv pip install --python <throwaway venv> --dry-run -r <lock>
```

---

## Install sequence

`electron/comfysetup.cjs` → `setupComfyUI()`:

1. Pick the build row matching this platform and the driver's CUDA (newest build
   the driver can run — same rule as the rigging wheel table).
2. **Verify every hosted wheel is reachable** (HEAD requests) — before any large download.
3. `uv python install <pythonVersion>` → `uv venv`.
4. Download ComfyUI, then each pinned node pack. Node packs come first because
   the lock references wheels that live inside them.
5. Install torch from its CUDA index.
6. Install the materialized lock **with `--no-deps`**. The lock is a complete
   freeze of the reference env, so there is nothing left to resolve — and
   resolving anyway pulls in packages the lock deliberately excludes (see the
   opencv gotcha below).
7. **Normalise opencv** (`enforceSingleOpenCV`) — exactly one opencv
   distribution, and `cv2.ximgproc.guidedFilter` proven importable.
8. **Import-check** `verifyImports`. A wheel built against a different torch ABI
   installs cleanly and only fails at `import` with `undefined symbol: …`;
   catching it here beats a mystery node-import failure later.
9. Create the data folders, write the readiness marker, write the settings.

## Updating an existing install

**Installing a newer app version does not touch a managed ComfyUI.** The installer
short-circuits on the readiness marker, and `isReady()` only compares
`COMFY_SETUP_TAG` — so a bumped `comfyui.ref`, a bumped node pack `ref` or a
regenerated lock all leave the marker perfectly valid. And because the packs are
tarballs, there is no `git pull` that would notice either. Without a deliberate
update path, a user who upgrades the app keeps running the ComfyUI, node packs and
Python packages of whatever version first installed it.

So the app records what it installed and offers an explicit update:

```
<data>/comfy-venv/comfy-install.json     the install state
```

| Field | Used to detect |
| :--- | :--- |
| `comfyui.ref` | a ComfyUI upgrade |
| `customNodes[].ref` | packs to update, add or remove |
| `lockSha` | a regenerated lock — the **filename** is unchanged whenever Python and CUDA are, so the hash is what actually decides |
| `build.torchArgs` | a torch/CUDA change (which also forces a new flash-attn wheel) |
| `pythonVersion` | an interpreter bump — see below |

`planComfyUpdate()` diffs the shipped manifest against that record and returns
exactly what would change; `updateComfyUI()` applies it. The split is what lets
Settings check on open (one metadata query, **no network**) and show the work
before the user agrees to it.

### What an update does

1. **ComfyUI itself**, if `ref` changed: wipe the install dir *except*
   `custom_nodes`, then extract the new tarball. Wiping is what removes files the
   new version deleted; keeping `custom_nodes` is what stops a ComfyUI bump from
   re-downloading every pack.
2. **Node packs**: extract the changed/new ones (each replaced wholesale), delete
   the ones no longer shipped.
3. **torch / flash-attn**, only if the build row changed.
4. **The lock**, with `--no-deps` as always, plus a `--force-reinstall` of the
   wheels that ship *inside* an updated pack — those are pinned by path and their
   version usually doesn't change, so a plain install considers them satisfied and
   leaves the old binary beside the new Python code.
5. **Uninstall orphans**: installed distributions the new lock doesn't list. This
   is the other half of "up to date" — dropping a node pack leaves its dependencies
   behind, and a lock regenerated from a leaner reference env can shed a hundred of
   them.
6. `enforceSingleOpenCV` + the import gate + the triton probe, same as a fresh
   install, then rewrite the marker and the state.

The service is stopped first (`comfyui:update-run`), and `ensureService('comfyui')`
is refused for the duration — an update deletes files a running ComfyUI has open,
and Windows will not unlink a loaded `.pyd` at all.

> [!CAUTION]
> Orphan removal is guarded by a keep-list, and getting it wrong would break the
> environment silently. `torch`/`torchvision`/`torchaudio`/`flash-attn` are
> installed *outside* the lock by design; `pip`/`setuptools`/`wheel`/`uv` would take
> the venv with them; and everything in `excludePackages` is a deliberate omission
> rather than a leftover (`cv2` in particular is repaired by `enforceSingleOpenCV`,
> which knows how to do it safely). Names are compared PEP 503-normalised.
> Verified against a real managed install: zero orphans reported when the venv
> matches the shipped lock.

### Things that can't be done incrementally

- **A `pythonVersion` bump.** Every wheel in the lock is tagged for one
  interpreter, so a cp313 venv cannot host a cp314 lock. The plan reports
  `requiresReinstall` with the reason and Settings offers a **Reinstall** instead,
  which wipes `comfy-venv/` and `comfyui/` — never `comfy-data/`, so models,
  inputs, outputs and the ComfyUI database survive.
- **An install made before this feature existed** has no state file, so its refs
  are unknowable and the first update refreshes ComfyUI and all packs once. The UI
  says so, rather than presenting an 11-pack download as routine.

### codeload rate-limits, so downloads retry — and never destroy first

A managed install asks `codeload.github.com` for ComfyUI plus 11 node packs back to
back, unauthenticated, and **it rate-limits that with HTTP 429** — per IP, so a
second install or update on the same day can be limited from its very first
request. Two rules follow, and the first update shipped without either:

- **Every download retries with backoff** (`withRetry`): 5s → 15s → 30s → 60s →
  120s → 180s, honouring `Retry-After` when the server sends one. `429`, `5xx` and
  dropped connections are retried; `404` and a plain `403` are not (a private or
  renamed repo is permanent, and six minutes of retries won't fix it) — a `403` only
  counts as a rate limit when it carries `Retry-After` or
  `x-ratelimit-remaining: 0`. The waits are reported through the **phase** label,
  not just the log, because the Settings progress bar shows only the phase and a
  silent three-minute wait reads as a hang.
- **Fetch before you destroy.** `replaceComfyCore` and `extractNodePack` download and
  gunzip the archive *first*, then delete, then extract. The first version wiped the
  install dir and *then* fetched — so a 429 on that very request deleted a working
  ComfyUI's `main.py` and left the user with an install that reported itself
  uninstalled. `fetchArchive` and `extractTar` are separate for exactly this reason;
  `extractTarGz` is now just the two composed.

The retry wrapper covers the **body read** as well as the request, since a
connection dropped mid-download used to surface as a corrupt archive. `downloadFile`
(the flash-attn wheel) streams to a `.part` file and renames on success, so a retry
never appends to a partial file or mistakes one for a finished download.

### Safety rules worth keeping

- Only packs the state recorded, or ones listed in `excludeNodes`, are ever
  deleted. A folder the user dropped into `custom_nodes` themselves is reported and
  left alone.
- The readiness marker stays valid throughout an update. Every step is idempotent
  and the plan is rebuilt from what's actually on disk, so a failed update is
  repaired by running it again — invalidating the marker would instead demote a
  working install to "not installed" over a dropped connection.
- If an update dies *after* the ComfyUI tree is wiped, `main.py` is missing, so
  `comfyReady()` goes false and Settings falls back to offering a full install.
  That's the intended recovery.

## Platform support

| Platform | Status |
| :--- | :--- |
| Windows x64 | Build shipped (Python 3.13, torch 2.10.0+cu130) |
| Linux x64 | Build shipped (Python 3.13, torch 2.11.0+cu128) — generated on WSL2, not yet validated on bare metal |
| macOS | Not possible (no CUDA) |

The install option is **hidden** on any platform without a shipped build:
`setup:status` reports `comfyuiAvailable`, and both the first-run screen and the
Settings card gate on it. A user on an unsupported platform is told to install
ComfyUI themselves and set the path/port, rather than being offered an install
that fails. Nothing in that gate is hard-coded per platform — it is
`builds.some(b => b.platform === here)`, so a platform switches on the moment its
generator run lands.

### The Linux build

Generated on WSL2 (Ubuntu, driver CUDA 13.3, RTX-class GPU) against a reference
ComfyUI at the same pins the manifest ships. It differs from Windows in three ways
that are all deliberate:

- **torch 2.11.0+cu128, not 2.10.0+cu130.** ComfyUI-Trellis2's Linux cp313 wheels
  are built for torch 2.11 (`wheels/Linux/Torch2110/`), and the lock has to agree
  with the wheels rather than with the other platform.
- **`triton` instead of `triton-windows`.** This matters more than the name
  suggests — see the toolchain note below.
- **`custom_rasterizer` and `natten` are absent.** Both are classified optional, so
  the install still succeeds; nothing needs building for cp313/torch-2.11.

`flash_attention_linux.txt` carries the matching
`2.11.0;12.8.0;…flash_attn-2.8.3+cu128torch2.11-cp313…` row. That table is shared
with the rigging service, so keep existing rows intact when adding to it.

#### Linux needs a C toolchain at *generation* time, not just install time

`triton-windows` ships a prebuilt driver shim; plain `triton` does not. On Linux it
compiles `cuda_utils.c` with the system compiler **the first time a kernel
launches** — which is during a user's first mesh generation, minutes after the
install reported success. Miss either piece and the failure is far from its cause:

```
/tmp/tmpXXXX/cuda_utils.c:9:10: fatal error: Python.h: No such file or directory
```

...raised from inside a Trellis2 node, after the sparse-structure and SLat sampling
stages have already run. So `setupComfyUI` checks for both **before** any download
(`checkNativeToolchain`, at 10%) and then exercises the real compile path in the
verify phase (`probeTritonCompile`):

- A missing compiler aborts with `sudo apt install build-essential`.
- Missing headers abort with `sudo apt install python3.13-dev`.
- A compile-shaped failure in the probe (`Python.h`, `gcc`, `cc1`, `compil`,
  `CalledProcessError`) fails the install; anything else is logged and allowed
  through, since it may not reproduce at generation time.

In practice the header check should never fire: `uv venv --python 3.13` builds the
venv from uv's managed CPython (python-build-standalone), which carries its own
`include/python3.13/Python.h`. The compiler check is the one that earns its keep on
a bare server. Both are no-ops on Windows.

> [!WARNING]
> `probeTritonCompile` reporting `triton compile not exercised: RuntimeError: 0
> active drivers` is not a toolchain problem — triton's NVIDIA backend needs torch
> to register itself, so this means torch was absent or the GPU wasn't visible to
> that process. It never reached the compiler.

## Gotchas found the hard way

**Never pass `--base-directory`.** It relocates `custom_nodes` along with
everything else, and `main.py`'s `execute_prestartup_script()` then does
`os.listdir(<base>/custom_nodes)` and dies with `FileNotFoundError` before the
server binds. The node packs live next to the code in `<installDir>/custom_nodes`.
Use the per-directory flags instead (`--models-directory`, `--input-directory`,
`--output-directory`, `--user-directory`, `--temp-directory`) — each documents
"Overrides --base-directory", so they move exactly what we want. Note
`--user-directory` and `--models-directory` are validated with
`is_valid_directory`, which **rejects a path that doesn't exist**, so the launcher
creates all five before spawning.

**Ship exactly one opencv distribution — and excluding the others from the lock
is not enough.** `opencv-python`, `opencv-contrib-python` and their two
`-headless` variants all unpack into the same `cv2/` package and overwrite each
other, so which build you end up with is decided by install *order*. Only contrib
carries `cv2.ximgproc`, which `ComfyUI-Hunyuan3DWrapper/nodes.py` imports at
module scope, so losing the coin flip means
`cannot import name 'guidedFilter' from 'cv2.ximgproc'` and every Hunyuan3D
workflow reporting missing nodes.

The lock pins only `opencv-contrib-python` (the other three are in
`excludePackages`), but that alone does **not** keep them out: a
dependency-resolving install re-adds them as transitive requirements —
`albucore`/`albumentations` need `opencv-python-headless`,
`groundingdino-py`/`pixeloe`/`supervision`/`transparent-background` need
`opencv-python` — and whichever lands last owns `cv2/`. That's exactly how a fresh
install regressed after the first fix. Two things now prevent it:

- the lock installs with **`--no-deps`** (it is a full freeze, so nothing needs
  resolving), and
- **`enforceSingleOpenCV`** runs right after: it reads the single pin out of the
  lock, uninstalls any other variant present, `--force-reinstall`s the pinned one
  (mandatory — uninstalling a sibling deletes `cv2/` files it *shares* with
  contrib, leaving contrib recorded as installed but gutted), and then fails the
  install unless `from cv2.ximgproc import guidedFilter` actually works.

The distribution list is not sufficient evidence on its own — contrib can be
present per its metadata with a plain build's files on disk — which is why the
check imports the symbol. It also repairs venvs provisioned by an older build of
the app (`COMFY_SETUP_TAG` = `comfyui-2` re-triggers setup for those).

**`--database-url` does not follow `--user-directory`.** `cli_args.py` defaults it
to `<code dir>/../user/comfyui.db`, i.e. `<installDir>/user` — a folder the
managed install never creates, since user data lives in the data dir. Every
startup then logged `Failed to initialize database … unable to open database
file` and ran without one. The launcher passes it explicitly, pointed at
`<dataDir>/user/comfyui.db`.

**Spawn Python services with `PYTHONIOENCODING=utf-8`.** We capture stdout and
stderr through pipes, and for a pipe Python defaults to the ANSI codepage on
Windows (cp1252) rather than utf-8. Several node packs log emoji at import time —
rgthree's `Loaded 48 fantastic nodes. 🎉` — which raises `UnicodeEncodeError`
inside `logging` and **kills ComfyUI with exit code 1** partway through loading.
It presents as a mystery startup crash, and it does not reproduce in a terminal
(where stdout is a console, so Python picks utf-8). Both launchers now set
`PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`.

**A crash used to look like a hang, then like a healthy service.** `ensureService`
now races the health poll against the process exiting, so a service that dies on
startup reports its exit code and the last lines of its output immediately instead
of after the full 180-second health timeout. It also clears the handle when the
process exits — `serviceStatus()` reports `running` from the handle's existence, so
a dead service used to keep showing "Running" in Settings.

## Requirements and limits

- **NVIDIA GPU required.** macOS is refused outright (no CUDA) — point Settings →
  ComfyUI at an instance on another machine instead.
- The driver must support the CUDA version of at least one build in the manifest.
- Health probe is `/system_stats` (ComfyUI has no `/health`), wired through the
  registry's per-service `healthPath`.
- Override CUDA detection for testing with `GENSTUDIO_COMFY_CUDA=12.8`.
