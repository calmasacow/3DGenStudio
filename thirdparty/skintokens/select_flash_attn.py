"""Pick the prebuilt flash-attn wheel + matching torch install for this machine.

Building flash-attn from source takes ~an hour on BOTH Windows and Linux, so we
always prefer a precompiled wheel. There is one curated table per platform —
``flash_attention_windows.txt`` (win_amd64 wheels) and
``flash_attention_linux.txt`` (linux_x86_64 wheels) — and this script picks the
table matching the host. Each lists, per row:

    Torch;Cuda;Link;PyTorchLink
    │     │    │     └ the exact `pip install torch... [--index-url ...]` command
    │     │    │        that pairs with this flash-attn wheel (ABI-matched)
    │     │    └ flash-attn wheel URL
    │     └ CUDA build the wheel targets (match key against the driver;
    │        "13.0" and "13.0.0" both work — only major.minor is compared)
    └ torch version (informational; also encoded in the wheel + PyTorchLink)

Python is pinned to 3.13 by uv (see .python-version) so it is no longer a match
key — every wheel in both tables is cp313. We just pick the newest CUDA build
the driver can run and hand the caller both pieces to install.

On a match it prints two `KEY=value` lines to stdout:

    WHEEL=https://.../flash_attn-...cp313-win_amd64.whl
    TORCHARGS=torch==2.12.0 torchvision==0.27.0 --index-url https://download.pytorch.org/whl/cu130

(``TORCHARGS`` is column 4 with the leading ``pip install`` / ``pip3 install``
stripped, so the caller can run it with ``uv pip install``.) On no match — no
NVIDIA driver, an unsupported platform/arch, or a driver older than every listed
CUDA build — it prints nothing and exits 0; the caller decides what that means.
Diagnostics go to stderr. Standard library + nvidia-smi only.

macOS has no CUDA, so rigging is unavailable there and this prints nothing.

Override CUDA detection with RIGTOOLS_CUDA (e.g. "12.8").
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
# Wheels are platform-tagged: a win_amd64 wheel is rejected outright by pip/uv on
# Linux ("wheel is compatible with Windows, but you're on Linux"), so the table
# MUST follow the host rather than being a single shared list.
WHEELS_FILE = _HERE / ("flash_attention_windows.txt" if sys.platform == "win32"
                       else "flash_attention_linux.txt")


def driver_cuda() -> float | None:
    """Max CUDA version the NVIDIA driver supports (from nvidia-smi), or None."""
    override = os.environ.get("RIGTOOLS_CUDA")
    if override:
        forced = cuda_key(override)
        if forced is not None:
            return forced
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return None
    m = re.search(r"CUDA(?:\s+\w+)?\s+Version:\s*(\d+)\.(\d+)", out)
    return float(f"{m.group(1)}.{m.group(2)}") if m else None


def cuda_key(text: str) -> float | None:
    """Normalise a CUDA column to a comparable major.minor float.

    Accepts "13", "13.0" and "13.0.0" — the Linux table quotes three-part CUDA
    versions, and a bare float() on those raises, which would silently drop the
    row and look identical to "no GPU".
    """
    m = re.match(r"\s*(\d+)(?:\.(\d+))?", text)
    return float(f"{m.group(1)}.{m.group(2) or 0}") if m else None


def parse_rows():
    """Yield (torch_ver, cuda: float, wheel_url, torch_args) from the wheels file."""
    rows = []
    for line in WHEELS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.lower().startswith("torch;"):
            continue
        parts = [p.strip() for p in line.split(";")]
        if len(parts) < 4:
            continue
        torch_ver, cuda, link, pytorch_cmd = parts[0], parts[1], parts[2], parts[3]
        cuda_f = cuda_key(cuda)
        if cuda_f is None:
            continue
        # Strip the leading "pip install" / "pip3 install" (or the "uv "-prefixed
        # forms) so the caller can run it via `uv pip install <args>`.
        args = re.sub(r"^\s*(uv\s+)?pip3?\s+install\s+", "", pytorch_cmd).strip()
        rows.append((torch_ver, cuda_f, link, args))
    return rows


def main() -> None:
    py = f"{sys.version_info.major}.{sys.version_info.minor}"

    # Platform/arch gates first: both tables ship x86_64 wheels for a CUDA GPU, so
    # anywhere else there is nothing to pick and saying so beats letting the caller
    # download multi-GB of torch on the way to an unavoidable failure.
    if sys.platform == "darwin":
        print("[flash-attn] macOS has no CUDA; rigging is unavailable here.", file=sys.stderr)
        return
    if sys.platform not in ("win32", "linux"):
        print(f"[flash-attn] Unsupported platform {sys.platform!r}; no prebuilt wheels listed.", file=sys.stderr)
        return
    arch = platform.machine().lower()
    if arch not in ("x86_64", "amd64"):
        print(f"[flash-attn] Unsupported CPU architecture {arch!r} — the listed wheels are "
              f"x86_64 only.", file=sys.stderr)
        return
    if not WHEELS_FILE.exists():
        print(f"[flash-attn] Missing wheel table {WHEELS_FILE.name}.", file=sys.stderr)
        return

    cuda = driver_cuda()
    if cuda is None:
        print("[flash-attn] No NVIDIA GPU / CUDA detected; skipping prebuilt wheel.", file=sys.stderr)
        return

    rows = parse_rows()
    if not rows:
        print(f"[flash-attn] No usable rows in {WHEELS_FILE.name}.", file=sys.stderr)
        return

    # Rows whose CUDA build the driver can run (wheel_cuda <= driver_cuda),
    # taking the newest such CUDA build.
    candidates = [r for r in rows if r[1] <= cuda + 1e-6]
    if not candidates:
        avail = sorted({r[1] for r in rows})
        print(f"[flash-attn] Driver CUDA {cuda} is older than every listed wheel "
              f"(CUDA builds available: {avail}); skipping prebuilt wheel.", file=sys.stderr)
        return

    torch_ver, wheel_cuda, link, torch_args = max(candidates, key=lambda r: r[1])
    if py != "3.13":
        print(f"[flash-attn] WARNING: running Python {py}, but the wheels are cp313. "
              f"Expect an install failure unless the venv is Python 3.13.", file=sys.stderr)
    print(f"[flash-attn] {WHEELS_FILE.name}: driver CUDA {cuda} -> wheel CUDA {wheel_cuda}, "
          f"torch {torch_ver}.", file=sys.stderr)
    print(f"WHEEL={link}")
    print(f"TORCHARGS={torch_args}")


if __name__ == "__main__":
    main()
