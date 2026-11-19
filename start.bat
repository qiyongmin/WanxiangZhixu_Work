@echo off
setlocal
set "kb_here=%~dp0"
rem SQLite cannot take file locks on a \\wsl.localhost share: Windows Python then reports
rem "database is locked" and every page is empty. Run inside WSL instead; WSL2 forwards
rem localhost, so http://localhost:<port>/ still works from Windows.
if /i "%kb_here:~0,5%"=="\\wsl" goto run_wsl
pushd "%~dp0"
if errorlevel 1 exit /b 1
if not exist WORKSPACE_KIND (echo This startup is for standalone KB_Work only. & exit /b 2)
set "KB_SITE_PROFILE=work"
set "KB_FILE_HUB_LIBRARY=%CD%\library"
set "KB_FILE_HUB_DATA=%CD%\content\file-hub"
set "KB_WORK_HUB_DB=%CD%\content\work-hub\work.sqlite3"
set "KB_WORK_HUB_MEDIA=%CD%\content\work-hub\media"
where py >nul 2>nul
if not errorlevel 1 goto run_py
where python >nul 2>nul
if not errorlevel 1 goto run_python
echo Please install Python 3.
popd
pause
exit /b 1
:run_py
py -3 tools\work_server.py %*
goto finish
:run_python
python tools\work_server.py %*
:finish
set "kb_exit=%errorlevel%"
popd
exit /b %kb_exit%

:run_wsl
for /f "tokens=2 delims=\" %%d in ("%kb_here%") do set "kb_distro=%%d"
echo Project is on a WSL share (%kb_distro%); starting the server inside WSL...
wsl.exe -d "%kb_distro%" -e bash -lc "cd \"$(wslpath -u '%kb_here%')\" && bash ./start.sh %*"
exit /b %errorlevel%
