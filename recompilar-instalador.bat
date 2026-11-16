@echo off
title AutoCut - Recompilar Instalador
cd /d "%~dp0"

echo Recompilando o instalador do AutoCut...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\rebuild.ps1" %*
if errorlevel 1 (
  echo.
  echo Falha ao recompilar o instalador.
  echo Dica: se o NSIS nao estiver instalado, rode: recompilar-instalador.bat -InstallNsis
  pause
  exit /b 1
)

echo.
pause
