@echo off
REM Gera o executavel do RPA Ops Monitor para Windows: uma PASTA com o .exe
REM dentro (dist\RPA_Ops_Monitor\RPA_Ops_Monitor.exe), nao um arquivo unico
REM (pasta abre mais rapido e tem bem menos chance de antivirus/EDR
REM corporativo barrar do que o modo "onefile" auto-extraivel).
REM
REM Rode este script de novo sempre que atualizar o codigo (server.py, os
REM HTMLs, assets\) para regerar o executavel com a versao nova - ele NUNCA
REM apaga config\ nem logs\ ja existentes dentro de dist\RPA_Ops_Monitor\
REM (so copia na primeira vez), entao dados reais do usuario sobrevivem a
REM um rebuild.
REM
REM Uso: de dois cliques neste arquivo, ou rode pelo prompt de comando.
REM Exige Python 3 instalado (python.org ou Microsoft Store).

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set PKG_DIR=packaging
set DIST_DIR=dist\RPA_Ops_Monitor
set VENV_DIR=.venv-build

echo == RPA Ops Monitor - build Windows ==

where py >nul 2>nul
if %errorlevel%==0 (
    set PYCMD=py -3
) else (
    set PYCMD=python
)

%PYCMD% -m venv "%VENV_DIR%"
if errorlevel 1 (
    echo Falha ao criar o ambiente virtual. Confirme que o Python 3 esta instalado.
    exit /b 1
)

call "%VENV_DIR%\Scripts\activate.bat"
pip install --quiet --upgrade pip pyinstaller pillow
if errorlevel 1 (
    echo Falha ao instalar o PyInstaller.
    exit /b 1
)

REM Reconstrói o ícone-fonte versionado em Base64 e gera um ICO
REM MULTIRRESOLUÇÃO (16/20/24/32/40/48/64/128/256). O arquivo anterior
REM continha essencialmente a imagem grande; alguns Explorers do Windows
REM acabavam exibindo o ícone genérico em tamanhos menores.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$b64 = Get-Content -Raw '%PKG_DIR%\RPA_Ops_Monitor.ico.b64'; [IO.File]::WriteAllBytes('%PKG_DIR%\RPA_Ops_Monitor.source.ico', [Convert]::FromBase64String($b64.Trim()))"
if errorlevel 1 (
    echo Falha ao preparar o icone-fonte do aplicativo.
    exit /b 1
)

python -c "from PIL import Image; p=r'%PKG_DIR%\RPA_Ops_Monitor.source.ico'; o=r'%PKG_DIR%\RPA_Ops_Monitor.ico'; im=Image.open(p).convert('RGBA'); im.save(o, format='ICO', sizes=[(16,16),(20,20),(24,24),(32,32),(40,40),(48,48),(64,64),(128,128),(256,256)])"
if errorlevel 1 (
    del /q "%PKG_DIR%\RPA_Ops_Monitor.source.ico" >nul 2>nul
    echo Falha ao gerar o icone multirresolucao.
    exit /b 1
)

pyinstaller --noconfirm --clean "%PKG_DIR%\RPA_Ops_Monitor.spec"
if errorlevel 1 (
    del /q "%PKG_DIR%\RPA_Ops_Monitor.ico" >nul 2>nul
    del /q "%PKG_DIR%\RPA_Ops_Monitor.source.ico" >nul 2>nul
    echo Falha ao gerar o executavel.
    exit /b 1
)

del /q "%PKG_DIR%\RPA_Ops_Monitor.ico" >nul 2>nul
del /q "%PKG_DIR%\RPA_Ops_Monitor.source.ico" >nul 2>nul

REM config\ e logs\ sao dados do usuario (graváveis), nao parte do app -
REM nunca sobrescreve o que ja existe la (preserva Cadastro de RPAs e logs
REM reais entre atualizacoes do executavel).
if not exist "%DIST_DIR%\config" xcopy /E /I /Q config "%DIST_DIR%\config" >nul
if not exist "%DIST_DIR%\logs"   xcopy /E /I /Q logs   "%DIST_DIR%\logs" >nul
if not exist "%DIST_DIR%\README.txt" copy README.txt "%DIST_DIR%\README.txt" >nul

call "%VENV_DIR%\Scripts\deactivate.bat"

echo == Pronto: %DIST_DIR%\RPA_Ops_Monitor.exe ==
endlocal
