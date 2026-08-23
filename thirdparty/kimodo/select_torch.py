"""Print the pip args for a CUDA-matched torch install, for run_server.

Mirrors python-server/detect_cuda.py: reads the CUDA version from nvidia-smi and
maps it to a PyTorch wheel index. Prints one line to stdout for the caller to
pass straight to `uv pip install`; diagnostics go to stderr. Prints nothing when
no NVIDIA GPU is present -- Kimodo needs one, so the caller should treat empty
output as "install CPU torch and warn".

Override with KIMODO_CUDA (e.g. `set KIMODO_CUDA=12.8`).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys

# One index per CUDA line PyTorch publishes wheels for.
_INDEXES = {
    12: "https://download.pytorch.org/whl/cu128",
    13: "https://download.pytorch.org/whl/cu130",
}


def cuda_major() -> int | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return None
    m = re.search(r"CUDA(?:\s+\w+)?\s+Version:\s*(\d+)\.(\d+)", out)
    return int(m.group(1)) if m else None


def main() -> None:
    override = os.environ.get("KIMODO_CUDA")
    major = int(float(override)) if override else cuda_major()
    if major is None:
        print("[select_torch] No NVIDIA GPU detected.", file=sys.stderr)
        return
    known = sorted(_INDEXES)
    if major > known[-1]:
        print(f"[select_torch] CUDA {major}.x newer than known wheels; using cu{known[-1]}0.", file=sys.stderr)
        major = known[-1]
    elif major < known[0]:
        print(f"[select_torch] CUDA {major}.x older than supported wheels; trying cu128.", file=sys.stderr)
        major = known[0]
    print(f"torch --index-url {_INDEXES[major]}")


if __name__ == "__main__":
    main()
