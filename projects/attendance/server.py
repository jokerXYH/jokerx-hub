# -*- coding: utf-8 -*-
"""
一键考勤 · 服务端
============================================================
职责：
1. 托管本目录前端文件（index.html / app.js / style.css）
2. 用 Playwright 无头浏览器代理登录校管家，并在服务端维持登录态
3. 读取今日课程、读取学员名单、提交考勤点名

接口一览（均需请求头 X-Session-Token，前端仅保存 token 与用户名，不保存密码）：
  GET  /api/status   查询登录状态 {"loggedIn", "username", "canRestore", "savedUser"}
  POST /api/login    三种模式（body.mode）：
                       无 mode        {"username","password"} 手动登录（原路径）
                       "restore"      用服务器保存的登录态免密恢复（仅限本设备 token）
                       "saved"        用服务器 config.json 预存账号一键登录
  POST /api/logout   注销本浏览器会话（并撤掉该设备的免密恢复资格）
  GET  /api/courses  读取今日课程列表（只读）
  GET  /api/schedule?start=YYYY-MM-DD&end=YYYY-MM-DD
                     读取指定日期范围的排课日期（只读，供待办 App 标记上课日）
  POST /api/roster   body {"key"} → 打开点名弹窗读取学员名单后关闭（只读）
  POST /api/submit   body {"key","presentIds":[...],"notifyParents":bool}
                     将该课程中学号在 presentIds 内的学员标记为出勤后提交

登录提速（2026-10-17）：
  - 登录成功后浏览器登录态由 attendance.py 落盘（data/session_state.json）；
  - 服务器把「登录过的 token」持久化到 data/known_tokens.json，restore 模式
    仅对这些设备开放——新设备仍须手动 / 一键登录一次，防陌生人直接进入；
  - 服务重启后老设备打开页面即自动恢复（实测约 2~4 秒），无需任何输入；
  - 「一键登录」为**安全默认关闭**（2026-10-17 起）：关闭时新设备必须输入
    账号密码；如需在服务器启用（不推荐，公网域名下等于向所有访问者开放），
    在 config.json options 里显式设 "一键登录": true 并重启服务。

安全措施：来源白名单 + POST 来源校验 + 登录限流 + 静态资源白名单托管
         + 安全响应头 + 请求体大小限制 + 错误信息脱敏 + 敏感配置不可访问。
============================================================
"""

import json
import os
import re
import sys
import threading
import time
import urllib.parse
import webbrowser
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from attendance import (
    ABSENCE_REASONS,
    AttendanceError,
    BrowserWorker,
    LoginFailed,
    SessionExpired,
)
from attendance_api import (
    ApiError,
    ApiLoginFailed,
    ApiSessionExpired,
    ApiWorker,
)

# ---------------- 常量配置 ----------------
HOST = "127.0.0.1"      # 默认仅监听本机，服务器上由 Nginx 反向代理
PORT = 8974             # 与签到表生成器(8973)错开端口
MAX_JSON_BODY_BYTES = 256 * 1024   # 请求体上限（防止超大 body 耗尽内存）

# 允许跨域访问的来源白名单（服务器上线后由 Nginx 同源代理，一般用不到跨域）
DEFAULT_ALLOWED_ORIGINS = (
    "https://jokerx.top",
    "https://www.jokerx.top",
    "http://127.0.0.1:8974",
    "http://localhost:8974",
    # 本地预览待办 App 时的静态服务器端口（仍是本机来源）
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    # Capacitor Android / iOS WebView 的本地来源（待办 App 同步课表用）
    "https://localhost",
    "capacitor://localhost",
    "http://localhost",
)

# 允许对外托管的静态资源扩展名（白名单制；.json 不在内，故 config.json 不会被下载）
STATIC_ALLOWED_SUFFIXES = {
    ".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".gif",
    ".svg", ".ico", ".webp", ".woff", ".woff2", ".map",
}

# 禁止对外访问的目录名
STATIC_BLOCKED_DIRS = {"tests", "venv", "__pycache__", "fonts"}

# 登录限流：窗口内失败达到上限即锁定来源，抵御暴力破解
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 300
LOGIN_LOCK_SECONDS = 300

# 会话闲置过期时间（服务端重启会清空全部会话）
SESSION_TTL_SECONDS = 7 * 24 * 3600
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def normalize_absence_reasons(value):
    """校验前端传来的 学号 -> 缺勤原因，拒绝未知原因与空学号。"""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("缺勤原因格式无效")
    normalized = {}
    for raw_id, raw_reason in value.items():
        student_id = str(raw_id).strip()
        reason = str(raw_reason).strip()
        if not student_id or len(student_id) > 64:
            raise ValueError("学员标识无效")
        if reason not in ABSENCE_REASONS:
            raise ValueError("缺勤原因无效")
        normalized[student_id] = reason
    return normalized

# 免密登录的落盘数据（data/ 运行期自动生成，不进 git、不部署）
DATA_DIR = Path(__file__).parent / "data"
KNOWN_TOKENS_FILE = DATA_DIR / "known_tokens.json"
KNOWN_TOKENS_MAX = 50     # 最多记住多少台设备（超出淘汰最旧的）


def load_saved_account():
    """
    读取 config.json 里预存的校管家账号（用于「一键登录」）。
    安全默认：**关闭**（2026-10-17 起）——不显式开启时，新设备必须输入
    账号密码才能进入（隐私原则：学员姓名/手机号不对公网开放）。
    需要在服务器上启用时：config.json 的 options 里显式加 "一键登录": true，
    并重启服务。

    :returns: {"username","password"}；未配置 / 未显式开启时返回 None
    """
    config_path = Path(__file__).parent / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    account = config.get("xiaogj") or {}
    username = str(account.get("username") or "").strip()
    password = str(account.get("password") or "")
    if not username or not password:
        return None
    if config.get("options", {}).get("一键登录", False) is not True:
        return None    # 安全默认：只有显式 true 才启用一键登录
    return {"username": username, "password": password}


def resolve_allowed_origins(environ=None):
    """解析跨域白名单；可用环境变量 ATTEND_ALLOWED_ORIGINS 覆盖（逗号分隔）。"""
    env = os.environ if environ is None else environ
    raw = env.get("ATTEND_ALLOWED_ORIGINS", "")
    if not raw.strip():
        return DEFAULT_ALLOWED_ORIGINS
    return tuple(item.strip() for item in raw.split(",") if item.strip())


ALLOWED_ORIGINS = resolve_allowed_origins()


def is_valid_token(token):
    """校验 token 格式，防止畸形 key 撑爆服务端会话表。"""
    return bool(token) and bool(TOKEN_PATTERN.match(token))


# ---------------- 浏览器会话注册表 ----------------
class SessionRegistry:
    """
    记录「哪些 token 已登录」及其最后活跃时间。
    真正的浏览器上下文由 BrowserWorker 持有；这里只做请求线程侧的元数据管理。

    另维护一份持久化的「曾经登录过的 token」名单（data/known_tokens.json）：
    免密恢复（restore 模式）只对这些设备开放——新设备必须手动 / 一键登录
    至少一次，避免任何陌生人打开页面就被自动带入。
    """

    def __init__(self, worker, ttl=SESSION_TTL_SECONDS, tokens_file=None):
        self.worker = worker
        self.ttl = ttl
        self._lock = threading.Lock()
        self._last_used = {}   # token -> 时间戳
        self._tokens_file = tokens_file if tokens_file is not None else KNOWN_TOKENS_FILE
        self._known = self._load_known()

    # ---------- 免密名单（持久化，登录过即记住） ----------
    def _load_known(self):
        try:
            raw = json.loads(self._tokens_file.read_text(encoding="utf-8"))
            tokens = raw.get("tokens") or []
            return [str(t) for t in tokens if is_valid_token(str(t))]
        except (OSError, ValueError):
            return []

    def _save_known(self):
        """写盘失败只影响下次的免密体验，不影响本次登录（静默）。"""
        try:
            self._tokens_file.parent.mkdir(parents=True, exist_ok=True)
            self._tokens_file.write_text(
                json.dumps({"tokens": self._known[-KNOWN_TOKENS_MAX:]}, ensure_ascii=False),
                encoding="utf-8")
        except OSError:
            pass

    def remember(self, token):
        """登录成功：记住该设备，允许其之后免密恢复。"""
        if not is_valid_token(token):
            return
        with self._lock:
            if token in self._known:
                self._known.remove(token)   # 重复登录：移到队尾（最近使用优先保留）
            self._known.append(token)
            self._save_known()

    def forget(self, token):
        """注销：撤掉该设备的免密恢复资格（下次打开须重新登录）。"""
        with self._lock:
            if token in self._known:
                self._known.remove(token)
                self._save_known()

    def is_known(self, token):
        """该设备是否曾在本服务器登录过。"""
        with self._lock:
            return token in self._known

    def username(self, token):
        """返回用户名；未登录返回空串。"""
        return self.worker.username_of(token)

    def touch(self, token):
        with self._lock:
            self._last_used[token] = time.time()

    def remove(self, token):
        """注销：清元数据并让工作线程关闭对应上下文。"""
        with self._lock:
            self._last_used.pop(token, None)
        self.worker.drop(token)

    def cleanup_expired(self, now=None):
        """清理长期闲置的会话，返回清理数量。"""
        current = time.time() if now is None else now
        with self._lock:
            dead = [t for t, ts in self._last_used.items() if current - ts > self.ttl]
        for token in dead:
            self.remove(token)
        return len(dead)


# ---------------- 登录限流 ----------------
class LoginAttemptLimiter:
    """按来源 IP 统计登录失败次数，超限临时锁定（纯内存，进程重启即清空）。"""

    def __init__(self, max_failures=LOGIN_MAX_FAILURES,
                 window=LOGIN_WINDOW_SECONDS, lock_seconds=LOGIN_LOCK_SECONDS):
        self.max_failures = max_failures
        self.window = window
        self.lock_seconds = lock_seconds
        self._failures = {}
        self._locked_until = {}
        self._lock = threading.Lock()

    def is_locked(self, key, now=None):
        current = time.time() if now is None else now
        with self._lock:
            until = self._locked_until.get(key)
            if until is None:
                return False
            if current >= until:
                self._locked_until.pop(key, None)
                self._failures.pop(key, None)
                return False
            return True

    def record_failure(self, key, now=None):
        current = time.time() if now is None else now
        with self._lock:
            stamps = [t for t in self._failures.get(key, []) if current - t <= self.window]
            stamps.append(current)
            self._failures[key] = stamps
            if len(stamps) >= self.max_failures:
                self._locked_until[key] = current + self.lock_seconds

    def reset(self, key):
        with self._lock:
            self._failures.pop(key, None)
            self._locked_until.pop(key, None)

    def cleanup(self, now=None):
        current = time.time() if now is None else now
        with self._lock:
            stale = {k for k, until in self._locked_until.items() if current >= until}
            stale |= {k for k, stamps in self._failures.items()
                      if not stamps or current - stamps[-1] > self.window}
            for key in stale:
                self._failures.pop(key, None)
                self._locked_until.pop(key, None)
            return len(stale)


# ---------------- HTTP 服务 ----------------
# 进程级共享：一个浏览器工作线程 + 一份会话注册表 + 一个限流器
WORKER = None            # 在 main() 中按配置初始化
SESSIONS = None
SAVED_ACCOUNT = None     # config.json 预存账号（一键登录用），main() 中加载
LOGIN_LIMITER = LoginAttemptLimiter()


class ApiHandler(SimpleHTTPRequestHandler):
    """API 与静态文件混合处理器。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)

    # ---------- 响应 / 安全头 ----------
    def end_headers(self):
        """统一附加安全响应头并禁用缓存。"""
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self' http://127.0.0.1:8974 "
            "http://localhost:8974; object-src 'none'; base-uri 'none'; "
            "frame-ancestors 'none'",
        )
        super().end_headers()

    # ---------- 通用工具 ----------
    def _request_token(self):
        """读取并校验请求头 token；不合法返回 None。"""
        token = self.headers.get("X-Session-Token", "")
        return token if is_valid_token(token) else None

    def _request_origin(self):
        return (self.headers.get("Origin") or "").strip()

    def _origin_allowed(self):
        """无 Origin（同源导航 / 命令行）视为可信；带 Origin 的必须命中白名单。"""
        origin = self._request_origin()
        return (not origin) or (origin in ALLOWED_ORIGINS)

    def _client_ip(self):
        """解析真实客户端 IP，用于登录限流（服务仅监听 127.0.0.1，透传头可信）。"""
        forwarded = (self.headers.get("X-Real-IP")
                     or self.headers.get("X-Forwarded-For") or "")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "unknown"

    def _log_error(self, context, error):
        """底层异常只写服务端日志，不回显给客户端。"""
        sys.stderr.write("[一键考勤] %s: %s\n" % (context, error))

    def _cors_headers(self):
        """仅对白名单来源下发 CORS 头，并回显具体 Origin（不用通配）。"""
        origin = self._request_origin()
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Session-Token")

    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        """读取并解析请求体 JSON；空 / 超长 / 解析失败均返回 None。"""
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            return None
        if length <= 0 or length > MAX_JSON_BODY_BYTES:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _require_login(self):
        """
        校验登录态。
        :returns: 已登录返回 token；否则发送 401 并返回 None
        """
        token = self._request_token()
        if token is None or not SESSIONS.username(token):
            self._send_json(401, {"error": "未登录"})
            return None
        SESSIONS.touch(token)
        return token

    def _run_worker(self, token, action):
        """
        统一执行浏览器操作并翻译异常，避免各路由重复 try/except。
        :returns: (成功标志, 结果或错误消息)
        """
        try:
            return True, action()
        except (SessionExpired, ApiSessionExpired) as error:
            SESSIONS.remove(token)
            return False, ("session", str(error))
        except (LoginFailed, ApiLoginFailed) as error:
            return False, ("login", str(error))
        except (AttendanceError, ApiError) as error:
            # 业务错误：消息可直接展示
            return False, ("business", str(error))
        except Exception as error:  # noqa: BLE001 未预期异常脱敏后返回
            self._log_error("浏览器操作异常", error)
            return False, ("server", "操作失败，请稍后重试")

    # ---------- 静态资源托管（白名单制） ----------
    def _is_allowed_static(self, url_path):
        """仅放行白名单扩展名，并阻止 ../ 穿越与敏感目录。"""
        decoded = urllib.parse.unquote(url_path)
        normalized = os.path.normpath(decoded).replace("\\", "/")
        if normalized.startswith("..") or "/../" in normalized:
            return False
        parts = [p for p in normalized.split("/") if p not in ("", ".")]
        if any(p in STATIC_BLOCKED_DIRS for p in parts):
            return False
        last = parts[-1] if parts else "index.html"
        if "." not in last:
            return True
        return Path(last).suffix.lower() in STATIC_ALLOWED_SUFFIXES

    def send_head(self):
        """静态资源入口：非白名单文件（源码 / 配置 / venv 等）一律 404。"""
        url_path = urllib.parse.urlparse(self.path).path
        if not self._is_allowed_static(url_path):
            self.send_error(404, "File not found")
            return None
        return super().send_head()

    def list_directory(self, path):
        """禁用目录列表。"""
        self.send_error(403, "Directory listing is disabled")
        return None

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/status":
            token = self._request_token()
            username = SESSIONS.username(token) if token else ""
            self._send_json(200, {
                "loggedIn": bool(username),
                "username": username,
                # 免密恢复资格：本设备曾登录过 + 服务器留有可用登录态文件
                "canRestore": bool(token) and SESSIONS.is_known(token)
                              and WORKER.has_saved_state(),
                # 一键登录可用时回传预存账号的用户名（不含密码）
                "savedUser": (SAVED_ACCOUNT or {}).get("username", ""),
            })
        elif path == "/api/courses":
            self._handle_courses()
        elif path == "/api/schedule":
            self._handle_schedule(urllib.parse.urlsplit(self.path).query)
        else:
            super().do_GET()

    def do_POST(self):
        # 跨站来源直接拒绝：防 CSRF 与恶意站点把本服务当跳板
        if not self._origin_allowed():
            self._send_json(403, {"error": "非法请求来源"})
            return
        if self.path == "/api/login":
            self._handle_login()
        elif self.path == "/api/logout":
            token = self._request_token()
            if token:
                SESSIONS.forget(token)   # 撤掉免密资格：下次打开需重新登录
                SESSIONS.remove(token)
            self._send_json(200, {"ok": True})
        elif self.path == "/api/roster":
            self._handle_roster()
        elif self.path == "/api/submit":
            self._handle_submit()
        else:
            self._send_json(404, {"error": "接口不存在"})

    # ---------- 各接口实现 ----------
    def _handle_login(self):
        """登录：手动（用户名+密码）/ 免密恢复 / 一键登录 三种模式。"""
        token = self._request_token()
        if token is None:
            self._send_json(400, {"error": "无效的会话标识，请刷新页面重试"})
            return
        body = self._read_json_body() or {}
        mode = str(body.get("mode") or "").strip()

        if mode == "restore":
            self._handle_restore_login(token, body)
            return
        if mode == "saved":
            self._handle_saved_login(token)
            return

        # ---- 手动登录（原路径） ----
        if not body.get("username") or not body.get("password"):
            self._send_json(400, {"error": "请输入用户名和密码"})
            return
        # 防暴力破解：同一来源失败过多则临时锁定
        client_key = self._client_ip()
        if LOGIN_LIMITER.is_locked(client_key):
            self._send_json(429, {"error": "登录失败次数过多，请稍后再试"})
            return

        username = str(body["username"]).strip()
        ok, result = self._run_worker(
            token, lambda: WORKER.login(token, username, str(body["password"])))
        if not ok:
            kind, message = result
            if kind == "login":
                LOGIN_LIMITER.record_failure(client_key)
                # 不回显账号是否存在，避免账号枚举
                self._send_json(401, {"error": "用户名或密码错误"})
                return
            self._send_json(502, {"error": message})
            return

        LOGIN_LIMITER.reset(client_key)
        LOGIN_LIMITER.cleanup()
        SESSIONS.remember(token)     # 记入免密名单，之后这台设备凭证可免密恢复
        SESSIONS.touch(token)
        SESSIONS.cleanup_expired()
        self._send_json(200, {"username": username})

    def _handle_restore_login(self, token, body):
        """免密恢复：仅限曾在本服务器登录过的设备（token 在名单内）。"""
        if not SESSIONS.is_known(token):
            self._send_json(403, {"error": "此设备未登录过，请手动登录"})
            return
        username = str(body.get("username") or "").strip()
        ok, result = self._run_worker(token, lambda: WORKER.restore(token, username))
        if not ok:
            kind, message = result
            # restore 失败（登录态过期 / 校管家踢下线）：引导手动登录
            self._send_json(401, {"error": message})
            return
        SESSIONS.touch(token)
        self._send_json(200, {"username": WORKER.username_of(token) or username})

    def _handle_saved_login(self, token):
        """一键登录：用服务器 config.json 预存账号（options.一键登录=false 可关闭）。"""
        if SAVED_ACCOUNT is None:
            self._send_json(403, {"error": "服务器未开启一键登录"})
            return
        ok, result = self._run_worker(
            token,
            lambda: WORKER.login(
                token,
                SAVED_ACCOUNT["username"],
                SAVED_ACCOUNT["password"],
                allow_restore=True,
            ))
        if not ok:
            kind, message = result
            if kind == "login":
                # 预存账号失效（改动过密码等）：引导手动输入，不占用暴力破解计数
                self._send_json(401, {"error": "预存账号已无法登录校管家，请手动输入账号密码"})
                return
            self._send_json(502, {"error": message})
            return
        SESSIONS.remember(token)
        SESSIONS.touch(token)
        SESSIONS.cleanup_expired()
        self._send_json(200, {"username": SAVED_ACCOUNT["username"]})

    def _handle_courses(self):
        """读取今日课程（只读）。"""
        token = self._require_login()
        if token is None:
            return
        ok, result = self._run_worker(token, lambda: WORKER.list_courses(token))
        if not ok:
            self._send_error_tuple(result)
            return
        self._send_json(200, {"courses": result})

    def _handle_schedule(self, query):
        """读取指定日期范围的排课日期（只读，供待办 App 使用）。"""
        token = self._require_login()
        if token is None:
            return
        params = urllib.parse.parse_qs(query or "")
        today = date.today()
        try:
            start = date.fromisoformat((params.get("start") or [""])[0]) \
                if (params.get("start") or [""])[0] else today - timedelta(days=30)
            end = date.fromisoformat((params.get("end") or [""])[0]) \
                if (params.get("end") or [""])[0] else today + timedelta(days=365)
        except ValueError:
            self._send_json(400, {"error": "日期格式应为 YYYY-MM-DD"})
            return
        if end < start:
            self._send_json(400, {"error": "结束日期不能早于开始日期"})
            return
        if (end - start).days > 400:
            self._send_json(400, {"error": "查询范围不能超过 400 天"})
            return
        ok, result = self._run_worker(
            token, lambda: WORKER.list_schedule(token, start.isoformat(), end.isoformat()))
        if not ok:
            self._send_error_tuple(result)
            return
        self._send_json(200, result)

    def _handle_roster(self):
        """读取某课程学员名单（只读，不提交）。"""
        token = self._require_login()
        if token is None:
            return
        body = self._read_json_body()
        key = (body or {}).get("key", "")
        if not key:
            self._send_json(400, {"error": "缺少课程标识"})
            return
        ok, result = self._run_worker(token, lambda: WORKER.read_roster(token, key))
        if not ok:
            self._send_error_tuple(result)
            return
        self._send_json(200, result)

    def _handle_submit(self):
        """提交点名结果。"""
        token = self._require_login()
        if token is None:
            return
        body = self._read_json_body()
        if not body or not body.get("key"):
            self._send_json(400, {"error": "缺少课程标识"})
            return
        # 出勤名单：仅接受字符串学号，避免异常类型进入浏览器脚本
        present_ids = [str(x) for x in (body.get("presentIds") or [])]
        notify = bool(body.get("notifyParents"))
        try:
            absence_reasons = normalize_absence_reasons(body.get("absenceReasons"))
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
            return
        ok, result = self._run_worker(
            token,
            lambda: WORKER.submit_attendance(
                token, body["key"], present_ids, notify, absence_reasons))
        if not ok:
            self._send_error_tuple(result)
            return
        self._send_json(200, result)

    def _send_error_tuple(self, result):
        """把 (种类, 消息) 映射为合适的 HTTP 状态码。"""
        kind, message = result
        if kind == "session":
            self._send_json(401, {"error": message})
        elif kind == "login":
            self._send_json(401, {"error": message})
        elif kind == "business":
            self._send_json(400, {"error": message})
        else:
            self._send_json(502, {"error": message})

    def log_message(self, fmt, *args):
        """精简控制台日志。"""
        sys.stderr.write("[一键考勤] %s - %s\n" % (self.log_date_time_string(), fmt % args))


# ---------------- 入口 ----------------
class SingleInstanceServer(ThreadingHTTPServer):
    """禁用端口复用：重复启动会明确报「端口已占用」，避免两实例抢流量。"""
    allow_reuse_address = False


def resolve_runtime_config(environ=None):
    """
    解析运行配置：监听地址 / 端口 / 是否自动开浏览器 / 是否无头。
      ATTEND_HOST=0.0.0.0 python server.py     # 直接对外（不推荐）
      ATTEND_NO_BROWSER=1 python server.py     # 服务器静默模式
      ATTEND_HEADED=1 python server.py         # 本地调试：显示浏览器窗口
    """
    env = os.environ if environ is None else environ
    host = env.get("ATTEND_HOST", HOST)
    try:
        port = int(env.get("ATTEND_PORT", str(PORT)))
    except ValueError:
        port = PORT
    is_local = host in ("127.0.0.1", "localhost")
    should_open_browser = is_local and env.get("ATTEND_NO_BROWSER") != "1"
    headless = env.get("ATTEND_HEADED") != "1"
    return host, port, should_open_browser, headless


def main():
    global WORKER, SESSIONS, SAVED_ACCOUNT
    host, port, should_open_browser, headless = resolve_runtime_config()

    engine = (os.environ.get("ATTEND_ENGINE") or "api").strip().lower()
    if engine not in ("api", "playwright"):
        print(f"[错误] ATTEND_ENGINE={engine!r}，只支持 api 或 playwright")
        sys.exit(1)
    WORKER = ApiWorker() if engine == "api" else BrowserWorker(headless=headless)
    SESSIONS = SessionRegistry(WORKER)
    SAVED_ACCOUNT = load_saved_account()

    # 预热浏览器内核：把 Chromium 启动开销提前到服务启动时（失败静默，不影响服务）
    threading.Thread(target=WORKER.warmup, name="attendance-warmup", daemon=True).start()

    try:
        server = SingleInstanceServer((host, port), ApiHandler)
    except OSError:
        print(f"[错误] {host}:{port} 已被占用：可能已经开过一个考勤服务，")
        print("       请先关闭旧进程（或直接访问该地址）。")
        sys.exit(1)

    url = f"http://{host}:{port}/"
    print("=" * 52)
    print("  一键考勤 · 服务已启动")
    print(f"  地址：{url}" + ("（浏览器将自动打开）" if should_open_browser else ""))
    print(f"  考勤引擎：{'纯接口' if engine == 'api' else 'Playwright'}")
    print(f"  浏览器模式：{'无头' if headless else '可见'}")
    print(f"  一键登录：{'已开启（' + SAVED_ACCOUNT['username'] + '）' if SAVED_ACCOUNT else '未配置或已关闭'}")
    print("  按 Ctrl+C 停止服务")
    print("=" * 52)

    if should_open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()
        if WORKER is not None:
            WORKER.close()


if __name__ == "__main__":
    main()
