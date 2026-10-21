@echo off
chcp 65001 >nul
title Sherpa-ONNX TTS Server

echo Đang khởi động môi trường và Server TTS...
py local_tts_server.py

pause
