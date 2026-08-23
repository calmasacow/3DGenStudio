"""Fetch the weights the motion service needs, before it is first used.

Two very different downloads live behind one command:

  --model          the Kimodo checkpoint itself. 1.1 GB. Lands in
                   ``checkpoints/<DisplayName>/`` because load_model() resolves
                   CHECKPOINT_DIR/<display name>/config.yaml, and a name that
                   does not match falls through to a silent re-download from
                   Hugging Face. The folder name is CASE SENSITIVE on Linux.

  --text-encoder   LLM2Vec, i.e. Meta-Llama-3-8B. ~16 GB. This is the whole of
                   the "~17 GB of VRAM" Kimodo's docs quote, and it is why the
                   encoder runs out-of-process on the CPU here. It goes into the
                   normal Hugging Face cache, where LLM2Vec.from_pretrained
                   looks for it.

Usage:
    python download.py                # both (default)
    python download.py --model        # checkpoint only
    python download.py --text-encoder # encoder only
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

_HERE = Path(__file__).resolve().parent
_DATA_DIR = Path(os.environ.get("KIMODO_DATA_DIR") or _HERE).resolve()

MODEL_NAME = os.environ.get("KIMODO_MODEL", "Kimodo-SOMA-RP-v1.1")
MODEL_REPO = f"nvidia/{MODEL_NAME}"
CHECKPOINT_DIR = Path(os.environ.get("KIMODO_CHECKPOINT_DIR") or (_DATA_DIR / "checkpoints")).resolve()

# LLM2Vec is two small LoRA adapters over a large base model. Only the base is
# gated, and only the base is big -- fetching the adapters alone takes seconds and
# is what made an earlier version of this script look like it had downloaded 16 GB
# when it had not; transformers would then pull the base lazily at load time and
# fail there instead.
TEXT_ENCODER_ADAPTER_REPOS = [
    "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp",
    "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised",
]
GATED_BASE = "meta-llama/Meta-Llama-3-8B-Instruct"
# Ungated mirror of the same weights; set KIMODO_LLAMA_BASE to use it.
BASE_REPO = os.environ.get("KIMODO_LLAMA_BASE", "").strip() or GATED_BASE


def fetch_model() -> None:
    target = CHECKPOINT_DIR / MODEL_NAME
    if (target / "config.yaml").exists():
        print(f"[download] checkpoint already present: {target}")
        return
    print(f"[download] {MODEL_REPO} -> {target}  (1.1 GB)")
    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=MODEL_REPO, local_dir=str(target))
    if not (target / "config.yaml").exists():
        raise SystemExit(f"[download] {target}/config.yaml missing after download.")
    print(f"[download] checkpoint ready: {target}")


def fetch_text_encoder() -> None:
    print("[download] text encoder (~16 GB on first run; resumable)")
    for repo in TEXT_ENCODER_ADAPTER_REPOS:
        print(f"[download]   adapter {repo}")
        snapshot_download(repo_id=repo)

    print(f"[download]   base {BASE_REPO}  (~16 GB)")
    try:
        # allow_patterns keeps the .pth / original/ duplicates out: several Llama-3
        # mirrors ship both safetensors and a full consolidated checkpoint, which
        # would double the download for nothing.
        snapshot_download(
            repo_id=BASE_REPO,
            allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt"],
            ignore_patterns=["original/*", "*.pth"],
        )
    except Exception as exc:  # noqa: BLE001 - re-raised with something actionable
        if "gated" in str(exc).lower() or "403" in str(exc):
            raise RuntimeError(
                f"{BASE_REPO} is a gated repo and this machine is not authorised.\n"
                "  Either request access and run `hf auth login`,\n"
                "  or use an ungated mirror of the same weights:\n"
                "      set KIMODO_LLAMA_BASE=NousResearch/Meta-Llama-3-8B-Instruct\n"
                "  (A GGUF build cannot be used: LLM2Vec needs bidirectional attention "
                "and PEFT adapters.)"
            ) from exc
        raise
    print("[download] text encoder ready.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Kimodo motion-service weights.")
    parser.add_argument("--model", action="store_true", help="Download the Kimodo checkpoint (1.1 GB).")
    parser.add_argument("--text-encoder", action="store_true", help="Download LLM2Vec / Llama-3-8B (~16 GB).")
    args = parser.parse_args()

    # No flags means both, so a first-time setup is one command.
    want_model = args.model or not (args.model or args.text_encoder)
    want_encoder = args.text_encoder or not (args.model or args.text_encoder)

    try:
        if want_model:
            fetch_model()
        if want_encoder:
            fetch_text_encoder()
    except Exception as exc:  # noqa: BLE001 - this is a CLI; a traceback helps nobody here
        print(f"[download] failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
