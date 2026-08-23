"""Text-encoder sidecar for the Kimodo motion service.

Kimodo conditions on a sentence embedding produced by LLM2Vec, which wraps
Meta-Llama-3-8B — a ~16 GB model that dwarfs Kimodo's own 1.1 GB checkpoint and
is the entire reason upstream quotes "~17 GB of VRAM". It runs HERE, in a
separate process, for two reasons:

  * It runs on the CPU (``TEXT_ENCODER_DEVICE=cpu``), so the GPU is left to
    Kimodo (<3 GB) and stays shareable with the rigging service and ComfyUI.
  * A process can be KILLED. Its ~16 GB of RSS goes back to the OS in a way that
    ``del model; gc.collect()`` inside a long-lived server does not reliably
    achieve. motion_server.py starts this on demand and reaps it when idle.

Upstream ships an equivalent as a Gradio app (``kimodo_textencoder``), but that
one round-trips embeddings through .npy files under a hardcoded ``/tmp`` path
that does not exist on Windows, and pulls Gradio into the install. This is the
same contract in ~100 lines over plain JSON.

The model loads in a BACKGROUND THREAD so the port binds immediately: the parent
polls ``/health`` and forwards {loading -> ready} as progress rather than
blocking on a socket that takes minutes to answer on a cold cache.

Run standalone (rarely needed — motion_server.py spawns it):

    python text_encoder_server.py       # binds KIMODO_TEXT_ENCODER_PORT (9550)
"""
from __future__ import annotations

import base64
import json
import os
import threading
import traceback

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from kimodo_paths import (
    DATA_DIR as _DATA_DIR,
    GATED_BASE,
    LLAMA_REPO,
    ensure_llama_base,
    llama_dir,
    resolve_llama_base,
)

HOST = os.environ.get("KIMODO_TEXT_ENCODER_HOST", "127.0.0.1")
PORT = int(os.environ.get("KIMODO_TEXT_ENCODER_PORT", "9550") or "9550")
# CPU by default: see the module docstring. Set to "cuda" only on a card with
# headroom for both this and everything else the app runs on the GPU.
DEVICE = os.environ.get("TEXT_ENCODER_DEVICE", "cpu")

# LLM2Vec is a pair of LoRA adapters over Llama-3-8B-Instruct. The adapter repos
# are small and ungated; the BASE WEIGHTS are the gated 16 GB part. GATED_BASE and
# LLAMA_REPO come from kimodo_paths, which owns where the weights live.
MNTP_REPO = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
SUPERVISED_REPO = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"

# Where the base weights come from is decided by kimodo_paths.ensure_llama_base()
# -- local model folder, else an already-populated Hugging Face cache, else a
# fresh download into the model folder. See that function for why the order
# matters.
#
# Resolved on the LOADING THREAD, not at import: case 3 downloads ~16 GB, and
# doing that at import would hold the port closed for an hour with nothing able
# to report why. _load() sets this; /health reports it.
_resolved_base: str | None = None

# There is deliberately NO quantization option. It was tried and removed.
#
# LLM2Vec loads the base model with the MNTP LoRA attached and then calls
# merge_and_unload(); bitsandbytes layers cannot survive that in this
# transformers 5.1 / peft 0.20 stack. Both modes die at the same line
# (llm2vec.py from_pretrained -> model_class.from_pretrained):
#   8bit -> "`layers.0.self_attn.q_proj.base_layer.SCB` is neither a parameter,
#            buffer, nor extra state"   (int8 keeps its scales in a plain
#            attribute, and int8 layers cannot be merged at all)
#   4bit -> "`weight` is not an nn.Module"   (Params4bit trips the submodule walk)
#
# Quantizing after a bf16 merge would work, but it needs the full ~16 GB in
# memory to do the merge -- which is the cost quantizing was meant to avoid.
# The encoder runs bf16 on the CPU instead; see the module docstring.

app = FastAPI(title="3D Gen Studio - Kimodo Text Encoder", version="0.1.0")

_encoder = None
_load_error: str | None = None
_load_lock = threading.Lock()


def _explain(exc: Exception) -> str:
    """Turn a load failure into something the user can act on.

    The gated-repo 403 is by far the most likely first-run failure, and the raw
    traceback buries the one sentence that matters under three chained exceptions.
    """
    detail = traceback.format_exc(limit=3)
    message = str(exc)
    if GATED_BASE in message or "gated repo" in message.lower():
        return (
            f"The base weights ({GATED_BASE}) are a gated Hugging Face repo and this machine "
            "is not authorised for it. The LLM2Vec adapters themselves are ungated; only the "
            "16 GB base is blocked. Two ways to fix it:\n"
            f"  1. Request access at https://huggingface.co/{GATED_BASE} (usually granted "
            "quickly), then run `hf auth login` inside thirdparty/kimodo/.venv.\n"
            "  2. Point at an ungated mirror of the same weights, e.g. set "
            "KIMODO_LLAMA_BASE=NousResearch/Meta-Llama-3-8B-Instruct before starting the "
            "service, then run `python download.py --text-encoder` to fetch them into\n"
            f"     {llama_dir()}\n"
            "A GGUF build cannot be substituted: LLM2Vec needs bidirectional attention and "
            "two PEFT adapters, and GGUF supports neither.\n\n" + detail
        )
    return detail


def _rebased_adapter_dir(base: str) -> str:
    """Local copy of the MNTP adapter, repointed at `base`.

    `base` is whatever ensure_llama_base() settled on -- a local directory or a
    repo id. Both work: transformers resolves either through the same code path.

    The MNTP repo is just a LoRA plus a tokenizer; the 16 GB of base weights it
    names in ``adapter_config.json`` are the gated part. Rather than reimplement
    LLM2Vec's loading to inject a different base, copy the adapter locally and
    rewrite that one field: transformers then resolves the base to the mirror and
    every other step runs exactly as upstream wrote it.

    The subtlety this arrangement also solves: LLM2Vec applies the Llama-3 chat
    template only when ``config._name_or_path`` is the string
    "meta-llama/Meta-Llama-3-8B-Instruct" (see prepare_for_tokenization). Loading
    from a mirror directly would leave a different name there, silently dropping
    the wrapper and changing every embedding. LLM2Vec restores _name_or_path from
    ``config.json`` when the base is a LOCAL DIRECTORY -- and the adapter repo's
    config.json already carries the canonical name -- so going through a local
    copy keeps the tokenization identical.
    """
    from huggingface_hub import snapshot_download

    # Under cache/ with the embedding cache: everything downloaded or derived at
    # runtime lives beneath one gitignored root, so no future addition to it can
    # end up committed (a 160 MB adapter did exactly that once).
    target = _DATA_DIR / "cache" / "text-encoder" / "mntp-rebased"
    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=MNTP_REPO, local_dir=str(target))

    config_path = target / "adapter_config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config.get("base_model_name_or_path") != base:
        config["base_model_name_or_path"] = base
        config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

    # Guard the trap described above rather than trusting the upstream file.
    model_config_path = target / "config.json"
    model_config = json.loads(model_config_path.read_text(encoding="utf-8"))
    if model_config.get("_name_or_path") != GATED_BASE:
        model_config["_name_or_path"] = GATED_BASE
        model_config_path.write_text(json.dumps(model_config, indent=2), encoding="utf-8")

    return str(target)


def _warn_if_quant_requested() -> None:
    """Say so if a stale KIMODO_TEXT_ENCODER_QUANT is still set.

    The variable used to do something. Ignoring it in silence would leave someone
    believing the encoder is quantized when it is not.
    """
    stale = os.environ.get("KIMODO_TEXT_ENCODER_QUANT", "").strip().lower()
    if stale and stale not in ("none", "off", "no"):
        print(f"[kimodo-text-encoder] ignoring KIMODO_TEXT_ENCODER_QUANT={stale}: quantization "
              "was removed because LLM2Vec's LoRA merge is incompatible with bitsandbytes "
              "layers. Running bf16.")


def _load() -> None:
    """Instantiate LLM2Vec once, recording the failure instead of raising.

    Runs on a background thread, so an exception here would otherwise vanish; the
    parent needs to see it via /health to turn it into a useful SSE error.
    """
    global _encoder, _load_error, _resolved_base
    try:
        # Imported lazily: pulling in torch + transformers costs seconds we do
        # not want to pay before the port is bound.
        from kimodo.model import LLM2VecEncoder

        # May download ~16 GB. Prints progress to stdout, which run.bat and the
        # desktop shell both capture into the Kimodo service log.
        _resolved_base = ensure_llama_base()
        base_path = _rebased_adapter_dir(_resolved_base)

        encoder = LLM2VecEncoder(
            base_model_name_or_path=base_path,
            peft_model_name_or_path=SUPERVISED_REPO,
            # bfloat16 halves the footprint, and CPU bfloat16 matmul is supported
            # on every x86-64 target we ship to. float32 would need ~32 GB of RAM.
            dtype="bfloat16",
            llm_dim=4096,
            device=DEVICE,
        )
        with _load_lock:
            _encoder = encoder
    except Exception as exc:  # noqa: BLE001 - reported through /health, not raised
        with _load_lock:
            _load_error = _explain(exc)


@app.on_event("startup")
def _startup() -> None:
    _warn_if_quant_requested()
    threading.Thread(target=_load, daemon=True).start()


@app.get("/health")
def health() -> dict:
    with _load_lock:
        return {
            "status": "error" if _load_error else ("ok" if _encoder is not None else "loading"),
            "ready": _encoder is not None,
            "device": DEVICE,
            # Null until the loading thread has settled it. `base_local` is the
            # difference between "the model folder holds these, and Settings can
            # move them" and "they are wherever HF_HOME points" — worth reporting,
            # because the two are otherwise indistinguishable from outside.
            "base": _resolved_base or LLAMA_REPO,
            "base_local": bool(resolve_llama_base()),
            "models_dir": str(llama_dir().parent),
            "error": _load_error,
        }


class EncodeRequest(BaseModel):
    texts: list[str]


@app.post("/encode")
def encode(req: EncodeRequest) -> dict:
    """Encode prompts to a (N, 1, 4096) float32 array, base64'd.

    Returned as raw bytes rather than JSON numbers: exact round-trip, and ~4x
    smaller on the wire. Tiny either way (16 KB per prompt) - which is what makes
    the caller's on-disk embedding cache worth having.
    """
    with _load_lock:
        encoder, error = _encoder, _load_error
    if error:
        raise HTTPException(status_code=503, detail=f"Text encoder failed to load: {error}")
    if encoder is None:
        raise HTTPException(status_code=503, detail="Text encoder is still loading.")
    if not req.texts:
        raise HTTPException(status_code=400, detail="texts must not be empty.")

    tensor, lengths = encoder(list(req.texts))
    array = np.ascontiguousarray(tensor.detach().cpu().float().numpy())
    return {
        "shape": list(array.shape),
        "lengths": list(lengths) if isinstance(lengths, (list, tuple)) else [lengths],
        "data_b64": base64.b64encode(array.tobytes()).decode("ascii"),
    }


if __name__ == "__main__":
    print(f"[kimodo-text-encoder] listening on http://{HOST}:{PORT}  "
          f"(device={DEVICE}, base={LLAMA_REPO}, models={llama_dir().parent})")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
