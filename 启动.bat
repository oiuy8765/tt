@echo off
chcp 65001 >nul
title Google Trends Rising Words Tool
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
  ) else (
    echo [ERROR] Node.js not found. Please install it from https://nodejs.org
    pause
    exit /b 1
  )
) else (
  set "NODE_EXE=node"
)

"%NODE_EXE%" server.js
pause
