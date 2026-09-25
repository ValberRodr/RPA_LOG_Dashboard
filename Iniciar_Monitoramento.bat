@echo off
cd /d %~dp0
where py >nul 2>nul && (py -3 server.py & goto :eof)
python server.py
