@echo off
chcp 65001 >nul
title Sherpa-ONNX TTS Server
setlocal

cd /d "%~dp0"

set VENV_DIR=.venv
rem Stamp theo ma bam cua requirements.txt: doi thu vien thi tu cai lai tren .venv cu.
set REQ_HASH=
for /f "skip=1 tokens=*" %%H in ('certutil -hashfile requirements.txt SHA1') do if not defined REQ_HASH set REQ_HASH=%%H
if not defined REQ_HASH (
    echo [LOI] Khong tinh duoc ma bam cua requirements.txt.
    pause
    exit /b 1
)
set REQ_HASH=%REQ_HASH: =%
set STAMP_FILE=%VENV_DIR%\.deps_%REQ_HASH%

where py >nul 2>nul
if errorlevel 1 (
    echo [LOI] Khong tim thay Python Launcher ^(py^) tren may nay.
    echo Vui long cai Python tu https://www.python.org/downloads/ ^(nho tick "Add python.exe to PATH"^).
    pause
    exit /b 1
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo Dang tao moi truong ao Python lan dau...
    py -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [LOI] Khong tao duoc virtual environment.
        pause
        exit /b 1
    )
)

if not exist "%STAMP_FILE%" (
    echo Dang cai dat thu vien can thiet ^(chi chay 1 lan^)...
    "%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip >nul
    "%VENV_DIR%\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [LOI] Cai dat thu vien that bai. Kiem tra ket noi mang roi thu lai.
        pause
        exit /b 1
    )
    echo ok > "%STAMP_FILE%"
)

echo Dang khoi dong moi truong va Server TTS...
"%VENV_DIR%\Scripts\python.exe" local_tts_server.py

pause
