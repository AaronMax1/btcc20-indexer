@echo off
setlocal
cd /d "%~dp0"

if "%BTCC20_AGENT_HOST%"=="" set BTCC20_AGENT_HOST=127.0.0.1
if "%BTCC20_AGENT_PORT%"=="" set BTCC20_AGENT_PORT=28798
if "%BTCC20_AGENT_RPC_URL%"=="" set BTCC20_AGENT_RPC_URL=http://127.0.0.1:28476
if "%BTCC20_AGENT_RPC_USER%"=="" set BTCC20_AGENT_RPC_USER=user
if "%BTCC20_AGENT_RPC_PASSWORD%"=="" set BTCC20_AGENT_RPC_PASSWORD=pass
if "%BTCC20_AGENT_WALLET%"=="" set BTCC20_AGENT_WALLET=miner
if "%BTCC20_AGENT_DRY_RUN%"=="" set BTCC20_AGENT_DRY_RUN=0
if "%BTCC20_AGENT_ORD%"=="" set BTCC20_AGENT_ORD=%~dp0ord.exe

echo BTCC-20 Agent starting...
echo RPC:    %BTCC20_AGENT_RPC_URL%
echo Wallet: %BTCC20_AGENT_WALLET%
echo Mode:   LIVE
echo ORD:    %BTCC20_AGENT_ORD%
echo.

node -e "fetch('http://127.0.0.1:28798/health').then(r=>r.json()).then(j=>{console.log('BTCC-20 Agent is already running.'); console.log('Mode: '+(j.dry_run?'DRY RUN':'LIVE')); console.log('RPC:  '+j.rpc_url); process.exit(17)}).catch(()=>process.exit(0))"
if "%ERRORLEVEL%"=="17" (
  echo.
  echo Existing agent is ready. Close this window or stop the old agent first.
  pause
  exit /b 0
)

node agent.mjs
echo.
echo Agent stopped with exit code %ERRORLEVEL%.
pause
