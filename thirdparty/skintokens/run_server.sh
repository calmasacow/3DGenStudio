#!/usr/bin/env bash
# Start the 3D Gen Studio rigging micro-service (rig_server.py) on Linux.
#
# Rigging (SkinTokens/TokenRig) needs an NVIDIA GPU (CUDA), so it runs on Windows
# and Linux only. On macOS this script exits early with a clear message.
#
# On first run it uses `uv` to provision a pinned standalone Python (see
# .python-version -> 3.13) and installs the SkinTokens requirements, torch, a
# flash-attn wheel, and the model checkpoints. Like Windows, Linux installs
# flash-attn from a curated prebuilt wheel (flash_attention_linux.txt) rather than
# `pip install flash-attn`, which compiles from source and takes about an hour.
# uv is auto-installed if absent.
#
# Env overrides:
#   RIGTOOLS_PORT / RIGTOOLS_HOST   bind address
#   RIGTOOLS_CUDA=12.6              force the CUDA build to target (skip nvidia-smi)
#   RIGTOOLS_SKIP_FLASH=1           don't install flash-attn
#   RIGTOOLS_BUILD_FLASH=1          if no curated wheel matches, build from source
#                                   instead of giving up (~1 hour, needs nvcc+ninja)
#   RIGTOOLS_SKIP_MODEL=1           don't download the model checkpoints
set -euo pipefail
cd "$(dirname "$0")"
PYVER=3.13

if [ "$(uname)" = "Darwin" ]; then
  echo "Rigging (SkinTokens) requires an NVIDIA GPU (CUDA), which macOS does not"
  echo "provide. The rigging service is not available on macOS; Auto Rig will be"
  echo "disabled. (The mesh-tools service and the rest of the app still work.)"
  exit 0
fi

# --- Ensure uv is available -------------------------------------------------
if command -v uv >/dev/null 2>&1; then
  UV="uv"
elif [ -x "$HOME/.local/bin/uv" ]; then
  UV="$HOME/.local/bin/uv"
else
  echo "Installing uv (Python toolchain manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
fi

if [ ! -x ".venv/bin/python" ]; then
  echo "Provisioning Python $PYVER via uv..."
  "$UV" python install "$PYVER"
  echo "Creating virtual environment (Python $PYVER)..."
  "$UV" venv .venv --python "$PYVER"
  # shellcheck disable=SC1091
  source .venv/bin/activate

  # --- Pick a prebuilt flash-attn wheel + its matching torch install ----------
  # select_flash_attn.py picks the table for this platform (flash_attention_linux.txt
  # here) and, on a CUDA match, prints:
  #   WHEEL=<flash-attn wheel url>
  #   TORCHARGS=<torch~=.. torchvision .. [--index-url ..]>
  # Prints nothing on no match. Python is pinned to 3.13 by uv, so the wheels (all
  # cp313) always fit; only CUDA has to be matched.
  echo
  echo "Detecting CUDA to select a flash-attn wheel..."
  WHEEL=""
  TORCHARGS=""
  while IFS= read -r line; do
    case "$line" in
      WHEEL=*) WHEEL="${line#WHEEL=}" ;;
      TORCHARGS=*) TORCHARGS="${line#TORCHARGS=}" ;;
    esac
  done < <(python select_flash_attn.py)

  echo
  echo "Installing SkinTokens requirements..."
  "$UV" pip install -r requirements.txt

  # torch AFTER requirements so it overrides the torch `lightning` pulls in. The
  # curated TORCHARGS pins torch to the version the flash-attn wheel was built
  # against, so the ABI matches. On Linux the PyPI torch wheels bundle CUDA, so a
  # row may legitimately carry no --index-url.
  echo
  if [ -n "$TORCHARGS" ]; then
    echo "Installing torch: $TORCHARGS"
    # shellcheck disable=SC2086 -- curated arg list; word-splitting is intended
    "$UV" pip install $TORCHARGS
  else
    echo "No matching prebuilt flash-attn wheel -- installing default torch (CUDA build from PyPI)..."
    "$UV" pip install torch torchvision
  fi

  # --- flash-attn -------------------------------------------------------------
  echo
  if [ -n "${RIGTOOLS_SKIP_FLASH:-}" ]; then
    echo "RIGTOOLS_SKIP_FLASH set -- skipping flash-attn."
  elif [ -n "$WHEEL" ]; then
    echo "Downloading + installing prebuilt flash-attn wheel..."
    # Fetch to a local path first: `pip install <hf-url>` 403s on Hugging Face
    # Xet-backed files. GitHub release assets go over plain urllib.
    if FA_WHEEL="$(python download_wheel.py "$WHEEL" | tail -n 1)" && [ -n "$FA_WHEEL" ]; then
      "$UV" pip install "$FA_WHEEL" || echo "[warn] flash-attn install failed; continuing without it."
    else
      echo "[warn] flash-attn download failed; continuing without it."
    fi
  elif [ -n "${RIGTOOLS_BUILD_FLASH:-}" ]; then
    echo "No curated wheel matched -- building flash-attn from source (this takes ~an hour)..."
    "$UV" pip install flash-attn --no-build-isolation || echo "[warn] flash-attn build failed; continuing without it."
  else
    echo "[warn] No prebuilt flash-attn wheel matched this CUDA; flash-attn was NOT installed."
    echo "       rig_server.py cannot import without it. Either add a row for your"
    echo "       CUDA/torch to flash_attention_linux.txt, or build from source with:"
    echo "         RIGTOOLS_BUILD_FLASH=1 ./run_server.sh   # ~1 hour, needs nvcc + ninja"
  fi

  # A wheel built against a different torch ABI installs cleanly and only fails at
  # import ("undefined symbol: _ZN3c10..."), so check now rather than mid-rig.
  if [ -z "${RIGTOOLS_SKIP_FLASH:-}" ]; then
    python -c 'import torch, flash_attn; print("flash_attn", flash_attn.__version__, "/ torch", torch.__version__)' \
      || echo "[warn] flash-attn does not import -- likely a torch ABI mismatch with the selected wheel."
  fi

  echo
  if [ -n "${RIGTOOLS_SKIP_MODEL:-}" ]; then
    echo "RIGTOOLS_SKIP_MODEL set -- skipping checkpoint download."
  else
    echo "Downloading model checkpoints (large; first run only)..."
    python download.py --model || echo "[warn] model download failed; run 'python download.py --model' manually before rigging."
  fi

  echo
  echo "Setup complete."
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
  python -c "import fastapi, uvicorn, multipart" 2>/dev/null || "$UV" pip install fastapi uvicorn python-multipart
fi

python rig_server.py
