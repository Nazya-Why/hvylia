@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Перший запуск: встановлюю залежності...
  python -m venv .venv || goto :err
  .venv\Scripts\python -m pip install -q -r requirements.txt || goto :err
)
.venv\Scripts\python -m pip install -q -U yt-dlp >nul 2>&1
.venv\Scripts\python server.py
pause
exit /b
:err
echo Помилка. Перевір, що встановлено Python 3.10+ (python.org).
pause
