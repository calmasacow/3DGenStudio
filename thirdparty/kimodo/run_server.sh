#!/usr/bin/env bash
# Start the 3D Gen Studio motion-generation micro-service (motion_server.py).
#
# Linux/macOS counterpart of run_server.bat -- see that file's header for what
# each step does and which env vars are honoured. Notably:
#   KIMODO_LLAMA_BASE=NousResearch/Meta-Llama-3-8B-Instruct
#       ungated mirror of the gated Llama-3 base weights the text encoder needs
set -euo pipefail
cd "$(dirname "$0")"
PYVER=3.13

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then UV=uv; return; fi
  if [ -x "$HOME/.local/bin/uv" ]; then UV="$HOME/.local/bin/uv"; return; fi
  echo "Installing uv (Python toolchain manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
}

setup() {
  echo "Provisioning Python $PYVER via uv..."
  "$UV" python install "$PYVER"

  echo "Creating virtual environment (Python $PYVER)..."
  "$UV" venv .venv --python "$PYVER"
  # shellcheck disable=SC1091
  source .venv/bin/activate

  echo
  echo "Installing Kimodo service requirements..."
  "$UV" pip install -r requirements.txt

  # torch after requirements so nothing in that list drags it off-version.
  #
  # --reinstall-package torch is REQUIRED, not defensive. requirements.txt pulls
  # peft/accelerate, which depend on torch, so a CPU torch from PyPI is already
  # installed by now -- and the CUDA build carries the SAME version number with a
  # +cuXXX local tag, so uv considers the requirement satisfied, prints
  # "Audited 1 package" and installs nothing. The service then silently starts on
  # the CPU.
  echo
  echo "Detecting CUDA to select a torch build..."
  TORCHARGS="$(python select_torch.py || true)"
  if [ -n "$TORCHARGS" ]; then
    echo "Installing torch: $TORCHARGS"
    # shellcheck disable=SC2086
    "$UV" pip install --reinstall-package torch $TORCHARGS
  else
    echo "[warn] No NVIDIA GPU detected -- installing CPU torch."
    echo "       Kimodo will be extremely slow without a CUDA GPU."
    "$UV" pip install torch
  fi

  # Fail loudly rather than starting a CPU service that looks like it works.
  if ! python -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then
    echo
    echo "[warn] torch cannot see a CUDA GPU. Generation will run on the CPU and be"
    echo "       very slow. Check 'nvidia-smi', then reinstall torch with:"
    echo "         uv pip install --reinstall-package torch $TORCHARGS"
  fi

  echo
  echo "Installing the vendored Kimodo package..."
  SKIP_MOTION_CORRECTION_IN_SETUP=1 "$UV" pip install --no-deps -e .

  echo
  echo "Building MotionCorrection (foot-skate cleanup; optional)..."
  if ! "$UV" pip install --no-deps ./MotionCorrection; then
    echo "[warn] MotionCorrection did not build -- needs CMake + a C++17 compiler"
    echo "       (build-essential + cmake)."
    echo "       The service still works; foot-skate post-processing is disabled."
  fi

  echo
  if [ -n "${KIMODO_SKIP_MODEL:-}" ]; then
    echo "KIMODO_SKIP_MODEL set -- skipping checkpoint download."
  else
    echo "Downloading the Kimodo checkpoint (1.1 GB; first run only)..."
    python download.py --model || echo '[warn] checkpoint download failed; run "python download.py --model" manually.'
  fi

  echo
  if [ -n "${KIMODO_SKIP_ENCODER:-}" ]; then
    echo "KIMODO_SKIP_ENCODER set -- skipping text-encoder download."
    echo "  It will be fetched on the first generation instead (~16 GB)."
  else
    echo "Downloading the text encoder (~16 GB; first run only, resumable)..."
    python download.py --text-encoder || echo "[warn] text-encoder download failed; it will retry on first use."
  fi

  echo
  echo "Setup complete."
}

ensure_uv
if [ ! -x ".venv/bin/python" ]; then
  setup
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

python motion_server.py
