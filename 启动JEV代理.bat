@echo off
chcp 65001 >nul
rem Start the optional local JEV proxy (zero dependency, Node 18+).
rem It listens on 127.0.0.1 only. API key is read from .env on the server side.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ first: https://nodejs.org
  pause
  exit /b 1
)

if not exist ".env" (
  if exist "env.example" (
    copy "env.example" ".env" >nul
    echo [!] .env was created from env.example.
    echo     Edit it and fill JEV_UPSTREAM_URL / JEV_MODEL / JEV_API_KEY before use.
    echo.
  )
)

node "server\jev-proxy.js"
pause
