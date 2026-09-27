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
pip install --quiet --upgrade pip pyinstaller
if errorlevel 1 (
    echo Falha ao instalar o PyInstaller.
    exit /b 1
)

pyinstaller --noconfirm --clean "%PKG_DIR%\RPA_Ops_Monitor.spec"
if errorlevel 1 (
    echo Falha ao gerar o executavel.
    exit /b 1
)

REM config\ e logs\ sao dados do usuario (graváveis), nao parte do app -
REM nunca sobrescreve o que ja existe la (preserva Cadastro de RPAs e logs
REM reais entre atualizacoes do executavel).
if not exist "%DIST_DIR%\config" xcopy /E /I /Q config "%DIST_DIR%\config" >nul
if not exist "%DIST_DIR%\logs"   xcopy /E /I /Q logs   "%DIST_DIR%\logs" >nul
if not exist "%DIST_DIR%\README.txt" copy README.txt "%DIST_DIR%\README.txt" >nul

call "%VENV_DIR%\Scripts\deactivate.bat"

echo == Pronto: %DIST_DIR%\RPA_Ops_Monitor.exe ==
endlocal
