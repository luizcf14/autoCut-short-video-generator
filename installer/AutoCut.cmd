@echo off
title AutoCut
cd /d "%~dp0"

rem Primeira execucao: cria as configuracoes e a pasta de videos.
if not exist ".env" copy ".env.example" ".env" >nul
if not exist "videos" mkdir "videos"

set NODE_ENV=production
set AUTOCUT_OPEN_BROWSER=1
set PATH=%~dp0node;%PATH%

echo Iniciando o AutoCut...
"%~dp0node\node.exe" "%~dp0node_modules\tsx\dist\cli.mjs" "src\server\index.ts"
if errorlevel 1 (
  echo.
  echo O AutoCut parou com um erro. Copie a mensagem acima se precisar de ajuda.
  pause
)
