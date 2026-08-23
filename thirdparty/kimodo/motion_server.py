"""Text-to-motion micro-service for 3D Gen Studio (NVIDIA Kimodo).

A FastAPI app wrapping Kimodo's text-to-motion model so the Node backend can turn
a prompt into an animation over HTTP. It mirrors the request/response contract of
the rigging service (``thirdparty/skintokens/rig_server.py``) so the Node proxy
and the browser client treat the two identically:

  Request  : application/json
               {"prompt": "...", "duration": 5.0, "in_place": false, ...}
  Response : text/event-stream (SSE)
               {"type":"progress","stage":"denoise","frac":0.6,"message":"..."}
               {"type":"done","format":"bvh","bvh":"HIERARCHY...","stats":{...}}
               {"type":"error","detail":"..."}

Output is BVH rather than GLB on purpose. Kimodo generates on the 77-joint SOMA
skeleton, whose bone names are already near-Mixamo, and the browser retargets it
onto the user's rigged mesh with the same code path the mesh2motion reference
clips use (src/utils/animationLibrary.js). BVH is what that path can consume with
no conversion step and no Blender round-trip - a few hundred KB of text.

Why a separate service (not part of the rigging service, which also owns a GPU
model): Kimodo's vendored LLM2Vec subclasses transformers' Llama internals and
pins ``transformers==5.1.0``. On newer transformers, ``LlamaModel.forward`` calls
the module-level ``create_causal_mask()`` and never calls the
``_update_causal_mask`` override that LLM2Vec's bidirectionality depends on - so
the encoder silently runs CAUSALLY and returns plausible-but-wrong embeddings.
No exception, just quietly worse motion. The rigging venv is on transformers
5.13, so the two must not share one.

Run it from THIS directory, inside the Kimodo venv:

    python motion_server.py         # binds KIMODO_HOST:KIMODO_PORT (0.0.0.0:8400)

Prerequisite (run once): ``python download.py``.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

# The rigging service's lesson, applied here: the packaged desktop app ships this
# code directory READ-ONLY, so anything we write (checkpoints, the embedding
# cache) has to live under a per-user data dir instead. Resolve it before any
# kimodo import so CHECKPOINT_DIR is set by the time load_model reads it.
_HERE = Path(__file__).resolve().parent
_DATA_DIR = Path(os.environ.get("KIMODO_DATA_DIR") or _HERE).resolve()
_DATA_DIR.mkdir(parents=True, exist_ok=True)

HOST = os.environ.get("KIMODO_HOST", "0.0.0.0")
PORT = int(os.environ.get("KIMODO_PORT", "8400") or "8400")
MODEL_NAME = os.environ.get("KIMODO_MODEL", "Kimodo-SOMA-RP-v1.1")
CHECKPOINT_DIR = Path(os.environ.get("KIMODO_CHECKPOINT_DIR") or (_DATA_DIR / "checkpoints")).resolve()
CACHE_DIR = Path(os.environ.get("KIMODO_CACHE_DIR") or (_DATA_DIR / "cache" / "text-embeddings")).resolve()

TEXT_ENCODER_HOST = os.environ.get("KIMODO_TEXT_ENCODER_HOST", "127.0.0.1")
TEXT_ENCODER_PORT = int(os.environ.get("KIMODO_TEXT_ENCODER_PORT", "9550") or "9550")
TEXT_ENCODER_URL = f"http://{TEXT_ENCODER_HOST}:{TEXT_ENCODER_PORT}"
TEXT_ENCODER_DEVICE = os.environ.get("TEXT_ENCODER_DEVICE", "cpu")
# How long the ~16 GB encoder may sit idle before it is reaped. Prompts are
# cached, so re-running a prompt you already used never pays to restart it.
TEXT_ENCODER_IDLE_SECONDS = float(os.environ.get("KIMODO_TEXT_ENCODER_IDLE", "600") or "600")
TEXT_ENCODER_BOOT_TIMEOUT = float(os.environ.get("KIMODO_TEXT_ENCODER_BOOT_TIMEOUT", "1800") or "1800")

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "KIMODO_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3001"
    ).split(",")
    if o.strip()
]

# Upstream's documented ceiling: quality degrades past ~10 s of motion for one
# prompt. Longer clips are built by chaining prompts, not by raising this.
MAX_SECONDS_PER_PROMPT = 10.0
MIN_SECONDS_PER_PROMPT = 0.5
MAX_PROMPT_SEGMENTS = 8

# load_model() reads these from the environment. LOCAL_CACHE keeps it from
# hitting Hugging Face when the checkpoint is already on disk.
os.environ.setdefault("CHECKPOINT_DIR", str(CHECKPOINT_DIR))
os.environ.setdefault("LOCAL_CACHE", "true")
# Kimodo's own text-encoder selection is bypassed entirely; we inject the remote
# encoder below. Pinning the mode stops load_model from probing a Gradio URL.
os.environ.setdefault("TEXT_ENCODER_MODE", "api")

import numpy as np  # noqa: E402
import requests  # noqa: E402
import torch  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from kimodo import load_model  # noqa: E402
from kimodo.tools import seed_everything  # noqa: E402
from motion_export import build_bvh, build_rest_pose_bvh  # noqa: E402


def _motion_correction_available() -> bool:
    """Is the C++ foot-skate cleanup extension importable?

    It is built by run_server as a separate, allowed-to-fail step (it needs CMake
    and a C++17 compiler). Probing once here means a machine without a toolchain
    degrades to "no post-processing" instead of failing every request deep inside
    kimodo.postprocess with an ImportError.
    """
    try:
        from motion_correction import motion_postprocess  # noqa: F401
    except Exception:
        return False
    return True


HAS_MOTION_CORRECTION = _motion_correction_available()

app = FastAPI(title="3D Gen Studio - Motion Generation", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


# --------------------------------------------------------------------------
# Text encoder: an out-of-process, on-demand, cached LLM2Vec
# --------------------------------------------------------------------------


class TextEncoderManager:
    """Owns the text-encoder subprocess and the embedding cache.

    Kimodo asks for one 4096-float vector per prompt and nothing else, which is
    what makes all of this worthwhile: the answer is 16 KB, so caching it on disk
    makes every repeat prompt free and lets the 16 GB process behind it be a
    transient rather than a resident.
    """

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._lock = threading.RLock()
        # Must start at "now", not 0.0: the reaper compares against this, and a
        # zero here reads as "idle since 1970" the instant the process spawns.
        self._last_used = time.time()
        # Requests currently in flight. The reaper refuses to kill while this is
        # non-zero, so a slow encode can never be pulled out from under itself.
        self._inflight = 0
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # Sweep temp files an interrupted write left behind. They are never read
        # (lookup is an exact "<hash>.npy"), so they would just accumulate.
        for stale in CACHE_DIR.glob("*.tmp"):
            stale.unlink(missing_ok=True)
        threading.Thread(target=self._reap_loop, daemon=True).start()

    # -- process lifecycle --

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _spawn(self) -> None:
        env = {
            **os.environ,
            "TEXT_ENCODER_DEVICE": TEXT_ENCODER_DEVICE,
            "KIMODO_TEXT_ENCODER_HOST": TEXT_ENCODER_HOST,
            "KIMODO_TEXT_ENCODER_PORT": str(TEXT_ENCODER_PORT),
        }
        self._proc = subprocess.Popen(
            [sys.executable, str(_HERE / "text_encoder_server.py")],
            cwd=str(_HERE),
            env=env,
        )
        # Loading takes minutes; without this the reaper counts that whole time
        # as idle and terminates the encoder the moment it finishes loading.
        self._last_used = time.time()

    def ensure_ready(self, report) -> None:
        """Start the encoder if needed and block until it answers /health.

        Progress is forwarded rather than swallowed: a cold cache downloads ~16 GB
        here, and a silent ten-minute stall is indistinguishable from a hang.
        """
        with self._lock:
            if not self.running:
                report("text-encoder", 0.05, "Starting the text encoder...")
                self._spawn()

            deadline = time.time() + TEXT_ENCODER_BOOT_TIMEOUT
            announced = False
            while time.time() < deadline:
                if self._proc is not None and self._proc.poll() is not None:
                    raise RuntimeError(
                        f"The text encoder process exited with code {self._proc.returncode} "
                        "before becoming ready. See the Kimodo service log."
                    )
                try:
                    health = requests.get(f"{TEXT_ENCODER_URL}/health", timeout=5).json()
                except Exception:
                    time.sleep(1.0)
                    continue
                if health.get("error"):
                    raise RuntimeError(f"Text encoder failed to load: {health['error']}")
                if health.get("ready"):
                    self._last_used = time.time()
                    return
                if not announced:
                    announced = True
                    report(
                        "text-encoder", 0.08,
                        "Loading the text encoder (first run downloads ~16 GB)...",
                    )
                time.sleep(2.0)
            raise RuntimeError("Timed out waiting for the text encoder to become ready.")

    def shutdown(self) -> None:
        with self._lock:
            proc, self._proc = self._proc, None
            if proc is None or proc.poll() is not None:
                return
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()

    def _reap_loop(self) -> None:
        """Kill the encoder once it has been idle long enough.

        The whole decision is made under the lock, and re-checked after acquiring
        it. That is not belt-and-braces: ensure_ready() holds this lock for the
        entire multi-minute model load, so a reaper that decided "idle" before
        blocking here would wake up and execute that stale verdict against an
        encoder that had just finished loading — killing it a moment before the
        first request, which surfaces as ConnectionResetError 10054 on /encode.
        """
        while True:
            time.sleep(30)
            if TEXT_ENCODER_IDLE_SECONDS <= 0:
                continue
            with self._lock:
                if not self.running or self._inflight:
                    continue
                if time.time() - self._last_used > TEXT_ENCODER_IDLE_SECONDS:
                    self.shutdown()

    # -- encoding --

    @staticmethod
    def _cache_path(text: str) -> Path:
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:40]
        return CACHE_DIR / f"{digest}.npy"

    def encode(self, texts: list[str], report) -> tuple[torch.Tensor, list[int]]:
        """Return ``(features, lengths)`` for `texts`, hitting the cache first.

        Only cache misses start (or wake) the subprocess - regenerating with the
        same prompt at a different duration or seed never touches it.
        """
        cached: dict[int, np.ndarray] = {}
        misses: list[int] = []
        for index, text in enumerate(texts):
            path = self._cache_path(text)
            if path.exists():
                try:
                    cached[index] = np.load(path)
                    continue
                except Exception:
                    # A truncated file from an interrupted write: treat as a miss.
                    path.unlink(missing_ok=True)
            misses.append(index)

        if misses:
            self.ensure_ready(report)
            report("text-encoder", 0.15, "Encoding the prompt...")
            payload = {"texts": [texts[i] for i in misses]}
            with self._lock:
                self._inflight += 1
                self._last_used = time.time()
            try:
                response = requests.post(f"{TEXT_ENCODER_URL}/encode", json=payload, timeout=900)
            except requests.exceptions.ConnectionError as exc:
                # The socket dying mid-request means the encoder process went
                # away. Say that, rather than surfacing a raw urllib3 reset that
                # reads like a network problem.
                code = self._proc.poll() if self._proc is not None else None
                detail = f" (it exited with code {code})" if code is not None else ""
                raise RuntimeError(
                    f"The text encoder stopped responding{detail}. If it ran out of memory, "
                    "the bf16 model needs ~16 GB of free RAM; see the Kimodo service log."
                ) from exc
            finally:
                with self._lock:
                    self._inflight -= 1
                    self._last_used = time.time()
            if response.status_code != 200:
                raise RuntimeError(f"Text encoding failed ({response.status_code}): {response.text[:300]}")
            body = response.json()

            flat = np.frombuffer(base64.b64decode(body["data_b64"]), dtype=np.float32)
            encoded = flat.reshape(tuple(body["shape"]))
            for slot, index in enumerate(misses):
                cached[index] = encoded[slot]
                path = self._cache_path(texts[index])
                # Write via a temp file: a crash mid-write must not leave a
                # half-written .npy that later loads as a valid-looking embedding.
                #
                # Written through an open handle, not a path: np.save() silently
                # appends ".npy" to any path that does not already end in it, so
                # saving to "<hash>.npy.tmp" actually produced "<hash>.npy.tmp.npy"
                # and the rename below then had nothing to rename. Handles are
                # exempt from that fixup.
                tmp = path.with_name(path.name + ".tmp")
                with open(tmp, "wb") as handle:
                    np.save(handle, encoded[slot])
                tmp.replace(path)

        self._last_used = time.time()

        # Each prompt encodes to a single (1, 4096) token, so "padding" is just
        # a stack - but keep the shape contract the model expects.
        stacked = np.stack([cached[i] for i in range(len(texts))], axis=0)
        return torch.from_numpy(np.ascontiguousarray(stacked)).float(), [int(stacked.shape[1])] * len(texts)


class RemoteTextEncoder:
    """The object Kimodo calls as ``self.text_encoder(texts)``.

    Deliberately NOT an nn.Module: ``model.to(device)`` / ``model.eval()`` must
    not try to follow it onto the GPU - the whole point is that it lives in
    another process, on the CPU.
    """

    def __init__(self, manager: TextEncoderManager) -> None:
        self._manager = manager
        self._report = lambda *_args, **_kwargs: None

    def bind_report(self, report) -> None:
        """Point progress at the current request's SSE stream."""
        self._report = report

    def to(self, *_args, **_kwargs):
        return self

    def eval(self):
        return self

    def __call__(self, texts):
        if isinstance(texts, str):
            texts = [texts]
        return self._manager.encode(list(texts), self._report)


# --------------------------------------------------------------------------
# Model lifecycle
# --------------------------------------------------------------------------

_lock = threading.Lock()
_encoder_manager = TextEncoderManager()
_remote_encoder = RemoteTextEncoder(_encoder_manager)
_model = None
_model_device = "cuda:0" if torch.cuda.is_available() else "cpu"


def _ensure_model(report):
    """Load the Kimodo checkpoint once (idempotent, warm afterwards)."""
    global _model
    if _model is None:
        report("model", 0.02, "Loading the motion model...")
        _model = load_model(
            MODEL_NAME,
            device=_model_device,
            default_family="Kimodo",
            text_encoder=_remote_encoder,
        )
    return _model


def _unload_model() -> None:
    global _model
    _model = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


# --------------------------------------------------------------------------
# Request handling
# --------------------------------------------------------------------------


class GenerateRequest(BaseModel):
    prompt: str
    duration: float = 5.0
    in_place: bool = False
    seed: int | None = None
    diffusion_steps: int = Field(default=100, ge=10, le=300)
    postprocess: bool = True
    keep_loaded: bool = True


def split_prompt(prompt: str) -> list[str]:
    """Split a prompt into Kimodo's sentence-per-segment form.

    Matches ``kimodo_gen``: periods separate segments, each generated in turn and
    stitched with a transition. This is also how a clip gets past the 10 s
    per-prompt ceiling - "A person walks. The person stops." is 2 x duration.
    """
    segments = [part.strip() for part in prompt.split(".")]
    segments = [f"{part}." for part in segments if part]
    if not segments:
        raise HTTPException(status_code=400, detail="prompt must not be empty.")
    if len(segments) > MAX_PROMPT_SEGMENTS:
        raise HTTPException(
            status_code=422,
            detail=f"prompt has {len(segments)} segments; at most {MAX_PROMPT_SEGMENTS} are allowed.",
        )
    return segments


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "model_loaded": _model is not None,
        "device": _model_device,
        "cuda": torch.cuda.is_available(),
        "checkpoint_dir": str(CHECKPOINT_DIR),
        "checkpoint_present": (CHECKPOINT_DIR / MODEL_NAME / "config.yaml").exists(),
        "motion_correction": HAS_MOTION_CORRECTION,
        "text_encoder": {
            "url": TEXT_ENCODER_URL,
            "device": TEXT_ENCODER_DEVICE,
            "running": _encoder_manager.running,
            "idle_seconds": TEXT_ENCODER_IDLE_SECONDS,
        },
    }


_rest_bvh_cache: dict = {}


@app.get("/motions/skeleton")
def skeleton() -> dict:
    """The SOMA-77 source skeleton at rest, as BVH.

    Lets the browser offer bone mapping the moment the Kimodo tab is opened,
    rather than making the user generate a throwaway clip to discover the bone
    list. Costs nothing: no checkpoint, no text encoder, no GPU.
    """
    if not _rest_bvh_cache:
        bvh_text, stats = build_rest_pose_bvh()
        _rest_bvh_cache.update({"bvh": bvh_text, "stats": stats})
    return _rest_bvh_cache


@app.post("/motions/generate")
def generate(req: GenerateRequest) -> StreamingResponse:
    texts = split_prompt(req.prompt)
    per_prompt = max(MIN_SECONDS_PER_PROMPT, min(MAX_SECONDS_PER_PROMPT, float(req.duration)))

    # Asked for, minus what this install can actually do. Reported back in stats
    # so the UI can say the clip may foot-skate rather than leaving the user to
    # wonder why the toggle did nothing.
    postprocess = bool(req.postprocess) and HAS_MOTION_CORRECTION

    events: "queue.Queue" = queue.Queue()
    holder: dict = {}

    def emit(stage, frac, message=""):
        events.put({"type": "progress", "stage": stage, "frac": round(float(frac), 4), "message": message})

    def worker():
        try:
            # GPU-bound and single-threaded in practice; serialize requests and
            # share one warm model across them.
            with _lock:
                _remote_encoder.bind_report(emit)
                model = _ensure_model(emit)
                num_frames = [int(round(per_prompt * model.fps))] * len(texts)

                if req.seed is not None:
                    seed_everything(int(req.seed))

                # One progress span per segment: the sampler restarts its step
                # loop for each prompt, so a single 0..1 bar would rewind.
                span = 0.75 / max(1, len(texts))
                segment = {"index": 0}

                def progress_bar(iterable):
                    steps = list(iterable)
                    base = 0.2 + span * segment["index"]
                    if len(texts) > 1:
                        label = f"Generating ({segment['index'] + 1}/{len(texts)})..."
                    else:
                        label = "Generating motion..."
                    for done, step in enumerate(steps):
                        emit("denoise", base + span * (done / max(1, len(steps))), label)
                        yield step
                    segment["index"] += 1

                emit("generate", 0.2, "Generating motion...")
                output = model(
                    texts,
                    num_frames,
                    num_denoising_steps=int(req.diffusion_steps),
                    # Required, despite defaulting to None: _multiprompt assigns
                    # `bs = num_samples` and then builds tensors of that size, so
                    # leaving it unset fails with "can't multiply sequence by
                    # non-int of type 'NoneType'". One sample per request — the UI
                    # generates takes one at a time.
                    num_samples=1,
                    multi_prompt=True,
                    num_transition_frames=5,
                    post_processing=postprocess,
                    return_numpy=True,
                    progress_bar=progress_bar,
                )

                emit("export", 0.96, "Building the animation...")
                bvh_text, stats = build_bvh(output, model, sample_index=0, in_place=bool(req.in_place))

                if not req.keep_loaded:
                    emit("unload", 0.99, "Freeing the model...")
                    _unload_model()

            holder["payload"] = {
                "format": "bvh",
                "bvh": bvh_text,
                "stats": {
                    "tool": {
                        **stats,
                        "prompts": texts,
                        "model": MODEL_NAME,
                        "diffusion_steps": int(req.diffusion_steps),
                        "postprocess": postprocess,
                        "postprocess_unavailable": bool(req.postprocess) and not HAS_MOTION_CORRECTION,
                        "seed": req.seed,
                    },
                },
            }
        except Exception as exc:  # noqa: BLE001 - surfaced to the client as an error event
            print(traceback.format_exc(), file=sys.stderr)
            holder["error"] = f"Motion generation failed: {exc}"
        finally:
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def stream():
        yield _sse({"type": "progress", "stage": "start", "frac": 0.0, "message": "Starting..."})
        while True:
            try:
                item = events.get(timeout=15)
            except queue.Empty:
                # Loading the encoder or the model emits nothing for minutes;
                # keep bytes flowing so the Node proxy's body timeout holds off.
                yield ": keepalive\n\n"
                continue
            if item is None:
                break
            yield _sse(item)
        if "error" in holder:
            yield _sse({"type": "error", "detail": holder["error"]})
        else:
            yield _sse({"type": "done", **holder["payload"]})

    return StreamingResponse(stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


@app.post("/text-encoder/shutdown")
def shutdown_text_encoder() -> dict:
    """Free the encoder's ~16 GB now instead of waiting for the idle reaper."""
    _encoder_manager.shutdown()
    return {"status": "ok", "running": _encoder_manager.running}


if __name__ == "__main__":
    print(f"[motion-server] listening on http://{HOST}:{PORT}  (model={MODEL_NAME}, device={_model_device})")
    print(f"[motion-server] checkpoints: {CHECKPOINT_DIR}")
    print(f"[motion-server] text encoder: {TEXT_ENCODER_URL} on {TEXT_ENCODER_DEVICE}")
    if not torch.cuda.is_available():
        print("[motion-server] WARNING: torch cannot see a CUDA GPU — generating on the CPU, "
              "which takes minutes per clip. Reinstall torch with "
              "'uv pip install --reinstall-package torch torch --index-url "
              "https://download.pytorch.org/whl/cuXXX'.", file=sys.stderr)
    if not HAS_MOTION_CORRECTION:
        print("[motion-server] motion_correction not installed -- foot-skate cleanup disabled. "
              "Build it with: pip install --no-deps ./MotionCorrection", file=sys.stderr)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
