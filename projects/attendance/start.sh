#!/bin/bash
# ============================================================
#  一键考勤 · Linux 服务器启动脚本
#  用途：宝塔「进程守护管理器」/ systemd 调用，启动命令写：bash start.sh
#  说明：仅监听 127.0.0.1:8974，由 Nginx 反向代理 /api/ 对外提供服务
# ============================================================
cd "$(dirname "$0")" || exit 1

export ATTEND_HOST=127.0.0.1
export ATTEND_PORT=8974
export ATTEND_NO_BROWSER=1

# 优先使用项目虚拟环境 venv/，未创建时回退系统 python3（需 ≥3.8）
if [ -x "./venv/bin/python" ]; then
  exec ./venv/bin/python server.py
fi
exec python3 server.py
