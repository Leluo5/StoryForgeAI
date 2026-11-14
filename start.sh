#!/bin/bash
echo "正在启动 StoryForgeAI - 小说AI写作软件..."
python -m pip install -r requirements.txt -q 2>/dev/null
python app.py &
sleep 2
open http://localhost:5000 2>/dev/null || xdg-open http://localhost:5000 2>/dev/null
