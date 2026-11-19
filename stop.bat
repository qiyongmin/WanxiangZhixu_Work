@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
where py >nul 2>nul
if not errorlevel 1 goto run_py
where python >nul 2>nul
if not errorlevel 1 goto run_python
echo Please install Python 3.
popd
pause
exit /b 1
:run_py
py -3 tools\stop_server.py %*
goto finish
:run_python
python tools\stop_server.py %*
:finish
set "kb_exit=%errorlevel%"
popd
exit /b %kb_exit%
