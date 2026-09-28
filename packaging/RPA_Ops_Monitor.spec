# -*- mode: python ; coding: utf-8 -*-
#
# Spec do PyInstaller para empacotar o RPA Ops Monitor como um executável
# nativo (pasta com o .exe/binário dentro — "onedir", não arquivo único: mais
# rápido de abrir e com bem menos chance de antivírus/EDR corporativo barrar
# do que o modo "onefile" auto-extraível do PyInstaller).
#
# Roda em qualquer SO suportado pelo PyInstaller — mas o binário resultante
# só funciona no MESMO SO em que foi gerado (PyInstaller não faz cross-
# compile). Use packaging/build_windows.bat no Windows e
# packaging/build_macos.sh no macOS, ou o workflow do GitHub Actions
# (.github/workflows/build-executaveis.yml) para gerar os dois sem precisar
# ter as duas máquinas.
#
# Importante: config/ e logs/ NÃO entram aqui de propósito. Eles são dados
# do USUÁRIO (graváveis, precisam sobreviver a um rebuild), não parte do
# aplicativo — os scripts de build copiam essas duas pastas pra fora do
# bundle, direto pra dist/RPA_Ops_Monitor/, só na primeira vez (nunca
# sobrescrevem numa atualização). Ver a constante ROOT em server.py: em modo
# empacotado ela aponta pra pasta do executável real, nunca para dentro
# deste bundle.
from pathlib import Path
import sys

PROJECT_ROOT = Path(SPECPATH).resolve().parent
WINDOWS_ICON = PROJECT_ROOT / 'packaging' / 'RPA_Ops_Monitor.ico'

# assets/observability-data.js e assets/index-data.js são só o fallback
# estático usado quando alguém abre os HTMLs direto via file:// (sem
# servidor) — o servidor empacotado nunca lê esses arquivos (gera os dados
# na hora, a partir dos logs reais), então ficam de fora para não inchar o
# pacote (o primeiro sozinho tem ~15 MB).
EXCLUDED_ASSET_FILES = {'observability-data.js', 'index-data.js'}

datas = [
    (str(PROJECT_ROOT / 'index.html'), '.'),
    (str(PROJECT_ROOT / 'investigacao.html'), '.'),
    (str(PROJECT_ROOT / 'diagnostico.html'), '.'),
    (str(PROJECT_ROOT / 'rpa-dashboard.html'), '.'),
]
for f in sorted((PROJECT_ROOT / 'assets').iterdir()):
    if f.is_file() and f.name not in EXCLUDED_ASSET_FILES:
        datas.append((str(f), 'assets'))
# Todos os .html de docs/ (documentacao.html, servidor-em-rede.html, e
# qualquer um adicionado depois) — sem listar arquivo por arquivo.
for f in sorted((PROJECT_ROOT / 'docs').glob('*.html')):
    datas.append((str(f), 'docs'))

a = Analysis(
    [str(PROJECT_ROOT / 'server.py')],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='RPA_Ops_Monitor',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Ícone do app no Windows. O .ico é reconstruído pelo build_windows.bat
    # a partir do arquivo versionado RPA_Ops_Monitor.ico.b64.
    icon=str(WINDOWS_ICON) if sys.platform.startswith('win') and WINDOWS_ICON.is_file() else None,
    # Sem janela de terminal atrás do painel (server.py redireciona
    # stdout/stderr para RPA_Ops_Monitor.log ao lado do executável quando
    # roda nesse modo — ver o comentário logo no topo de server.py — então
    # o diagnóstico continua existindo, só que em arquivo em vez de janela).
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='RPA_Ops_Monitor',
)
