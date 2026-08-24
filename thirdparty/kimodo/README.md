# Kimodo motion-generation service

Text-to-motion for 3D Gen Studio, wrapping [NVIDIA Kimodo](https://research.nvidia.com/labs/sil/projects/kimodo/).
Used by **Mesh Editor → Auto Rig → Kimodo**: type a prompt, get an animation
retargeted onto your rigged mesh.

Upstream (Apache-2.0) is vendored under `kimodo/` and `MotionCorrection/` and left
pristine so it can be updated from the NVIDIA repo. Everything 3D Gen Studio adds
lives in the files at this level.

| File | What it is |
|---|---|
| `motion_server.py` | The service. FastAPI on **:8400**, SSE, mirrors `thirdparty/skintokens/rig_server.py`'s contract. |
| `text_encoder_server.py` | The LLM2Vec sidecar on **:9550**. Started on demand by the service, reaped when idle. |
| `motion_export.py` | One generated sample → BVH, plus the in-place conversion. |
| `download.py` | Fetches the checkpoint (1.1 GB) and the text encoder (~16 GB). |
| `run_server.bat` / `.sh` | First-run setup (uv venv, deps, torch, weights) then start. |

## Setup

```
run_server.bat        # Windows
./run_server.sh       # Linux
```

First run provisions Python 3.13 via `uv`, installs `requirements.txt`, picks a
CUDA-matched torch, installs the vendored package, installs `MotionCorrection`, and
downloads the weights. Afterwards it just starts the service.

Configure the URL/port in **Settings → Motion Generation (Python) Connection**.

## Why this is its own service and its own venv

Kimodo's vendored LLM2Vec makes the Llama text encoder bidirectional by overriding
`LlamaModel._update_causal_mask`. From transformers ~5.2 onward `LlamaModel.forward`
calls the module-level `create_causal_mask()` and **never calls that override**, so
it becomes dead code and the encoder silently runs *causally* — plausible-looking
embeddings, no error, quietly worse motion.

So `transformers==5.1.0` is pinned and load-bearing. The rigging venv runs 5.13,
which is why these cannot share one environment. **Do not bump that pin** without
verifying bidirectionality still holds.

## The text encoder

The "~17 GB of VRAM" in Kimodo's docs is almost entirely the text encoder:
LLM2Vec wraps Meta-Llama-3-8B (~16 GB), against Kimodo's own 1.1 GB checkpoint.

Here it runs **on the CPU, in a separate process**:

* GPU use stays under ~3 GB, so rigging and ComfyUI keep their VRAM.
* A process can be killed, returning its ~16 GB of RSS to the OS in a way an
  in-process `del` does not. It is reaped after 10 minutes idle
  (`KIMODO_TEXT_ENCODER_IDLE`), or immediately via `POST /text-encoder/shutdown`.
* Kimodo wants exactly one 4096-float vector per prompt — 16 KB — so embeddings
  are cached under `cache/text-embeddings/`. Re-running a prompt you have used
  before never restarts the encoder at all.

Set `TEXT_ENCODER_DEVICE=cuda` to run it on the GPU instead.

### Getting the base weights (the gated part)

LLM2Vec is **two small ungated LoRA adapters over Llama-3-8B-Instruct**. Only the
base weights are big, and only the base is gated — so a first run fails with a 403
on `meta-llama/Meta-Llama-3-8B-Instruct` even though everything else downloaded
fine. Two ways through:

1. Request access at <https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct>
   (usually granted quickly), then `hf auth login` inside `.venv`.
2. Point at an ungated mirror of the same weights:
   `set KIMODO_LLAMA_BASE=NousResearch/Meta-Llama-3-8B-Instruct`

Option 2 works by copying the MNTP adapter locally and rewriting one field in its
`adapter_config.json`, so all of upstream's loading code runs unchanged. It also
force-pins `config._name_or_path` to the canonical `meta-llama/...` string,
because LLM2Vec applies the Llama-3 chat template **only** when that field matches
exactly (`prepare_for_tokenization`) — loading from a mirror naively would skip the
wrapper and silently change every embedding.

### There is no quantization option (tried, removed)

The encoder runs bf16 on the CPU. Both bitsandbytes modes were implemented and
both failed at the same line — `llm2vec.py` `from_pretrained` →
`model_class.from_pretrained`, while loading the MNTP LoRA onto quantized layers:

| Mode | Failure |
|---|---|
| `8bit` | ``layers.0.self_attn.q_proj.base_layer.SCB is neither a parameter, buffer, nor extra state`` — LLM.int8 keeps its column scales in a plain attribute, not a registered buffer. |
| `4bit` | ``weight is not an nn.Module`` — `Params4bit` trips the submodule walk. |

The root cause is shared: LLM2Vec attaches the MNTP LoRA and then calls
`merge_and_unload()`, and bitsandbytes layers cannot survive that in this
transformers 5.1 / peft 0.20 stack. Merging in bf16 *first* and quantizing after
would work, but it needs the full ~16 GB resident to do the merge — exactly the
cost quantization was meant to avoid.

`KIMODO_TEXT_ENCODER_QUANT` is ignored; the service logs a line if it is still set.

### Why not a GGUF either

Tempting, since a Q8_0 build is ~8 GB and ungated — but it cannot work:

* LLM2Vec's entire mechanism is *bidirectional* attention (`LlamaBiModel` deletes
  the causal mask). llama.cpp's Llama graph is causal-only, so a GGUF returns
  causal embeddings — wrong, with no error.
* Two PEFT adapters have to be applied in the transformers module tree; GGUF
  cannot take HF LoRA adapters.
* `transformers` can read a GGUF via `gguf_file=`, but it *dequantizes* on load,
  so there is no memory saving anyway.
* The community GGUF repos contain only `.gguf` files — no `config.json`,
  no tokenizer — so `LLM2Vec.from_pretrained` cannot even open them.

A **GGUF build cannot be substituted**, tempting as it looks:

* LLM2Vec's entire mechanism is *bidirectional* attention (`LlamaBiModel` deletes
  the causal mask). llama.cpp's Llama graph is causal-only, so a GGUF returns
  causal embeddings — wrong, with no error.
* Two PEFT adapters have to be applied in the transformers module tree; GGUF
  cannot take HF LoRA adapters.
* `transformers` can read a GGUF via `gguf_file=`, but it *dequantizes* on load,
  so there is no memory saving anyway.
* The community GGUF repos contain only `.gguf` files — no `config.json`,
  no tokenizer — so `LLM2Vec.from_pretrained` cannot even open them.

bitsandbytes is the right tool here precisely because it stays inside the
transformers graph, keeping bidirectional attention and PEFT intact.

## Endpoints

| | |
|---|---|
| `GET /health` | Model/encoder state, checkpoint presence, whether `motion_correction` built. |
| `GET /motions/skeleton` | The SOMA-77 skeleton at rest, as BVH. No model load — lets the browser offer bone mapping before the first generation. |
| `POST /motions/generate` | `{prompt, duration, in_place, seed, diffusion_steps, postprocess, keep_loaded}` → SSE → BVH. |
| `POST /text-encoder/shutdown` | Free the encoder's RAM now. |

## Notes on output

* **BVH, not GLB.** SOMA-77 bone names are near-Mixamo, and three's `BVHLoader`
  yields a skeleton plus a clip whose tracks bind by node name — exactly what
  `src/utils/animationLibrary.js` already retargets. No Blender round-trip.
* **10 s per sentence** is the model's own ceiling. Longer sequences come from
  chaining sentences (`"A person walks. The person stops."`), which the service
  generates in turn and blends.
* **In-place** subtracts the model's own `smooth_root_pos` drift rather than
  pinning the hips, so the walk keeps its weight shift and sway. Vertical motion
  and rotation are untouched — jumps still leave the ground, turns still turn.
* **Fingers are never animated.** The checkpoint denoises the 30-joint SOMA
  skeleton and fills the finger chains from a fixed relaxed-hand pose, so the
  browser deliberately leaves them out of the bone map and the target rig keeps
  its own hands.

## MotionCorrection is optional

The C++/pybind11 foot-skate cleanup is installed from a **prebuilt wheel** in
`resources/wheels/motion_correction/` when one matches the platform — that is the
normal path, and it needs no compiler. `run_server.bat` / `run_server.sh` and the
desktop installer all try the wheel first and only then fall back to building from
source, which needs CMake, a C++17 compiler **and** git + network access (the
CMakeLists fetches pybind11 and Eigen).

If neither works the service starts anyway, `/health` reports
`"motion_correction": false`, and generation skips post-processing (expect some foot
sliding). To add it later, either install a wheel:

```
uv pip install --no-deps ../../resources/wheels/motion_correction/<matching>.whl
```

…or build it:

```
pip install --no-deps ./MotionCorrection
```

See `resources/wheels/motion_correction/README.md` for how the wheels are built and
which platforms each one covers.
