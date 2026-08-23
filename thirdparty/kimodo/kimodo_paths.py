"""Where the motion service keeps the weights it downloads.

Three processes need the same answer -- ``download.py`` fetches into it,
``motion_server.py`` loads the Kimodo checkpoint from it, and
``text_encoder_server.py`` loads the Llama-3 base from it -- so the resolution
lives here once instead of three times over.

Layout under the model folder::

    <models>/Kimodo-SOMA-RP-v1.1/       the 1.1 GB Kimodo checkpoint
    <models>/Meta-Llama-3-8B-Instruct/  the ~16 GB LLM2Vec base weights

WHY THE BASE WEIGHTS GET THEIR OWN FOLDER
-----------------------------------------
By default ``transformers`` resolves ``NousResearch/Meta-Llama-3-8B-Instruct``
through the shared Hugging Face cache (``HF_HOME``), which lands 16 GB in
``~/.cache/huggingface`` with no indication that it belongs to this app. Setting
``HF_HOME`` instead would move every unrelated model with it. Downloading the
snapshot into a plain directory next to the Kimodo checkpoint means:

  * one folder holds everything the motion service downloaded, so the Settings
    "Model folder" box relocates all of it at once;
  * the desktop uninstaller can offer that folder by name alongside the other
    heavy components;
  * the path can be handed straight to ``from_pretrained``, which treats a local
    directory the same as a repo id.

Environment overrides:
    KIMODO_CHECKPOINT_DIR   the model folder (Settings -> Motion Generation)
    KIMODO_DATA_DIR         the writable root it defaults to
    KIMODO_MODEL            the Kimodo checkpoint name
    KIMODO_LLAMA_BASE       which repo the base weights come from
"""
from __future__ import annotations

import json
import os
from pathlib import Path

# The packaged desktop app ships this code directory READ-ONLY, so everything
# written at runtime goes under a per-user data dir instead.
_HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("KIMODO_DATA_DIR") or _HERE).resolve()
CHECKPOINT_DIR = Path(
    os.environ.get("KIMODO_CHECKPOINT_DIR") or (DATA_DIR / "checkpoints")
).resolve()

MODEL_NAME = os.environ.get("KIMODO_MODEL", "Kimodo-SOMA-RP-v1.1")
MODEL_REPO = f"nvidia/{MODEL_NAME}"

# LLM2Vec is two small LoRA adapters over Llama-3-8B-Instruct. Only the base is
# gated, and only the base is big.
GATED_BASE = "meta-llama/Meta-Llama-3-8B-Instruct"
# An ungated mirror of the same weights can be substituted here; the folder the
# snapshot lands in is named after the repo either way, so switching mirrors does
# not silently start a second 16 GB download beside the first.
LLAMA_REPO = os.environ.get("KIMODO_LLAMA_BASE", "").strip() or GATED_BASE

# Keeps the .pth / original/ duplicates out: several Llama-3 mirrors ship both
# safetensors and a full consolidated checkpoint, which would double the download
# for nothing.
BASE_ALLOW = ["*.json", "*.safetensors", "*.model", "*.txt"]
BASE_IGNORE = ["original/*", "*.pth"]


def model_dir() -> Path:
    """The Kimodo checkpoint folder.

    The name is load-bearing: ``load_model()`` resolves
    ``CHECKPOINT_DIR/<display name>/config.yaml``, and a folder whose name does
    not match falls through to a silent re-download from Hugging Face. It is
    CASE SENSITIVE on Linux.
    """
    return CHECKPOINT_DIR / MODEL_NAME


def llama_dir() -> Path:
    """Where the base weights live locally, named after the repo they came from."""
    return CHECKPOINT_DIR / LLAMA_REPO.split("/")[-1]


def snapshot_complete(path: Path) -> bool:
    """Is `path` a finished weights snapshot rather than a half-finished one?

    An interrupted 16 GB download leaves a directory that has ``config.json`` and
    some of the shards, which would otherwise be loaded and fail deep inside
    ``from_pretrained``. When the model is sharded, the index names every shard
    it needs, so that list is what gets checked -- not a file count, which would
    accept the wrong shards.
    """
    if not (path / "config.json").is_file():
        return False
    index = path / "model.safetensors.index.json"
    if index.is_file():
        try:
            weight_map = json.loads(index.read_text(encoding="utf-8")).get("weight_map") or {}
        except (OSError, ValueError):
            return False
        shards = set(weight_map.values())
        return bool(shards) and all((path / shard).is_file() for shard in shards)
    return any(path.glob("*.safetensors"))


def resolve_llama_base() -> str | None:
    """The local base-weights directory, or None if it is not (fully) there.

    Returning None is not a failure — see `ensure_llama_base`, which decides what
    to do about it.
    """
    local = llama_dir()
    return str(local) if snapshot_complete(local) else None


def cached_llama_snapshot() -> str | None:
    """A COMPLETE copy of the base in the shared Hugging Face cache, or None.

    Pure cache lookup: ``local_files_only`` makes snapshot_download raise rather
    than reach the network.

    Only ``config.json`` is requested, and completeness is then judged by
    `snapshot_complete` against the returned snapshot directory. Asking for the
    full file list instead does NOT work: a lazy load through transformers
    fetches only what it needs — for this repo, config.json, the index and the
    four shards, and no tokenizer at all (LLM2Vec takes the tokenizer from the
    MNTP adapter). A probe that demanded every ``*.txt`` and ``*.model`` in the
    repo therefore reported a perfectly usable 15 GB cache as missing, which
    would send download.py off to fetch all of it a second time.
    """
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        return None
    try:
        path = snapshot_download(
            repo_id=LLAMA_REPO, allow_patterns=["config.json"], local_files_only=True
        )
    except Exception:  # noqa: BLE001 - any miss means "not usable from the cache"
        return None
    snapshot = Path(path)
    # Llama-3-8B is always sharded, so a missing index means a partial cache.
    # Insisting on it keeps snapshot_complete from accepting one stray shard.
    if not (snapshot / "model.safetensors.index.json").is_file():
        return None
    return str(snapshot) if snapshot_complete(snapshot) else None


def ensure_llama_base(log=print) -> str:
    """What to hand ``from_pretrained``, downloading the weights if need be.

    Three cases, in this order:

      1. The model folder already has a complete snapshot — use it.
      2. The shared Hugging Face cache already has one — use the repo id so
         transformers resolves it there. This is what stops an existing install
         from re-downloading 16 GB just because the model folder is a newer idea
         than the machine it is running on.
      3. Neither — download into the MODEL FOLDER and return that path.

    Case 3 is the whole point of this function. Handing transformers a bare repo
    id in that situation works, but it resolves through the Hugging Face cache,
    so the weights land in HF_HOME no matter what the model folder is set to —
    the setting then only governs what download.py writes, which is not what
    "where to save the model" means to anyone reading it.
    """
    local = resolve_llama_base()
    if local:
        return local

    cached = cached_llama_snapshot()
    if cached:
        log(f"[kimodo] base weights: using the Hugging Face cache at {cached}")
        log(f"[kimodo]   (to move them to {llama_dir()}, delete that cache entry "
            "and run `python download.py --text-encoder`)")
        return LLAMA_REPO

    from huggingface_hub import snapshot_download

    target = llama_dir()
    target.mkdir(parents=True, exist_ok=True)
    log(f"[kimodo] base weights: downloading {LLAMA_REPO} -> {target}  (~16 GB, resumable)")
    snapshot_download(
        repo_id=LLAMA_REPO,
        local_dir=str(target),
        allow_patterns=BASE_ALLOW,
        ignore_patterns=BASE_IGNORE,
    )
    if not snapshot_complete(target):
        raise RuntimeError(
            f"{target} is incomplete after downloading {LLAMA_REPO}. Re-run to resume."
        )
    return str(target)
