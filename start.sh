#!/bin/bash
echo "正在启动 StoryForgeAI - 小说AI写作软件..."
pip install flask requests flask-cors -q 2>/dev/null
python app.py &
sleep 2
open http://localhost:5000 2>/dev/null || xdg-open http://localhost:5000 2>/dev/null
