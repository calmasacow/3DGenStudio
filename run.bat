@echo off
:: Start the dev server in a minimized window, redirecting all output to a log
:: file. This avoids the Windows "QuickEdit Mode" trap (clicking the console
:: window pauses Node) and slow legacy-console rendering, both of which make the
:: app feel extremely slow when launched from a .bat instead of a real terminal.
start "3DGenStudio Dev" /min cmd /c "npm run dev > dev.log 2>&1"

:: Start the Python mesh-tools service (Auto UV / Auto Retopo) the same way.
:: Its run.bat creates a venv and installs deps on first launch, so the very
:: first run can take a few minutes; output goes to python-server\python-server.log.
start "3DGenStudio Python" /min cmd /c "cd /d "%~dp0python-server" && run.bat > python-server.log 2>&1"

:: Start the SkinTokens rigging service (Auto Rig, port 8300) the same way. Its
:: run_server.bat builds a venv + installs torch/flash-attn/model on first launch,
:: so the FIRST run can take a long while (multi-GB download); output goes to
:: thirdparty\skintokens\rig-server.log. Needs an NVIDIA GPU (>=14 GB).
start "3DGenStudio Rigging" /min cmd /c "cd /d "%~dp0thirdparty\skintokens" && run_server.bat > rig-server.log 2>&1"

:: Start the Kimodo text-to-motion service (Auto Rig > Kimodo, port 8400) the same
:: way. Its run_server.bat builds a venv + installs torch, the checkpoint (1.1 GB)
:: and the LLM2Vec text encoder (~16 GB) on first launch, so the FIRST run takes a
:: long while; output goes to thirdparty\kimodo\kimodo-server.log. Needs an NVIDIA
:: GPU; the text encoder runs on the CPU in its own process and is freed when idle.
start "3DGenStudio Kimodo" /min cmd /c "cd /d "%~dp0thirdparty\kimodo" && run_server.bat > kimodo-server.log 2>&1"

:: Wait a few seconds to let Vite + the backend spin up
timeout /t 3 /nobreak >nul

:: Open the frontend in the default browser
start http://localhost:5173
