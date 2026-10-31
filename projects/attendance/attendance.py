# -*- coding: utf-8 -*-
"""
一键考勤 · 校管家自动化核心（Playwright）
============================================================
职责：用无头浏览器登录校管家（tms22.xiaogj.com），读取「今日课程」，
      并在「点名上课」弹窗中勾选出勤后提交。

选择器来源：基于线上真实 DOM 逐一核对（2026-10-17 校管家整页改版后重新核对）：
  登录页   input#name / input#pwd / a#loginBtn（可见的「登录」按钮）
  二级菜单 .a-replace[data-pname="courseAttendance"]（课表和点名）
  教室列表 aside.ccm-rooms button.ccm-room-card > strong.ccm-room-card__name
  课程卡片 main.ccm-schedule li.ccm-course-card
             ├ a.ccm-course-name        班级代码
             ├ .ccm-course-time strong  上课时间
             └ .ccm-more-actions        操作下拉 → li > a「补点名」
  点名弹窗 .modal.modal-w1050（标题含「点名上课」——内部结构改版未变）
             ├ .modal-body tbody tr   每行一名学员
             │   ├ a.operation-link   学号+姓名（如 26546宗嘉懿）
             │   ├ .font-desc span    手机号
             │   └ td[2] label.checkbox-styled2（class 含 checked = 出勤）
             └ .modal-footer
                 ├ label.checkbox-styled input[type=checkbox] 家长通知
                 └ button[data-test="confirm-attendance"]     确定
  重要：出勤是自定义复选框（无原生 input），必须「点击 label」触发框架
        更新视图模型；仅加 class 不会生效。
  改版说明：2026-10-17 校管家课表页整页改版——教室按钮 ccm-room-item →
        ccm-room-card、课程行 div.ccm-course-row → li.ccm-course-card、
        教师/出勤字段类名同步变化；点名弹窗内部结构未变（含 data-test 按钮）。

并发设计：Playwright 对象只能在其创建线程内使用，故所有浏览器操作都提交
到唯一的后台工作线程串行执行；请求线程通过 submit() 拿结果。每个浏览器
token 对应独立的 BrowserContext（Cookie 隔离），实现多用户互不串号。

登录提速（2026-10-17 新增）：登录成功后把浏览器登录态（storage_state）
落盘到 data/session_state.json（附 data/session_meta.json 记用户名）；
之后的服务重启 / 新会话优先尝试「恢复登录态」直达机构首页——校管家的
WTwo-AuthToken 有效期约 31 天，实测恢复耗时 ~2.4s（对比完整登录表单流程）。
恢复失败（登录态过期 / 账号不符）再走正常表单登录；成功后覆盖保存新登录态。

内存策略（2026-10-17 夜新增，小内存服务器专项）：Chromium 不再常驻——
按需懒启动；注销后无任何会话即关闭；全部会话闲置超过 IDLE_KEEPALIVE_SECONDS
（45 分钟）也整体关闭并清空上下文（用户再来会走免密恢复，约 2~4 秒）。
实测空闲的 headless Chromium 占数百 MB 内存，1.6GB 小机器上必须回收。
============================================================
"""

import json
import os
import queue
import re
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

# ---------------- 常量配置 ----------------
LOGIN_URL = "https://tms22.xiaogj.com/login.aspx"
HOME_URL = "https://jfyf.xiaogj.com/"    # 机构首页（恢复登录态时直连）
HOME_HOST = "jfyf.xiaogj.com"           # 登录成功后跳转的机构域名
ATTENDANCE_MENU = "courseAttendance"     # 二级菜单「课表和点名」的 data-pname
COURSE_MENU_TEXT = "补点名"              # 课程操作菜单项文本
ABSENCE_REASONS = ("事假", "病假", "旷课")

NAV_TIMEOUT = 45_000        # 页面导航等待上限（毫秒）
LOGIN_TIMEOUT = 60_000      # 登录跳转等待上限（毫秒）
RESTORE_TIMEOUT = 20_000    # 恢复登录态的页面等待上限（毫秒，比完整登录短）
IDLE_KEEPALIVE_SECONDS = 45 * 60  # 全部会话闲置超时：关掉 Chromium 省内存（下次访问自动免密恢复）
MODAL_TIMEOUT = 30_000      # 弹窗出现 / 消失等待上限（毫秒）
ROOM_SETTLE_MS = 450        # 切换教室后等待课程列表重绘的时间（毫秒）

# 统一 UA：恢复登录态与表单登录必须一致，避免校管家因 UA 变化要求重新认证
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 登录态落盘位置（data/ 运行期自动生成，不进 git、不部署）
STATE_DIR = Path(__file__).resolve().parent / "data"
STATE_FILE = STATE_DIR / "session_state.json"
STATE_META = STATE_DIR / "session_meta.json"

# 课程 key 的分隔符：使用 U+241F（单元分隔符），真实数据不可能包含
KEY_SEP = "\u241f"

# 定位「当前可见的点名弹窗」的 JS 表达式。
# 为什么不能直接用 querySelector：弹窗关闭后并不从 DOM 移除，只是隐藏，
# 页面上会同时残留多个 .modal-w1050；直接取第一个会读到上一次的旧数据，
# 因此统一按「可见 + 标题含『点名上课』」筛选。
VISIBLE_MODAL_JS = (
    "Array.from(document.querySelectorAll('.modal.modal-w1050')).find(m => {"
    " const header = m.querySelector('.modal-header');"
    " return m.offsetParent !== null && !!header"
    " && header.textContent.indexOf('点名上课') >= 0; })"
)

# 浏览器可执行文件缺失时的友好提示
MISSING_BROWSER_HINT = (
    "未安装 Playwright 浏览器内核，请在服务器执行："
    "python -m playwright install chromium"
)


class AttendanceError(Exception):
    """业务异常：消息可直接展示给前端用户。"""


class LoginFailed(AttendanceError):
    """用户名或密码错误，或登录页结构已变更。"""


class SessionExpired(AttendanceError):
    """登录态已失效，需要重新登录。"""


# ---------------- 工作线程（唯一持有 Playwright 对象） ----------------
class BrowserWorker:
    """
    单线程串行执行所有浏览器操作。

    为什么必须单线程：Playwright 的 sync API 内部绑定 greenlet，
    对象跨线程使用会直接抛错。用「任务队列 + 结果事件」把并发请求
    收敛到一条线程上，既安全又避免加锁的复杂度。
    """

    def __init__(self, headless=True, session_ttl=7 * 24 * 3600, channel=None):
        self.headless = headless
        # 浏览器渠道：留空用 Playwright 自带 Chromium；本地无内核时可设 msedge
        # 复用系统已安装的 Edge，避免下载（对应环境变量 ATTEND_BROWSER_CHANNEL）
        self.channel = channel or (os.environ.get("ATTEND_BROWSER_CHANNEL") or "").strip() or None
        self.session_ttl = session_ttl
        self._tasks = queue.Queue()
        self._thread = None
        self._start_lock = threading.Lock()
        self._ready = threading.Event()
        self._start_error = None

        # 以下状态只在工作线程内读写
        self._playwright = None   # 由 _run 启动后赋值
        self._browser = None      # 懒启动：无会话 / 闲置超时会整体关掉省内存
        self._contexts = {}   # token -> BrowserContext
        self._pages = {}      # token -> Page
        self._last_used = {}  # token -> 时间戳

        # 供请求线程读取的元信息（用户名等），用锁保护
        self._meta = {}       # token -> username
        self._meta_lock = threading.Lock()

    # ---------- 生命周期 ----------
    def _ensure_started(self):
        """惰性启动工作线程与 Playwright（Chromium 由任务按需懒启动）。"""
        with self._start_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._ready.clear()
            self._start_error = None
            self._thread = threading.Thread(
                target=self._run, name="attendance-browser", daemon=True)
            self._thread.start()
        # 等待工作线程就绪（启动失败时 _ready 也会置位，交由下方抛错）
        if not self._ready.wait(timeout=120):
            raise AttendanceError("浏览器线程启动超时，请稍后重试")
        if self._start_error is not None:
            raise AttendanceError(self._start_error)

    def _run(self):
        """工作线程主循环：懒启动浏览器，串行处理任务，空闲时回收 Chromium。"""
        try:
            with sync_playwright() as playwright:
                self._playwright = playwright
                self._ready.set()
                while True:
                    try:
                        task = self._tasks.get(timeout=30)
                    except queue.Empty:
                        self._maybe_idle_close()   # 空闲巡检：无会话 / 闲置超时回收
                        continue
                    if task is None:      # 退出信号
                        break
                    func, box = task
                    try:
                        box["result"] = func()
                    except BaseException as error:  # noqa: BLE001 统一回传给请求线程
                        box["error"] = error
                    finally:
                        box["event"].set()
                        self._maybe_idle_close()
                for token in list(self._contexts):
                    self._drop_in_thread(token)
                self._close_browser_in_thread()
        except Exception as error:  # noqa: BLE001 启动阶段失败
            self._start_error = self._format_start_error(error)
            self._ready.set()

    def _launch_options(self):
        """Chromium 启动参数（懒启动与旧版行为保持一致）。"""
        options = {
            "headless": self.headless,
            "args": [
                "--no-sandbox",              # 服务器常以 root 运行，必须
                "--disable-dev-shm-usage",   # 容器 / 小内存机器防崩溃
                "--disable-gpu",
            ],
        }
        if self.channel:
            options["channel"] = self.channel
        return options

    def _ensure_browser_in_thread(self):
        """（工作线程内）取可用的 Chromium；没有 / 已断开时重新懒启动。"""
        browser = self._browser
        if browser is not None and browser.is_connected():
            return browser
        self._browser = None
        try:
            self._browser = self._playwright.chromium.launch(**self._launch_options())
        except Exception as error:  # noqa: BLE001 启动失败转业务提示
            raise AttendanceError(self._format_start_error(error)) from error
        return self._browser

    def _close_browser_in_thread(self):
        """（工作线程内）关闭并释放 Chromium（下次用到再懒启动）。"""
        browser = self._browser
        self._browser = None
        if browser is not None:
            try:
                browser.close()
            except Exception:  # noqa: BLE001 关闭失败不影响业务
                pass

    def _maybe_idle_close(self):
        """
        （工作线程内）空闲回收：没有会话立即关浏览器；会话全部闲置超时
        则整批关闭（用户再来会走免密恢复，约 2~4 秒，体验基本无损）。
        """
        if self._browser is None:
            return
        if self._contexts:
            newest = max(self._last_used.values(), default=0)
            if time.time() - newest < IDLE_KEEPALIVE_SECONDS:
                return
            for token in list(self._contexts):
                self._drop_in_thread(token)
                with self._meta_lock:
                    self._meta.pop(token, None)
        self._close_browser_in_thread()

    @staticmethod
    def _format_start_error(error):
        """把 Playwright 启动异常转成用户能看懂的中文提示。"""
        message = str(error)
        if "Executable doesn't exist" in message or "playwright install" in message:
            return MISSING_BROWSER_HINT
        return f"浏览器启动失败：{message}"

    def submit(self, func, timeout=240):
        """
        把 func 提交到工作线程执行并等待结果。
        :param func: 无参可调用对象（在工作线程内执行）
        :param timeout: 等待上限（秒）
        :raises AttendanceError: 超时
        """
        self._ensure_started()
        box = {"event": threading.Event()}
        self._tasks.put((func, box))
        if not box["event"].wait(timeout=timeout):
            raise AttendanceError("操作超时，请稍后重试")
        if "error" in box:
            raise box["error"]
        return box.get("result")

    def close(self):
        """停止工作线程并关闭浏览器。"""
        if self._thread is not None and self._thread.is_alive():
            self._tasks.put(None)

    # ---------- 会话（供请求线程调用的线程安全接口） ----------
    def username_of(self, token):
        """返回该 token 已登录的用户名；未登录返回空串。"""
        with self._meta_lock:
            return self._meta.get(token, "")

    def is_logged_in(self, token):
        return bool(self.username_of(token))

    def drop(self, token):
        """注销：关闭并移除该 token 的浏览器上下文。"""
        with self._meta_lock:
            self._meta.pop(token, None)
        try:
            self.submit(lambda: self._drop_in_thread(token), timeout=30)
        except AttendanceError:
            # 工作线程异常时忽略：元信息已清理，等于已注销
            pass

    def _drop_in_thread(self, token):
        """（工作线程内）关闭并清除某 token 的上下文。"""
        context = self._contexts.pop(token, None)
        self._pages.pop(token, None)
        self._last_used.pop(token, None)
        if context is not None:
            try:
                context.close()
            except Exception:  # noqa: BLE001 关闭失败不影响注销结果
                pass

    # ---------- 对外业务接口 ----------
    def warmup(self):
        """预热：提前拉起工作线程与 Playwright（Chromium 按需懒启动、空闲自动回收）。"""
        try:
            self.submit(lambda: None, timeout=180)
        except AttendanceError:
            pass

    def has_saved_state(self):
        """是否存有可复用的登录态文件（供前端提示用，不含敏感内容）。"""
        return STATE_FILE.exists()

    def restore(self, token, username):
        """
        仅用已保存的登录态恢复会话（不走登录表单）。
        :raises LoginFailed: 登录态缺失 / 过期 / 与用户名不符
        """
        self.submit(lambda: self._restore_or_fail(token, username), timeout=120)

    def login(self, token, username, password, allow_restore=False):
        """
        登录校管家。
        :param allow_restore: 是否允许先尝试已保存登录态。仅「一键登录」使用；
            手动输入账号密码时必须为 False，否则同账号的错误密码也会被
            已保存的登录态绕过。
        :raises LoginFailed: 凭据错误或登录页结构变更
        :raises AttendanceError: 网络 / 浏览器异常
        """
        # 超时给到 240s：内部「打开登录页 45s + 等跳转 60s + 等应用外壳 60s」
        # 本身就可能接近 180s，若外层先超时会被误报成「操作超时」，用户还得重来。
        self.submit(
            lambda: self._login_in_thread(token, username, password, allow_restore),
            timeout=240)

    def list_courses(self, token):
        """读取今日全部教室的课程列表（只读）。"""
        return self.submit(lambda: self._list_courses_in_thread(token), timeout=240)

    def list_schedule(self, token, start, end):
        """读取指定日期范围内的排课日期（只读，供待办 App 标记上课日）。"""
        return self.submit(
            lambda: self._list_schedule_in_thread(token, start, end), timeout=240)

    def read_roster(self, token, key):
        """打开指定课程的点名弹窗，读取学员名单后关闭（只读，不提交）。"""
        return self.submit(lambda: self._roster_in_thread(token, key), timeout=180)

    def submit_attendance(
            self, token, key, present_ids, notify_parents, absence_reasons=None):
        """
        提交指定课程的点名结果。
        :param present_ids: 需要标记为「出勤」的学员学号集合
        :param notify_parents: 是否勾选「给家长发送签到信息」
        :param absence_reasons: 缺勤学号 -> 事假 / 病假 / 旷课
        """
        return self.submit(
            lambda: self._submit_in_thread(
                token,
                key,
                set(present_ids),
                notify_parents,
                dict(absence_reasons or {}),
            ),
            timeout=180)

    # ---------- 工作线程内部实现 ----------
    def _require_page(self, token):
        """取该 token 的页面；未登录 / 已过期抛 SessionExpired。"""
        page = self._pages.get(token)
        if page is None or page.is_closed():
            raise SessionExpired("未登录或会话已过期，请重新登录")
        if HOME_HOST not in page.url:
            # 被弹回登录页 = 会话失效
            raise SessionExpired("登录状态已失效，请重新登录")
        self._last_used[token] = time.time()
        return page

    def _restore_or_fail(self, token, username):
        """（工作线程内）只允许走登录态恢复；失败抛 LoginFailed。"""
        self._drop_in_thread(token)
        if not self._try_restore_in_thread(token, username):
            raise LoginFailed("登录态已失效，请重新登录")

    def _try_restore_in_thread(self, token, username):
        """
        （工作线程内）尝试用已保存登录态免密直达机构首页。
        :returns: True = 已就绪；False = 不可用（文件缺失 / 账号不符 / 过期）
        """
        if not STATE_FILE.exists():
            return False
        meta = self._read_state_meta()
        if username and meta.get("username") and meta["username"] != username:
            return False   # 账号不符：不允许串号
        context = None
        try:
            context = self._ensure_browser_in_thread().new_context(
                locale="zh-CN",
                viewport={"width": 1440, "height": 900},
                user_agent=USER_AGENT,
                storage_state=str(STATE_FILE),
            )
            page = context.new_page()
            page.set_default_timeout(NAV_TIMEOUT)
            page.goto(HOME_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
            # 登录态有效：应用外壳直接挂载；失效则被踢回登录页（等不到 common-nav）
            page.wait_for_selector("a.common-nav", state="attached", timeout=RESTORE_TIMEOUT)
        except Exception:  # noqa: BLE001 恢复失败不是错误：回落到表单登录
            if context is not None:
                try:
                    context.close()
                except Exception:  # noqa: BLE001
                    pass
            return False
        self._contexts[token] = context
        self._pages[token] = page
        self._last_used[token] = time.time()
        with self._meta_lock:
            self._meta[token] = meta.get("username") or username
        self._prune_expired()
        return True

    def _login_in_thread(self, token, username, password, allow_restore=False):
        """（工作线程内）按 allow_restore 决定是否先恢复登录态，再走表单登录。"""
        self._drop_in_thread(token)   # 同 token 重复登录：先清掉旧上下文

        # 手动登录不能走免密恢复：否则同账号 + 错误密码会直接复用旧会话。
        # 只有 saved（一键登录）/ restore（自动恢复）入口允许走这条快捷路径。
        if allow_restore and self._try_restore_in_thread(token, username):
            return   # 免密直达（实测约 2~4 秒）：整个登录表单流程都省掉

        context = self._ensure_browser_in_thread().new_context(
            locale="zh-CN",
            viewport={"width": 1440, "height": 900},
            user_agent=USER_AGENT,
        )
        page = context.new_page()
        page.set_default_timeout(NAV_TIMEOUT)

        try:
            page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
            page.fill("input#name", username)
            page.fill("input#pwd", password)
            # 真实登录按钮是可见的 a#loginBtn；同名 class 的 <button> 属于隐藏提示弹窗
            # no_wait_after=True：点击后不去等「导航完成」。校管家登录后跳转很慢，
            # Playwright 默认会一直等到导航结束，实测白等 30s 后还抛 60s 超时，
            # 既拖慢登录又常导致整次登录失败；跳转结果交给下面的显式等待判断。
            page.click("a#loginBtn", no_wait_after=True)
            # 登录成功会跳转到机构域名；失败则停留在登录页
            try:
                page.wait_for_url(re.compile(r"jfyf\.xiaogj\.com"), timeout=LOGIN_TIMEOUT)
            except PWTimeout:
                page = self._find_app_page(context, page)
            # 用 attached 而非 visible：只要应用外壳挂载进 DOM 就说明登录成功，
            # 可见性判定要额外等样式计算，在校管家这种慢页面上是纯浪费时间。
            page.wait_for_selector("a.common-nav", state="attached", timeout=LOGIN_TIMEOUT)
        except AttendanceError:
            context.close()
            raise
        except Exception as error:  # noqa: BLE001 登录期任何异常都归为登录失败
            context.close()
            raise LoginFailed(f"登录失败：{self._brief(error)}") from error

        self._contexts[token] = context
        self._pages[token] = page
        self._last_used[token] = time.time()
        with self._meta_lock:
            self._meta[token] = username
        self._save_state_in_thread(context, username)   # 记住本次登录，之后免密
        self._prune_expired()

    def _save_state_in_thread(self, context, username):
        """（工作线程内）把登录态落盘，供服务重启 / 后续会话免密恢复。"""
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            context.storage_state(path=str(STATE_FILE))
            STATE_META.write_text(
                json.dumps(
                    {"username": username, "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S")},
                    ensure_ascii=False),
                encoding="utf-8")
        except Exception:  # noqa: BLE001 落盘失败只影响提速，不影响本次登录
            pass

    @staticmethod
    def _read_state_meta():
        """读取登录态元信息；缺失 / 损坏返回空 dict。"""
        try:
            return json.loads(STATE_META.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _find_app_page(self, context, fallback_page):
        """登录跳转可能发生在原有标签页，也可能新开标签页，这里统一收敛。"""
        deadline = time.time() + 8
        while time.time() < deadline:
            for page in context.pages:
                if HOME_HOST in page.url:
                    return page
            time.sleep(0.4)
        # 仍停留在登录页：多半是账号密码错误
        if HOME_HOST not in fallback_page.url:
            raise LoginFailed("登录失败：用户名或密码错误（或登录页结构已变更）")
        return fallback_page

    def _prune_expired(self):
        """清理超过 TTL 未活跃的上下文，避免内存随 token 无限增长。"""
        now = time.time()
        for token in list(self._last_used):
            if now - self._last_used[token] > self.session_ttl:
                self._drop_in_thread(token)
                with self._meta_lock:
                    self._meta.pop(token, None)

    def _ensure_attendance_page(self, page):
        """进入「教务管理 → 课表和点名」（幂等：已在该页则直接返回）。"""
        on_page = page.evaluate(
            "() => !!document.querySelector('aside.ccm-rooms')"
            " && !!document.querySelector('main.ccm-schedule')")
        if on_page:
            return
        # 登录后前端框架需要一点时间渲染二级菜单，先等目标菜单挂载到 DOM
        page.wait_for_selector(
            f'.a-replace[data-pname="{ATTENDANCE_MENU}"]',
            state="attached", timeout=NAV_TIMEOUT)
        # 二级菜单默认收起，用 JS 直接触发 click 可绕开悬停展开的时序问题
        clicked = page.evaluate(
            """(pname) => {
                const target = Array.from(document.querySelectorAll('.a-replace'))
                    .find(e => e.getAttribute('data-pname') === pname);
                if (!target) return false;
                target.click();
                return true;
            }""", ATTENDANCE_MENU)
        if not clicked:
            raise SessionExpired("未找到「课表和点名」菜单，请重新登录")
        page.wait_for_selector("aside.ccm-rooms", state="visible", timeout=NAV_TIMEOUT)
        page.wait_for_selector("main.ccm-schedule", state="visible", timeout=NAV_TIMEOUT)
        page.wait_for_timeout(ROOM_SETTLE_MS)

    def _list_courses_in_thread(self, token):
        """（工作线程内）遍历所有教室，汇总今日课程。"""
        page = self._require_page(token)
        self._ensure_attendance_page(page)

        rooms = page.evaluate(
            """() => Array.from(document.querySelectorAll('aside.ccm-rooms button.ccm-room-card'))
                .map((btn, index) => {
                    const nameEl = btn.querySelector('strong.ccm-room-card__name');
                    return { index: index, name: nameEl ? nameEl.textContent.trim() : '' };
                })""")

        courses = []
        for room in rooms:
            self._select_room(page, room["index"])
            for row in self._read_course_rows(page):
                if not row["code"]:
                    continue   # 无班级代码的行（占位 / 提示）跳过
                courses.append(self._build_course(room["name"], row))
        return courses

    def _list_schedule_in_thread(self, token, start, end):
        """（工作线程内）调用校管家排课接口，返回按日期分组的课程（只读）。"""
        page = self._require_page(token)
        try:
            result = page.evaluate(
                """async (args) => {
                    const {start, end, pageSize, maxPages} = args;
                    const headers = {'X-Requested-With': 'XMLHttpRequest'};
                    const who = await fetch('/api/user/whoami', {headers});
                    if (!who.ok) throw new Error('whoami HTTP ' + who.status);
                    const whoJson = await who.json();
                    const user = (whoJson && whoJson.Data) || {};
                    const campusId = (user.CampusList && user.CampusList[0] && user.CampusList[0].ID) || '';
                    if (!user.ID || !campusId) throw new Error('未读到用户或校区信息');

                    const base = {
                        Grade: '0', Subject: '0', Category: '0', teachType: '-1',
                        startDate: start, endDate: end, teacher: '', shiftName: '',
                        className: '', classroom: '', studentId: '', headMasterName: '',
                        headMasterId: '', masters: '', Year: '', Term: '', ClassType: '0',
                        CourseType: '0', assistantTeacher: '', createUserId: '',
                        teacherRoleType: '0', PageSize: String(pageSize), PageIndex: '0',
                        TotalCount: '0', PageCount: '0', campus: campusId,
                        Forenoon: '1', Afternoon: '1', Nightnoon: '1',
                        finishType: '0,1,2', shiftType: '7', isContainFinished: '0',
                        courseFlag: '', classLabelIds: '', desc: '0', sort: 'StartTime',
                        showField: '学员'
                    };

                    const rows = [];
                    let total = 0;
                    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
                        const body = new URLSearchParams({...base, PageIndex: String(pageIndex)});
                        const res = await fetch('/api/Course/Query', {
                            method: 'POST',
                            headers: {...headers, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
                            body: body.toString()
                        });
                        if (!res.ok) throw new Error('Course/Query HTTP ' + res.status);
                        const data = await res.json();
                        total = Number(data.TotalCount || 0);
                        const list = Array.isArray(data.Data) ? data.Data : [];
                        rows.push(...list);
                        if (!list.length || rows.length >= total) break;
                    }
                    return {
                        user: {id: user.ID, name: user.FullName || user.UserName || '', campusId},
                        rows, total
                    };
                }""",
                {"start": start, "end": end, "pageSize": 500, "maxPages": 10},
            )
        except Exception as error:  # noqa: BLE001
            raise AttendanceError(self._brief(error)) from error

        user = result.get("user") or {}
        rows = result.get("rows") or []
        return {
            "teacher": user.get("name") or "",
            "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "total": len(rows),
            "days": self._group_schedule_rows(rows, str(user.get("id") or "")),
        }

    @staticmethod
    def _group_schedule_rows(rows, teacher_id):
        """把排课接口返回的行按日期 / 时间段合并成前端易用的结构。"""
        days = {}
        teacher_key = (teacher_id or "").lower()
        for row in rows:
            if teacher_key and teacher_key not in str(row.get("TeacherIDs") or "").lower():
                continue
            start = str(row.get("StartTime") or "")
            end = str(row.get("EndTime") or "")
            if len(start) < 16:
                continue
            day = start[:10]
            start_hm, end_hm = start[11:16], end[11:16]
            entry = days.setdefault(day, {"count": 0, "groups": {}})
            group = entry["groups"].setdefault(
                (start_hm, end_hm),
                {"start": start_hm, "end": end_hm, "classes": []})
            group["classes"].append({
                "name": str(row.get("ClassName") or ""),
                "room": str(row.get("ClassroomName") or ""),
            })
            entry["count"] += 1

        result = {}
        for day in sorted(days):
            entry = days[day]
            result[day] = {
                "count": entry["count"],
                "groups": [entry["groups"][key] for key in sorted(entry["groups"])],
            }
        return result

    def _select_room(self, page, room_index):
        """点击指定教室并等待课程列表切换完成。"""
        page.evaluate(
            """(index) => {
                const rooms = document.querySelectorAll('aside.ccm-rooms button.ccm-room-card');
                if (rooms[index]) rooms[index].click();
            }""", room_index)
        # 等待选中态落到目标教室，避免读到上一个教室的课程
        page.wait_for_function(
            """(index) => {
                const rooms = document.querySelectorAll('aside.ccm-rooms button.ccm-room-card');
                if (!rooms[index]) return false;
                return rooms[index].classList.contains('ccm-room-card--selected');
            }""", arg=room_index, timeout=NAV_TIMEOUT)
        page.wait_for_timeout(ROOM_SETTLE_MS)

    @staticmethod
    def _read_course_rows(page):
        """读取当前教室的课程卡片（只取结构化字段，不做业务换算）。"""
        return page.evaluate(
            """() => Array.from(document.querySelectorAll('main.ccm-schedule li.ccm-course-card'))
                .map(row => {
                    const pick = (sel) => {
                        const el = row.querySelector(sel);
                        return el ? el.textContent.trim() : '';
                    };
                    return {
                        time: pick('.ccm-course-time strong'),
                        code: pick('a.ccm-course-name'),
                        duration: pick('.ccm-course-duration'),
                        teachers: pick('.ccm-course-teachers'),
                        attendance: pick('.ccm-course-attendance'),
                    };
                })""")

    @staticmethod
    def _build_course(room_name, row):
        """把原始课程行整理为前端需要的结构。"""
        signed, total = BrowserWorker._parse_attendance(row["attendance"])
        status = BrowserWorker._parse_status(row["attendance"])
        return {
            "room": room_name,
            "key": KEY_SEP.join([room_name, row["code"], row["time"]]),
            "classCode": row["code"],
            "courseName": row["code"],
            "time": " · ".join(x for x in (row["time"], row["duration"]) if x),
            "teacher": BrowserWorker._parse_teacher(row["teachers"]),
            "signed": signed,
            "total": total,
            "status": status,
            # 是否已完成点名，由后端统一判定，前端直接使用，避免各处重复推断
            "done": BrowserWorker._is_attended(status, signed, total),
        }

    @staticmethod
    def _is_attended(status, signed, total):
        """
        判断课程是否已经点过名。

        为什么不直接用 signed >= total：点名时若有学员缺勤，已点名课程的
        「出勤数/应到数」会停在 8/9 这种不相等状态，用数字比较会把「已点名」
        误判成「待点名」，于是反复重复点名。所以优先看状态文案——只要不是
        「未点名 / 待点名」，就认定为已完成；文案缺失时才退回数字比较兜底。
        （新版文案如「已点名：13/13 人」「超时-未点名：0/0 人」。）
        """
        head = (status or "").strip()
        if head and "未点名" not in head and "待点名" not in head:
            return True
        return total > 0 and signed >= total

    @staticmethod
    def _parse_attendance(text):
        """解析「未点名 · 0/1人」→ (已出勤数, 应到人数)。"""
        matched = re.search(r"(\d+)\s*/\s*(\d+)", text or "")
        if not matched:
            return 0, 0
        return int(matched.group(1)), int(matched.group(2))

    @staticmethod
    def _parse_status(text):
        """解析点名状态文案 →「已点名」/「未点名」/「超时-未点名」等。

        旧版「未点名 · 0/1人」用间隔号分隔；新版「已点名：13/13 人」用冒号，
        两种分隔符都兼容。
        """
        head = re.split(r"[·：:]", text or "", maxsplit=1)[0].strip()
        return head

    @staticmethod
    def _parse_teacher(text):
        """从「任课老师：数形许 助教：- 班主任：-」中取出任课老师。"""
        matched = re.search(r"任课老师[：:]\s*([^\s]+)", text or "")
        return matched.group(1) if matched else ""

    def _open_roster_modal(self, page, key):
        """定位课程行 → 打开该行操作菜单 → 点「补点名」→ 等待弹窗与名单就绪。"""
        room_name, class_code, course_time = self._split_key(key)
        # 先切到目标教室（课程行只在当前教室下渲染）
        self._select_room_by_name(page, room_name)

        # 定位课程行下标。为什么不全局找「补点名」：每一行的操作下拉菜单都
        # 同时存在于 DOM 中，全局查询会命中第一行的菜单，从而点到别的课程。
        target = page.evaluate(
            """(want) => {
                const rows = Array.from(document.querySelectorAll(
                    'main.ccm-schedule li.ccm-course-card'));
                const index = rows.findIndex(row => {
                    const code = row.querySelector('a.ccm-course-name');
                    const time = row.querySelector('.ccm-course-time strong');
                    return code && time
                        && code.textContent.trim() === want.code
                        && time.textContent.trim() === want.time;
                });
                if (index < 0) return null;
                // 顺带取该行「0/9人」里的应到人数，用于等名单加载完成
                const attendance = rows[index].querySelector('.ccm-course-attendance');
                const matched = attendance
                    && attendance.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
                return { index: index, total: matched ? parseInt(matched[2], 10) : 0 };
            }""", {"code": class_code, "time": course_time})
        if target is None:
            raise AttendanceError("未找到对应课程行，请刷新课程列表后重试")

        # 打开该行的操作下拉。这里用 JS 点击而非 locator.click()：页面上常驻
        # 「新手引导」遮罩 div.guide-mask，会拦截真实鼠标点击事件。
        page.evaluate(
            """(index) => {
                const rows = document.querySelectorAll(
                    'main.ccm-schedule li.ccm-course-card');
                const row = rows[index];
                if (!row) return;
                const toggle = row.querySelector('.ccm-more-actions .dropdown-toggle');
                if (toggle) toggle.click();
            }""", target["index"])
        page.wait_for_timeout(150)   # 留出下拉展开的时间

        # 只在该行内找「补点名」并点击
        opened = page.evaluate(
            """(args) => {
                const rows = document.querySelectorAll(
                    'main.ccm-schedule li.ccm-course-card');
                const row = rows[args.index];
                if (!row) return false;
                const link = Array.from(row.querySelectorAll(
                    '.ccm-more-actions .dropdown-menu li a'))
                    .find(a => a.textContent.trim() === args.text);
                if (!link) return false;
                link.click();
                return true;
            }""", {"index": target["index"], "text": COURSE_MENU_TEXT})
        if not opened:
            raise AttendanceError("未找到「补点名」入口，页面结构可能已变更")

        self._wait_modal(page, visible=True)
        self._wait_modal_rows(page, target["total"])

    def _select_room_by_name(self, page, room_name):
        """按教室名称切换（名称重复时取第一个）。"""
        index = page.evaluate(
            """(target) => {
                const rooms = Array.from(document.querySelectorAll(
                    'aside.ccm-rooms button.ccm-room-card'));
                return rooms.findIndex(btn => {
                    const nameEl = btn.querySelector('strong.ccm-room-card__name');
                    return nameEl && nameEl.textContent.trim() === target;
                });
            }""", room_name)
        if index < 0:
            raise AttendanceError(f"未找到教室「{room_name}」，课程可能已变更")
        self._select_room(page, index)

    @staticmethod
    def _split_key(key):
        """拆分课程 key；格式异常时抛业务错误。"""
        parts = (key or "").split(KEY_SEP)
        if len(parts) != 3:
            raise AttendanceError("课程标识无效，请刷新课程列表后重试")
        return parts[0], parts[1], parts[2]

    @staticmethod
    def _wait_modal(page, visible=True):
        """等待点名弹窗出现 / 关闭（只认当前可见的那个，避免读到残留弹窗）。"""
        expression = f"!!({VISIBLE_MODAL_JS})" if visible else f"!({VISIBLE_MODAL_JS})"
        page.wait_for_function(f"() => {expression}", timeout=MODAL_TIMEOUT)

    @staticmethod
    def _wait_modal_rows(page, expected_total):
        """
        等待弹窗内学员行渲染完成。
        名单是弹窗打开后异步拉取的，若不等待会读到空表；
        以课程行上的「应到人数」作为就绪信号。
        """
        if expected_total <= 0:
            return
        try:
            page.wait_for_function(
                "() => { const modal = " + VISIBLE_MODAL_JS + ";"
                " return !!modal"
                f" && modal.querySelectorAll('tbody tr').length >= {int(expected_total)}; }}",
                timeout=MODAL_TIMEOUT)
        except PWTimeout as error:
            # 宁可报错也不要按残缺名单提交，否则会把未加载的学员误标为缺勤
            raise AttendanceError("学员名单加载超时，请稍后重试") from error
        page.wait_for_timeout(120)   # 留出框架补齐单元格内容的时间

    @staticmethod
    def _click_modal_button(page, data_test):
        """点击当前可见弹窗内指定 data-test 的按钮。"""
        page.evaluate(
            "() => { const modal = " + VISIBLE_MODAL_JS + ";"
            " const button = modal && modal.querySelector('button[data-test=\"" + data_test + "\"]');"
            " if (button) button.click(); }")

    @staticmethod
    def _read_modal_rows(page):
        """读取当前可见弹窗内每个学员：学号、姓名、手机号、是否已勾选出勤。"""
        return page.evaluate(
            "() => { const modal = " + VISIBLE_MODAL_JS + ";"
            " if (!modal) return [];"
            " return Array.from(modal.querySelectorAll('tbody tr'))"
            "   .filter(tr => !!tr.querySelector('a.operation-link'))"   # 跳过「暂无数据」占位行
            "   .map(tr => {"
            "   const tds = tr.querySelectorAll('td');"
            "   const link = tr.querySelector('a.operation-link');"
            "   const phone = tr.querySelector('.font-desc span');"
            "   const attendTd = tds[2];"   # 出勤列固定为第 3 列（索引 2）
            "   const label = attendTd ? attendTd.querySelector('label.checkbox-styled2') : null;"
            "   const reasonCell = tds[5];"
            "   const reasonText = reasonCell"
            "     ? reasonCell.querySelector('.chosen-container-multi > a > span')"
            "     : null;"
            "   const reason = reasonText"
            "     ? reasonText.textContent.trim().replace(/^\\d+\\s*[-：:]\\s*/, '')"
            "     : '';"
            "   const raw = link ? link.textContent.trim() : '';"
            "   const matched = raw.match(/^(\\d+)(.*)$/);"   # 「36944沈怿昕」→ 学号 + 姓名
            "   return {"
            "     id: matched ? matched[1] : raw,"
            "     name: matched ? matched[2] : '',"
            "     phone: phone ? phone.textContent.trim() : '',"
            "     present: !!label && label.classList.contains('checked'),"
            "     reason: reason"
            "   };"
            " }); }")

    def _roster_in_thread(self, token, key):
        """（工作线程内）打开弹窗读取名单后关闭，不做任何提交。"""
        page = self._require_page(token)
        self._ensure_attendance_page(page)
        self._open_roster_modal(page, key)
        students = self._read_modal_rows(page)
        meta = self._read_modal_meta(page)
        # 点「取消」关闭，确保不产生任何数据变更
        self._cancel_modal(page)
        self._wait_modal(page, visible=False)
        return {"students": students, "meta": meta}

    @staticmethod
    def _read_modal_meta(page):
        """读取弹窗头部的课程信息（班级 / 课程名 / 时间 / 老师）。"""
        return page.evaluate(
            "() => { const modal = " + VISIBLE_MODAL_JS + ";"
            " const out = {};"
            " if (!modal) return out;"
            " modal.querySelectorAll('.el-form-item').forEach(item => {"
            "   const label = item.querySelector('.el-form-label');"
            "   const content = item.querySelector('.el-form-content');"
            "   if (!label || !content) return;"
            "   const name = label.textContent.replace(/[：:]/g, '').trim();"
            "   if (name in out) return;"   # 同名标签取首次出现（后续多为下拉占位）
            "   out[name] = content.textContent.replace(/\\s+/g, ' ').trim();"
            " });"
            " return out; }")

    @staticmethod
    def _unknown_present_ids(students, present_ids):
        """返回名单中不存在的学号，防止过期/串课请求把未知 ID 当成缺勤。"""
        known = {str(student.get("id", "")) for student in students}
        wanted = {str(item) for item in (present_ids or [])}
        return sorted(wanted - known)

    def _apply_present_flags(self, page, students, present_ids):
        """
        按 present_ids 校正每一行的出勤勾选状态，返回实际改动的行数。
        必须点击 label（而非直接改 class）才会触发框架更新视图模型；
        行过滤条件与 _read_modal_rows 一致，保证下标与 students 一一对应。
        """
        changed = 0
        for index, student in enumerate(students):
            want_present = student["id"] in present_ids
            if student["present"] == want_present:
                continue
            page.evaluate(
                "(index) => { const modal = " + VISIBLE_MODAL_JS + ";"
                " if (!modal) return;"
                " const rows = Array.from(modal.querySelectorAll('tbody tr'))"
                "   .filter(tr => !!tr.querySelector('a.operation-link'));"
                " const row = rows[index];"
                " if (!row) return;"
                " const tds = row.querySelectorAll('td');"
                " const label = tds[2] && tds[2].querySelector('label.checkbox-styled2');"
                " if (label) label.click(); }",
                index)
            changed += 1
            page.wait_for_timeout(60)   # 留出框架重绘时间
        return changed

    @staticmethod
    def _set_absence_reason(page, index, reason):
        """在指定学员行的「缺勤原因」中选择事假 / 病假 / 旷课。"""
        if reason not in ABSENCE_REASONS:
            raise AttendanceError(f"不支持的缺勤原因：{reason}")

        selected = page.evaluate(
            "(args) => { const modal = " + VISIBLE_MODAL_JS + ";"
            " if (!modal) return false;"
            " const rows = Array.from(modal.querySelectorAll('tbody tr'))"
            "   .filter(tr => !!tr.querySelector('a.operation-link'));"
            " const row = rows[args.index];"
            " if (!row) return false;"
            " const headers = Array.from(modal.querySelectorAll('thead th'));"
            " let reasonIndex = headers.findIndex(th => th.textContent.includes('缺勤原因'));"
            " if (reasonIndex < 0) reasonIndex = 5;"
            " const cell = row.querySelectorAll('td')[reasonIndex];"
            " if (!cell) return false;"
            " const chooser = cell.querySelector('.chosen-container-multi');"
            " if (!chooser) return false;"
            " const trigger = chooser.querySelector('a');"
            " if (trigger) {"
            "   trigger.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));"
            "   trigger.click();"
            " }"
            " const option = Array.from(chooser.querySelectorAll('.chosen-drop li'))"
            "   .find(li => (li.textContent || '').trim().endsWith(args.reason));"
            " if (!option) return false;"
            " option.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));"
            " option.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));"
            " option.click();"
            " return true; }",
            {"index": index, "reason": reason})
        if not selected:
            raise AttendanceError(f"无法为第 {index + 1} 名缺勤学员选择原因")
        page.wait_for_timeout(100)

    @staticmethod
    def _set_parent_notify(page, notify_parents):
        """设置弹窗底部「给家长发送签到信息」开关（默认不发送）。"""
        page.evaluate(
            "(notify) => { const modal = " + VISIBLE_MODAL_JS + ";"
            " const box = modal && modal.querySelector('.modal-footer input[type=checkbox]');"
            " if (box && box.checked !== notify) box.click(); }",
            bool(notify_parents))

    def _submit_in_thread(
            self, token, key, present_ids, notify_parents, absence_reasons):
        """（工作线程内）勾选出勤状态并提交。"""
        page = self._require_page(token)
        self._ensure_attendance_page(page)
        self._open_roster_modal(page, key)

        students = self._read_modal_rows(page)
        if not students:
            self._cancel_modal(page)
            raise AttendanceError("该课程没有学员，无法点名")

        unknown = self._unknown_present_ids(students, present_ids)
        if unknown:
            self._cancel_modal(page)
            preview = "、".join(unknown[:3])
            more = f" 等 {len(unknown)} 个" if len(unknown) > 3 else ""
            raise AttendanceError(
                f"名单中不存在学号：{preview}{more}，请刷新课程后重试")

        changed = self._apply_present_flags(page, students, present_ids)
        for index, student in enumerate(students):
            reason = absence_reasons.get(student["id"])
            if (
                    student["id"] not in present_ids
                    and reason
                    and student.get("reason") != reason):
                self._set_absence_reason(page, index, reason)
        self._set_parent_notify(page, notify_parents)

        # 提交
        self._click_modal_button(page, "confirm-attendance")

        try:
            self._wait_modal(page, visible=False)
        except PWTimeout as error:
            # 未能关闭：多半是校验未通过（如缺勤缺原因），保留现场并报错
            self._cancel_modal(page)
            raise AttendanceError(
                "提交未成功：弹窗仍处于打开状态，请检查是否有必填项（如缺勤原因）"
            ) from error

        return {"ok": True, "changed": changed, "total": len(students)}

    @staticmethod
    def _cancel_modal(page):
        """兜底关闭当前可见弹窗，避免污染下一次操作。"""
        try:
            BrowserWorker._click_modal_button(page, "cancel-attendance")
        except Exception:  # noqa: BLE001 兜底操作失败无需上报
            pass

    @staticmethod
    def _brief(error):
        """压缩异常信息，避免把超长堆栈暴露给前端。"""
        text = str(error).strip().splitlines()[0] if str(error).strip() else "未知错误"
        return text[:160]


# ---------------- 命令行自检（本地干跑用，不会提交任何考勤） ----------------
def _cli():
    """
    用法：
      python attendance.py probe              只读探测：登录并打印今日课程
      python attendance.py restore            只读探测：仅用已存登录态恢复后打印今日课程
      python attendance.py roster <key>       只读探测：打印某课程学员名单
    """
    config_path = __file__.replace("attendance.py", "config.json")
    config = json.loads(open(config_path, encoding="utf-8").read())
    account = config["xiaogj"]
    headless = bool(config.get("options", {}).get("浏览器无头模式", True))

    worker = BrowserWorker(headless=headless)
    mode = sys.argv[1] if len(sys.argv) > 1 else "probe"
    try:
        if mode == "restore":
            # 免密路径：不给密码，只允许恢复已保存登录态
            worker.restore("cli", account["username"])
        else:
            worker.login("cli", account["username"], account["password"])
        if mode in ("probe", "restore"):
            courses = worker.list_courses("cli")
            print(json.dumps(courses, ensure_ascii=False, indent=2))
        elif mode == "roster":
            if len(sys.argv) < 3:
                print("缺少课程 key")
                return
            print(json.dumps(worker.read_roster("cli", sys.argv[2]), ensure_ascii=False, indent=2))
        else:
            print(f"未知模式：{mode}")
    except AttendanceError as error:
        print(f"[错误] {error}")
    finally:
        worker.close()


if __name__ == "__main__":
    _cli()
