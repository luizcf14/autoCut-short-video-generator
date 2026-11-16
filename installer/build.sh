#!/usr/bin/env bash
# Gera o instalador do AutoCut para Windows (x64) a partir do Linux ou do WSL.
# Requer: node/npm, makensis (apt install nsis) e acesso ao registro do npm e ao GitHub.
# Uso: bash installer/build.sh   ->  installer/out/AutoCut-Setup-<versão>.exe
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/installer"
BUILD="${BUILD_DIR:-$HERE/.build}"
STAGE="$BUILD/stage"
OUT="$HERE/out"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NODE_VERSION="${NODE_WIN_VERSION:-$(node -p 'process.versions.node')}"

echo "== AutoCut $VERSION | Node.js para Windows $NODE_VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT" "$BUILD/dl"

echo "== 1/6 Compilando a tela (vite build)"
(cd "$ROOT" && npx vite build --logLevel warn)

echo "== 2/6 Copiando o código"
cp -r "$ROOT/src" "$ROOT/dist" "$ROOT/estilos" "$STAGE/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/tsconfig.json" "$ROOT/.env.example" "$ROOT/README.md" "$STAGE/"
cp "$HERE/AutoCut.cmd" "$HERE/LEIA-ME.txt" "$HERE/autocut.ico" "$HERE/ensure-browser.cjs" "$STAGE/"

echo "== 3/6 Instalando as dependências para Windows x64"
# --os/--cpu escolhem os binários de Windows (esbuild, compositor do Remotion).
# --ignore-scripts: os scripts de instalação rodariam para Linux; o do ffmpeg roda abaixo.
(cd "$STAGE" && npm ci --omit=dev --os=win32 --cpu=x64 --ignore-scripts --no-audit --no-fund --loglevel=error)
(cd "$STAGE" && npm_config_platform=win32 npm_config_arch=x64 node node_modules/ffmpeg-static/install.js)
test -f "$STAGE/node_modules/ffmpeg-static/ffmpeg.exe"
test -f "$STAGE/node_modules/@remotion/compositor-win32-x64-msvc/remotion.exe"
test -d "$STAGE/node_modules/@esbuild/win32-x64"
# Binários de outras plataformas que tenham vindo por engano.
rm -rf "$STAGE"/node_modules/@remotion/compositor-{linux,darwin}* "$STAGE"/node_modules/@esbuild/{linux,darwin}* || true

echo "== 4/6 Node.js para Windows (pacote node-win-x64 do npm)"
if [ ! -f "$BUILD/dl/node-win-x64-$NODE_VERSION.tgz" ]; then
  (cd "$BUILD/dl" && npm pack "node-win-x64@$NODE_VERSION" --silent >/dev/null)
fi
mkdir -p "$STAGE/node"
tar xzf "$BUILD/dl/node-win-x64-$NODE_VERSION.tgz" -C "$BUILD/dl" package/bin/node.exe
mv "$BUILD/dl/package/bin/node.exe" "$STAGE/node/node.exe"

echo "== 5/6 Ajustes para Windows"
# Quebras de linha do Windows nos arquivos que o usuário abre ou o cmd executa.
for f in AutoCut.cmd LEIA-ME.txt .env.example; do sed -i 's/\r\?$/\r/' "$STAGE/$f"; done
# Atalho para a tela de desenvolvimento não faz sentido aqui.
rm -f "$STAGE/iniciar.bat"
du -sh "$STAGE"

echo "== 6/6 Gerando o instalador (makensis)"
makensis -V2 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DOUTFILE="$OUT/AutoCut-Setup-$VERSION.exe" "$HERE/autocut.nsi"
ls -lh "$OUT/AutoCut-Setup-$VERSION.exe"
