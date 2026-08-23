"""Fetch the weights the motion service needs, before it is first used.

Two very different downloads live behind one command:

  --model          the Kimodo checkpoint itself. 1.1 GB.

  --text-encoder   LLM2Vec, i.e. Meta-Llama-3-8B. ~16 GB. This is the whole of
                   the "~17 GB of VRAM" Kimodo's docs quote, and it is why the
                   encoder runs out-of-process on the CPU here.

Both land in the model folder resolved by kimodo_paths (see that module for the
layout and for why the base weights get a plain directory instead of the shared
Hugging Face cache). Point KIMODO_CHECKPOINT_DIR -- or Settings -> Motion
Generation -> "Model folder" in the desktop app -- somewhere else to move them.

Usage:
    python download.py                # both (default)
    python download.py --model        # checkpoint only
    python download.py --text-encoder # encoder only
"""
from __future__ import annotations

import argparse
import sys

from huggingface_hub import snapshot_download

from kimodo_paths import (
    CHECKPOINT_DIR,
    GATED_BASE,
    LLAMA_REPO,
    MODEL_REPO,
    ensure_llama_base,
    model_dir,
)

# LLM2Vec is two small LoRA adapters over a large base model. Only the base is
# gated, and only the base is big -- fetching the adapters alone takes seconds and
# is what made an earlier version of this script look like it had downloaded 16 GB
# when it had not; transformers would then pull the base lazily at load time and
# fail there instead.
TEXT_ENCODER_ADAPTER_REPOS = [
    "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp",
    "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised",
]

def fetch_model() -> None:
    target = model_dir()
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
    """The two LoRA adapters, then the base weights.

    The adapters are small and go to the normal Hugging Face cache -- LLM2Vec
    resolves them by repo id and they are ~170 MB, not 16 GB. Only the base is
    worth placing deliberately, which ensure_llama_base() handles (including
    leaving an already-cached copy where it is).
    """
    print("[download] text encoder (~16 GB on first run; resumable)")
    for repo in TEXT_ENCODER_ADAPTER_REPOS:
        print(f"[download]   adapter {repo}")
        snapshot_download(repo_id=repo)

    try:
        base = ensure_llama_base(log=lambda msg: print(f"[download]   {msg}"))
    except Exception as exc:  # noqa: BLE001 - re-raised with something actionable
        if "gated" in str(exc).lower() or "403" in str(exc):
            raise RuntimeError(
                f"{LLAMA_REPO} is a gated repo and this machine is not authorised.\n"
                "  Either request access and run `hf auth login`,\n"
                "  or use an ungated mirror of the same weights:\n"
                "      set KIMODO_LLAMA_BASE=NousResearch/Meta-Llama-3-8B-Instruct\n"
                "  (A GGUF build cannot be used: LLM2Vec needs bidirectional attention "
                "and PEFT adapters.)"
            ) from exc
        raise
    print(f"[download] text encoder ready: {base}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Kimodo motion-service weights.")
    parser.add_argument("--model", action="store_true", help="Download the Kimodo checkpoint (1.1 GB).")
    parser.add_argument("--text-encoder", action="store_true", help="Download LLM2Vec / Llama-3-8B (~16 GB).")
    args = parser.parse_args()

    # No flags means both, so a first-time setup is one command.
    want_model = args.model or not (args.model or args.text_encoder)
    want_encoder = args.text_encoder or not (args.model or args.text_encoder)

    print(f"[download] model folder: {CHECKPOINT_DIR}")
    if LLAMA_REPO == GATED_BASE:
        print(f"[download] base weights repo: {LLAMA_REPO} (gated -- needs `hf auth login`)")

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
