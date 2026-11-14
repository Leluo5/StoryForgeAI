@echo off
chcp 65001 >nul
echo 正在启动 StoryForgeAI - 小说AI写作软件...
python -m pip install -r requirements.txt -q 2>nul
start "" python app.py
timeout /t 2 >nul
start http://localhost:5000
