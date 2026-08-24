@echo off
:: Start the 3D Gen Studio motion-generation micro-service (motion_server.py).
::
:: On first run this uses `uv` to provision a pinned standalone Python (3.13),
:: create a local virtual environment, and install the stack: this folder's
:: requirements.txt, a CUDA-matched torch, the vendored Kimodo package, and the
:: model checkpoint.
::
:: Kimodo is installed with --no-deps against requirements.txt rather than from
:: its own pyproject: the vendored pyproject pulls the interactive demo's stack
:: (gradio, viser, trimesh, mujoco) that this headless service never imports.
::
:: MotionCorrection (the C++/pybind11 foot-skate cleanup) is installed SEPARATELY
:: from a prebuilt wheel in resources/wheels/, falling back to a source build. Both
:: are allowed to fail: building needs CMake, a C++17 compiler AND git + network
:: (its CMakeLists fetches pybind11 and Eigen), and the service runs fine without
:: it -- generation just skips post-processing.
::
:: Env overrides:
::   KIMODO_PORT=8400           bind port (also KIMODO_HOST)
::   KIMODO_CUDA=12.8           force the CUDA build to target (skip nvidia-smi)
::   TEXT_ENCODER_DEVICE=cuda   run the text encoder on the GPU (needs ~17 GB VRAM)
::   KIMODO_LLAMA_BASE=NousResearch/Meta-Llama-3-8B-Instruct
::                              ungated mirror of the gated Llama-3 base weights
::   KIMODO_CHECKPOINT_DIR=...  where the weights are kept (default ./checkpoints);
::                              holds BOTH the Kimodo checkpoint and the 16 GB
::                              Llama-3 base the text encoder loads
::   KIMODO_SKIP_MODEL=1        don't download the checkpoint
::   KIMODO_SKIP_ENCODER=1      don't pre-download the ~16 GB text encoder
:: Ungated mirror of the Llama-3 base weights the text encoder needs, so first
:: run does not 403 on the gated meta-llama repo. Remove this line if you have
:: been granted access there and have run `hf auth login`.
set KIMODO_LLAMA_BASE=NousResearch/Meta-Llama-3-8B-Instruct

setlocal enabledelayedexpansion
cd /d "%~dp0"
set "PYVER=3.13"

call :ensure_uv || goto :error

if not exist ".venv\Scripts\python.exe" (
  call :setup || goto :error
) else (
  call ".venv\Scripts\activate.bat"
)

python motion_server.py
goto :eof


:ensure_uv
set "UV="
where uv >nul 2>nul && set "UV=uv"
if not defined UV if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
if not defined UV (
  echo Installing uv ^(Python toolchain manager^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" || exit /b 1
  set "UV=%USERPROFILE%\.local\bin\uv.exe"
)
exit /b 0


:setup
echo Provisioning Python %PYVER% via uv...
"%UV%" python install %PYVER% || exit /b 1

echo Creating virtual environment ^(Python %PYVER%^)...
"%UV%" venv .venv --python %PYVER% || exit /b 1
call ".venv\Scripts\activate.bat"

echo.
echo Installing Kimodo service requirements...
"%UV%" pip install -r requirements.txt || exit /b 1

:: --- torch ------------------------------------------------------------------
:: Installed after requirements so nothing in that list can drag it off-version.
::
:: --reinstall-package torch is REQUIRED, not defensive. requirements.txt pulls
:: peft/accelerate, which depend on torch, so a CPU torch from PyPI is already
:: installed by the time we get here -- and the CUDA build carries the SAME
:: version number with a +cuXXX local tag, so uv considers the requirement
:: satisfied and prints "Audited 1 package" without installing anything. The
:: service then silently starts on the CPU.
echo.
echo Detecting CUDA to select a torch build...
set "TORCHARGS="
for /f "delims=" %%a in ('python select_torch.py') do set "TORCHARGS=%%a"
if defined TORCHARGS (
  echo Installing torch: !TORCHARGS!
  "%UV%" pip install --reinstall-package torch !TORCHARGS! || exit /b 1
) else (
  echo [warn] No NVIDIA GPU detected -- installing CPU torch.
  echo        Kimodo will be extremely slow without a CUDA GPU.
  "%UV%" pip install torch || exit /b 1
)

:: Fail loudly rather than starting a CPU service that looks like it works.
python -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>nul
if errorlevel 1 (
  echo.
  echo [warn] torch cannot see a CUDA GPU. Generation will run on the CPU and be
  echo        very slow. Check 'nvidia-smi', then reinstall torch with:
  echo          .venv\Scripts\activate ^&^& uv pip install --reinstall-package torch !TORCHARGS!
)

:: --- the vendored Kimodo package --------------------------------------------
:: SKIP_MOTION_CORRECTION_IN_SETUP keeps setup.py from bundling the CMake
:: extension here, so a machine with no compiler still gets a working install.
echo.
echo Installing the vendored Kimodo package...
set "SKIP_MOTION_CORRECTION_IN_SETUP=1"
"%UV%" pip install --no-deps -e . || exit /b 1

:: --- MotionCorrection (optional) --------------------------------------------
:: Prebuilt wheel first, source build second. The wheel in resources/wheels/ is
:: built with a static CRT so it needs no Visual C++ redistributable, and it is what
:: makes this step work on a machine with no compiler at all.
::
:: The IMPORT is what decides success, not the install: a wheel can install and
:: still fail to load (wrong ABI, missing system library), and leaving that in place
:: would shadow the source build with a broken module.
echo.
set "MC_WHEELS=%~dp0..\..\resources\wheels\motion_correction"
set "MC_OK="
for %%f in ("%MC_WHEELS%\*win_amd64.whl") do (
  if not defined MC_OK (
    echo Installing prebuilt %%~nxf ...
    "%UV%" pip install --no-deps "%%~ff" >nul 2>nul
    if not errorlevel 1 (
      python -c "import motion_correction" >nul 2>nul
      if not errorlevel 1 set "MC_OK=1"
    )
    if not defined MC_OK (
      echo [warn] %%~nxf installed but could not be imported here; removing it.
      "%UV%" pip uninstall motion_correction >nul 2>nul
    )
  )
)
if defined MC_OK (
  echo MotionCorrection installed from a prebuilt wheel -- no compiler needed.
) else (
  echo No usable prebuilt wheel found; building MotionCorrection from source...
  "%UV%" pip install --no-deps .\MotionCorrection
  if errorlevel 1 (
    echo [warn] MotionCorrection is not installed. Building it needs CMake, a C++17
    echo        compiler ^(Visual Studio Build Tools or MinGW-w64^) and git + network
    echo        access for pybind11/Eigen. The service still works; foot-skate
    echo        post-processing is disabled.
  )
)

:: --- weights ----------------------------------------------------------------
echo.
if defined KIMODO_SKIP_MODEL (
  echo KIMODO_SKIP_MODEL set -- skipping checkpoint download.
) else (
  echo Downloading the Kimodo checkpoint ^(1.1 GB; first run only^)...
  python download.py --model || echo [warn] checkpoint download failed; run "python download.py --model" manually.
)

echo.
if defined KIMODO_SKIP_ENCODER (
  echo KIMODO_SKIP_ENCODER set -- skipping text-encoder download.
  echo   It will be fetched on the first generation instead ^(~16 GB^).
) else (
  echo Downloading the text encoder ^(~16 GB; first run only, resumable^)...
  python download.py --text-encoder || echo [warn] text-encoder download failed; it will retry on first use.
)

echo.
echo Setup complete.
exit /b 0


:error
echo.
echo Setup failed. See the messages above.
exit /b 1
