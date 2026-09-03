@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv || exit /b 1
)
call ".venv\Scripts\activate.bat"
python -m pip install -r requirements.txt || exit /b 1
if "%PORT%"=="" set PORT=8000
python app.py
