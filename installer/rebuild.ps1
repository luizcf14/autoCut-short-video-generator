# Recompila o instalador do AutoCut para Windows (x64).
# Funciona nativamente no Windows (Node.js + NSIS) ou via WSL (installer/build.sh).
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\rebuild.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\rebuild.ps1 -Clean
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\rebuild.ps1 -InstallNsis
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\rebuild.ps1 -UseWsl

param(
  [switch]$Clean,
  [switch]$UseWsl,
  [switch]$InstallNsis,
  [string]$NodeVersion = ""
)

$ErrorActionPreference = 'Stop'

$Root  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Here  = $PSScriptRoot
$Build = Join-Path $Here '.build'
$Stage = Join-Path $Build 'stage'
$Out   = Join-Path $Here 'out'

function Find-MakeNsis {
  $cmd = Get-Command makensis -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
    (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\NSIS\makensis.exe'),
    'C:\ProgramData\chocolatey\bin\makensis.exe',
    (Join-Path $env:USERPROFILE 'scoop\apps\nsis\current\makensis.exe')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Invoke-Checked {
  param([scriptblock]$Command, [string]$ErrorMessage)
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$ErrorMessage (codigo $LASTEXITCODE)"
  }
}

if ($Clean) {
  Write-Host '== Limpando pastas temporarias (installer/.build e installer/out)...'
  if (Test-Path $Build) { Remove-Item -Recurse -Force $Build }
  if (Test-Path $Out)   { Remove-Item -Recurse -Force $Out }
}

$Makensis = $null
if (-not $UseWsl) {
  $Makensis = Find-MakeNsis
  if (-not $Makensis -and $InstallNsis) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw 'winget nao encontrado para instalar o NSIS automaticamente. Instale em https://nsis.sourceforge.io/'
    }
    Write-Host '== Instalando NSIS via winget...'
    Invoke-Checked { winget install --id NSIS.NSIS -e --accept-source-agreements --accept-package-agreements } 'Falha ao instalar NSIS via winget'
    $Makensis = Find-MakeNsis
  }
}

# Fallback para WSL caso solicitado ou caso makensis nao esteja instalado no Windows
if ($UseWsl -or -not $Makensis) {
  if (Get-Command wsl -ErrorAction SilentlyContinue) {
    $wslCheck = wsl bash -lc "command -v makensis >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && echo OK" 2>$null
    if (($wslCheck | Out-String).Trim() -eq 'OK') {
      Write-Host '== Compilando instalador via WSL (installer/build.sh)...'
      $wslRoot = (wsl wslpath -a ($Root -replace '\\', '/')).Trim()
      Invoke-Checked { wsl bash -lc "cd '$wslRoot' && bash installer/build.sh" } 'Falha ao compilar o instalador no WSL'
      $latest = Get-ChildItem $Out -Filter 'AutoCut-Setup-*.exe' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($latest) {
        $sizeMb = [math]::Round($latest.Length / 1MB, 1)
        Write-Host "== Instalador pronto: $($latest.FullName) ($sizeMb MB)"
      }
      exit 0
    }
  }

  if ($UseWsl) {
    throw 'WSL com node/npm e nsis (sudo apt install nsis) nao encontrado.'
  }
  throw "NSIS (makensis.exe) nao encontrado. Instale com 'winget install NSIS.NSIS' (ou rode recompilar-instalador.bat -InstallNsis)."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js nao encontrado no PATH. Instale o Node.js 20+ em https://nodejs.org/'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm nao encontrado no PATH.'
}

$Pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$Version = $Pkg.version
$HostNodeVersion = (& node -p "process.versions.node").Trim()
$HostArch = (& node -p "process.arch").Trim()
$TargetNodeVersion = if ($NodeVersion) { $NodeVersion } else { $HostNodeVersion }

Write-Host "== AutoCut $Version | Node.js $TargetNodeVersion | NSIS: $Makensis"

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Write-Host '== Instalando dependencias do projeto raiz (npm ci)...'
  Push-Location $Root
  try {
    Invoke-Checked { npm ci } 'Falha ao instalar dependencias na raiz'
  } finally {
    Pop-Location
  }
}

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage, $Out, (Join-Path $Build 'dl') | Out-Null

Write-Host '== 1/6 Compilando a tela (vite build)'
Push-Location $Root
try {
  Invoke-Checked { npx vite build --logLevel warn } 'Falha ao compilar o front-end (vite build)'
} finally {
  Pop-Location
}

Write-Host '== 2/6 Copiando o codigo para o stage'
foreach ($dir in @('src', 'dist', 'estilos')) {
  Copy-Item -Recurse -Force (Join-Path $Root $dir) (Join-Path $Stage $dir)
}
foreach ($file in @('package.json', 'package-lock.json', 'tsconfig.json', '.env.example', 'README.md')) {
  Copy-Item -Force (Join-Path $Root $file) (Join-Path $Stage $file)
}
foreach ($file in @('AutoCut.cmd', 'LEIA-ME.txt', 'autocut.ico', 'ensure-browser.cjs')) {
  Copy-Item -Force (Join-Path $Here $file) (Join-Path $Stage $file)
}

Write-Host '== 3/6 Instalando as dependencias de producao para Windows x64'
Push-Location $Stage
try {
  Invoke-Checked {
    npm ci --omit=dev --os=win32 --cpu=x64 --ignore-scripts --no-audit --no-fund --loglevel=error
  } 'Falha no npm ci do stage'

  $prevPlatform = $env:npm_config_platform
  $prevArch = $env:npm_config_arch
  try {
    $env:npm_config_platform = 'win32'
    $env:npm_config_arch = 'x64'
    Invoke-Checked { node node_modules/ffmpeg-static/install.js } 'Falha ao baixar o ffmpeg para Windows'
  } finally {
    $env:npm_config_platform = $prevPlatform
    $env:npm_config_arch = $prevArch
  }
} finally {
  Pop-Location
}

$requiredPaths = @(
  (Join-Path $Stage 'node_modules\ffmpeg-static\ffmpeg.exe'),
  (Join-Path $Stage 'node_modules\@remotion\compositor-win32-x64-msvc\remotion.exe'),
  (Join-Path $Stage 'node_modules\@esbuild\win32-x64')
)
foreach ($req in $requiredPaths) {
  if (-not (Test-Path $req)) {
    throw "Dependencia obrigatoria ausente no stage: $req"
  }
}

Write-Host '== 4/6 Preparando Node.js para Windows x64'
$StageNodeDir = Join-Path $Stage 'node'
New-Item -ItemType Directory -Force -Path $StageNodeDir | Out-Null

if ((-not $NodeVersion) -and ($HostArch -eq 'x64')) {
  $HostNodeExe = (& node -p "process.execPath").Trim()
  Copy-Item -Force $HostNodeExe (Join-Path $StageNodeDir 'node.exe')
} else {
  $DlDir = Join-Path $Build 'dl'
  $Tgz = Join-Path $DlDir "node-win-x64-$TargetNodeVersion.tgz"
  if (-not (Test-Path $Tgz)) {
    Push-Location $DlDir
    try {
      Invoke-Checked { npm pack "node-win-x64@$TargetNodeVersion" --silent } 'Falha ao baixar node-win-x64'
    } finally {
      Pop-Location
    }
  }
  $PkgExtract = Join-Path $DlDir 'package'
  if (Test-Path $PkgExtract) { Remove-Item -Recurse -Force $PkgExtract }
  Invoke-Checked { tar -xzf $Tgz -C $DlDir package/bin/node.exe } 'Falha ao extrair node.exe'
  Move-Item -Force (Join-Path $DlDir 'package\bin\node.exe') (Join-Path $StageNodeDir 'node.exe')
  Remove-Item -Recurse -Force $PkgExtract -ErrorAction SilentlyContinue
}

Write-Host '== 5/6 Ajustando quebras de linha para Windows'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($f in @('AutoCut.cmd', 'LEIA-ME.txt', '.env.example')) {
  $fp = Join-Path $Stage $f
  $text = [System.IO.File]::ReadAllText($fp, $utf8NoBom)
  $text = $text -replace "`r?`n", "`r`n"
  [System.IO.File]::WriteAllText($fp, $text, $utf8NoBom)
}
$devBat = Join-Path $Stage 'iniciar.bat'
if (Test-Path $devBat) { Remove-Item -Force $devBat }

Write-Host '== 6/6 Gerando o instalador (makensis)'
$OutFile = Join-Path $Out "AutoCut-Setup-$Version.exe"
$NsiFile = Join-Path $Here 'autocut.nsi'
Invoke-Checked {
  & $Makensis /V2 "/DVERSION=$Version" "/DSTAGE=$Stage" "/DOUTFILE=$OutFile" $NsiFile
} 'Falha ao gerar o instalador com makensis'

if (-not (Test-Path $OutFile)) {
  throw "Instalador nao encontrado em $OutFile"
}

$FinalItem = Get-Item $OutFile
$SizeMb = [math]::Round($FinalItem.Length / 1MB, 1)
Write-Host ""
Write-Host "== Instalador gerado com sucesso!"
Write-Host "   Arquivo: $($FinalItem.FullName) ($SizeMb MB)"
