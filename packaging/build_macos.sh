#!/bin/bash
# Gera o executável do RPA Ops Monitor para macOS: uma PASTA com o binário
# dentro (dist/RPA_Ops_Monitor/RPA_Ops_Monitor), não um app single-file.
#
# Rode este script de novo sempre que atualizar o código (server.py, os
# HTMLs, assets/) para regerar o executável com a versão nova — ele NUNCA
# apaga config/ nem logs/ já existentes dentro de dist/RPA_Ops_Monitor/
# (só copia na primeira vez), então dados reais do usuário sobrevivem a um
# rebuild.
#
# Uso:
#   ./packaging/build_macos.sh
#
# Sem código assinado (Apple Developer ID): na primeira abertura o macOS
# vai avisar "desenvolvedor não identificado" — clique com o botão direito
# no executável → Abrir, uma única vez.
set -euo pipefail
cd "$(dirname "$0")/.."   # volta pra raiz do projeto, não importa de onde foi chamado

PKG_DIR="packaging"
DIST_DIR="dist/RPA_Ops_Monitor"
VENV_DIR=".venv-build"

echo "== RPA Ops Monitor — build macOS =="

python3 -m venv "$VENV_DIR"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip pyinstaller

pyinstaller --noconfirm --clean "$PKG_DIR/RPA_Ops_Monitor.spec"

# config/ e logs/ são dados do usuário (graváveis), não parte do app — nunca
# sobrescreve o que já existe lá (preserva Cadastro de RPAs e logs reais
# entre atualizações do executável).
[ -d "$DIST_DIR/config" ] || cp -R config "$DIST_DIR/config"
[ -d "$DIST_DIR/logs" ]   || cp -R logs   "$DIST_DIR/logs"
[ -f "$DIST_DIR/README.txt" ] || cp README.txt "$DIST_DIR/README.txt"

deactivate

echo "== Pronto: $DIST_DIR/RPA_Ops_Monitor =="
