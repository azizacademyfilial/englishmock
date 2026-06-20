@echo off
cd /d %~dp0
echo Installing backend packages...
npm install --no-audit --no-fund --progress=false
echo Starting backend...
npm run dev
pause
