@echo off
chcp 65001 >nul
rem Open the JEV retrieval console (2nd edition) in your default browser.
rem This launcher locates itself, so moving the folder will not break it.
cd /d "%~dp0"
start "" "index.html"
