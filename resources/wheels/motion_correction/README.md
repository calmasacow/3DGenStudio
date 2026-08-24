# Prebuilt `motion_correction` wheels

Kimodo's foot-skate cleanup is a C++ extension (`thirdparty/kimodo/MotionCorrection`).
Building it from source needs CMake, a C++17 compiler, Python headers **and** git plus
network access (its CMakeLists fetches pybind11 and Eigen) — which almost no end user
has, so the install step failed silently and every generated clip skipped
post-processing.

These wheels are built once per platform and installed by `installPrebuiltWheel()` in
`electron/pysetup.cjs`, which falls back to the source build only if no wheel installs
**and imports**. Keep them in sync with `PYVER` in that file (currently Python
**3.13** → `cp313`).

| Wheel | Built on | Loads on |
| :--- | :--- | :--- |
| `…-cp313-cp313-win_amd64.whl` | Windows, MSVC, **static CRT** | any Windows x64 with AVX |
| `…-cp313-cp313-linux_x86_64.whl` | WSL Ubuntu 22.04 | glibc ≥ 2.34 — Ubuntu 22.04+, Debian 12+, RHEL 9+ |

## The two traps

**1. `setup.py` passes `-DPYTHON_EXECUTABLE`, which modern CMake ignores.** That is the
deprecated hint from `FindPythonLibs`; the CMakeLists uses `FindPython3`, which does not
read it. CMake then searches on its own, finds the distro's `/usr/bin/python3`, and
fails with *"Could NOT find Python3 (missing: Python3_INCLUDE_DIRS Development)"* — or,
worse, succeeds and silently builds against the wrong interpreter. Hand it the right one
through a toolchain file, which is one of the few things CMake reads from the
environment.

**2. `ldd` does not tell you the glibc floor.** It resolves against the machine that
built the wheel, so it always looks fine. What matters is the highest versioned symbol
the `.so` requires:

```bash
objdump -T <the .so> | grep -oE "GLIBC_[0-9]+\.[0-9]+" | sort -uV | tail -1
```

Measured: built on Ubuntu 26.04 the extension needs **GLIBC_2.43** (loads on 26.04 and
nothing older); on Ubuntu 22.04, **GLIBC_2.34**. A too-new wheel installs and then fails
to import, which `installPrebuiltWheel` detects, rolls back, and falls through — safe,
but useless. Build on the oldest glibc you intend to support.

## Rebuilding

Both commands build out of tree and leave the repo untouched.

### Windows (x64)

Needs Visual Studio Build Tools (C++ workload) and CMake.

```bash
REPO=$(pwd)
OUT="$REPO/resources/wheels/motion_correction"
TMP=$(mktemp -d)
cp -r "$REPO/thirdparty/kimodo/MotionCorrection" "$TMP/src" && rm -rf "$TMP/src/build"
uv venv "$TMP/venv" --python 3.13
uv pip install --python "$TMP/venv/Scripts/python.exe" setuptools wheel pybind11
PY="$TMP/venv/Scripts/python.exe"
cat > "$TMP/toolchain.cmake" <<'CMAKE'
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded" CACHE STRING "" FORCE)
CMAKE
cd "$TMP/src" && \
  CMAKE_TOOLCHAIN_FILE="$TMP/toolchain.cmake" \
  CMAKE_PREFIX_PATH="$("$PY" -c 'import pybind11;print(pybind11.get_cmake_dir())')" \
  CMAKE_POLICY_VERSION_MINIMUM=3.5 \
  "$PY" setup.py bdist_wheel -d "$OUT"
```

The **static CRT** is deliberate. Without it the extension imports `msvcp140.dll`, which
uv's managed CPython does *not* bundle (it ships only `vcruntime140*.dll`), so the wheel
would fail to load on any machine without the Visual C++ redistributable — exactly the
machine this whole exercise exists for. Static linking is safe for this module: numpy
buffers are mutated in place, pybind11 translates the C++ exceptions inside the module,
and no allocation crosses the boundary. Verify with:

```bash
grep -a -o -E "[A-Za-z0-9_-]+\.dll" <the .pyd> | sort -u   # expect only kernel32 + python313
```

### Linux (x86_64)

Needs `build-essential cmake git libeigen3-dev` (Eigen from apt avoids the GitLab
fetch). Note the toolchain file — that is trap 1 above.

```bash
sudo apt-get install -y build-essential cmake git libeigen3-dev
REPO=/mnt/c/Git/3DGenStudio          # or wherever the repo is
OUT="$REPO/resources/wheels/motion_correction"
TMP=$(mktemp -d)
cp -r "$REPO/thirdparty/kimodo/MotionCorrection" "$TMP/src" && rm -rf "$TMP/src/build"
uv venv "$TMP/venv" --python 3.13
uv pip install --python "$TMP/venv/bin/python" setuptools wheel pybind11
PY="$TMP/venv/bin/python"
printf 'set(Python3_EXECUTABLE "%s" CACHE FILEPATH "" FORCE)\n' "$PY" > "$TMP/toolchain.cmake"
cd "$TMP/src" && \
  CMAKE_TOOLCHAIN_FILE="$TMP/toolchain.cmake" \
  CMAKE_PREFIX_PATH="$("$PY" -c 'import pybind11;print(pybind11.get_cmake_dir())')" \
  CMAKE_POLICY_VERSION_MINIMUM=3.5 \
  "$PY" setup.py bdist_wheel -d "$OUT"
```

Verify — **install first, then import** (an import test before installing only proves
the module is not on `sys.path`):

```bash
uv pip install --python "$PY" --no-deps "$OUT"/*linux_x86_64.whl
"$PY" -c "import motion_correction; print(dir(motion_correction))"
```

### Linux, portable (manylinux) — blocked, needs a source change

A `manylinux_2_28` build (glibc 2.28: RHEL 8, Ubuntu 20.04, Debian 10) does **not** work
as-is, and the reason is worth writing down. Line 8 of the CMakeLists asks for:

```cmake
find_package(Python3 COMPONENTS Interpreter Development REQUIRED)
```

`Development` demands a **libpython to link against**, and manylinux images ship none —
neither shared nor static, deliberately, because an extension must resolve its symbols
from the interpreter that loads it. Configure therefore fails with *"Could NOT find
Python3 (missing: Python3_LIBRARIES Development)"* whichever interpreter you point it at
(the image's own and a uv-managed one were both tried; `Python3_USE_STATIC_LIBS` does
not help — there is no `libpython3.13.a` either).

The correct component for an extension module is `Development.Module`, which needs
headers only. Conditional, so CMake 3.15–3.17 keeps working:

```cmake
if(CMAKE_VERSION VERSION_GREATER_EQUAL 3.18)
  find_package(Python3 COMPONENTS Interpreter Development.Module REQUIRED)
else()
  find_package(Python3 COMPONENTS Interpreter Development REQUIRED)
endif()
```

That is a patch to vendored third-party source — a deliberate decision, since it has to
be re-applied whenever Kimodo is updated. Until it is made, the Ubuntu 22.04 wheel
(glibc 2.34) is what ships, and older distros fall back to the from-source build. With
the patch, the container build is:

```bash
docker run --rm -v "C:/Git/3DGenStudio:/repo" quay.io/pypa/manylinux_2_28_x86_64 bash -c '
  set -e
  PY=/opt/python/cp313-cp313/bin/python
  $PY -m pip install -q setuptools wheel pybind11
  cp -r /repo/thirdparty/kimodo/MotionCorrection /tmp/src && rm -rf /tmp/src/build
  printf "set(Python3_EXECUTABLE \"%s\" CACHE FILEPATH \"\" FORCE)\n" "$PY" > /tmp/tc.cmake
  cd /tmp/src && CMAKE_TOOLCHAIN_FILE=/tmp/tc.cmake \
    CMAKE_PREFIX_PATH=$($PY -c "import pybind11;print(pybind11.get_cmake_dir())") \
    CMAKE_POLICY_VERSION_MINIMUM=3.5 $PY setup.py bdist_wheel -d /tmp/raw
  auditwheel repair /tmp/raw/*.whl -w /repo/resources/wheels/motion_correction'
```

`auditwheel repair` is what retags it `manylinux_2_28_x86_64` (and verifies the external
dependencies); a plain `bdist_wheel` only ever produces `linux_x86_64`. When both a
`manylinux` and a bare `linux` wheel are present the installer tries the manylinux one
first — see `platformScore` in `electron/pysetup.cjs`.

Windows needs no equivalent of this: `libpython313.lib` ships with every CPython
distribution, so `Development` resolves there.
