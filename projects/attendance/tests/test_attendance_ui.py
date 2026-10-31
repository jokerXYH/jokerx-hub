# -*- coding: utf-8 -*-
"""End-to-end contract test for the attendance UI using mocked API data."""

import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PORT = 8765
OUT = Path(tempfile.gettempdir()) / "codex-attendance-ui"
OUT.mkdir(parents=True, exist_ok=True)

COURSES = [
    {
        "room": "A101",
        "key": "A101\x1f课程A\x1f09:00",
        "classCode": "数学 A 班",
        "courseName": "数学 A 班",
        "time": "09:00 · 90 分钟",
        "teacher": "王老师",
        "signed": 0,
        "total": 3,
        "status": "未点名",
        "done": False,
    },
    {
        "room": "A101",
        "key": "A101\x1f课程B\x1f10:45",
        "classCode": "数学 B 班",
        "courseName": "数学 B 班",
        "time": "10:45 · 90 分钟",
        "teacher": "李老师",
        "signed": 0,
        "total": 2,
        "status": "未点名",
        "done": False,
    },
    {
        "room": "B203",
        "key": "B203\x1f课程C\x1f14:00",
        "classCode": "英语 C 班",
        "courseName": "英语 C 班",
        "time": "14:00 · 90 分钟",
        "teacher": "陈老师",
        "signed": 4,
        "total": 4,
        "status": "已点名",
        "done": True,
    },
]

STUDENTS = [
    {"id": "001", "name": "陈同学", "phone": "13800000001", "present": True},
    {"id": "002", "name": "林同学", "phone": "13800000002", "present": True},
    {"id": "003", "name": "周同学", "phone": "13800000003", "present": True},
]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    submitted = []

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, channel="msedge")
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, locale="zh-CN")

            def api_route(route):
                path = route.request.url.split("?")[0]
                if path.endswith("/status"):
                    payload = {"loggedIn": True, "username": "测试账号"}
                elif path.endswith("/courses"):
                    payload = {"courses": COURSES}
                elif path.endswith("/roster"):
                    payload = {
                        "students": STUDENTS,
                        "meta": {
                            "班级名称": "数学 A 班",
                            "课程名称": "阶段数学",
                            "上课时间": "2026-10-31 09:00-10:30",
                            "任课老师": "王老师",
                        },
                    }
                elif path.endswith("/submit"):
                    submitted.append(route.request.post_data_json)
                    payload = {"ok": True, "changed": 1, "total": 3}
                else:
                    payload = {}
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(payload, ensure_ascii=False),
                )

            page.route("**/api/**", api_route)
            page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")

            expect(page.locator("#courseSearch").count() == 1, "缺少课程搜索")
            expect(page.locator("#statusFilter").count() == 1, "缺少状态筛选")
            expect(page.locator("#courseList [data-course-card]").count() == 3, "课程卡片数量不正确")
            expect(page.locator("#rosterModal").count() == 0, "名单不应继续使用独立弹窗")

            page.locator("#courseSearch").fill("英语")
            expect(page.locator("#courseList [data-course-card]").count() == 1, "课程搜索未生效")
            page.locator("#courseSearch").fill("")
            page.locator("#statusFilter [data-filter='pending']").click()
            expect(page.locator("#courseList [data-course-card]").count() == 2, "待点名筛选未生效")
            page.locator("#statusFilter [data-filter='all']").click()

            first_toggle = page.locator("#courseList [data-action='toggle-roster']").first
            expect(first_toggle.get_attribute("aria-expanded") == "false", "名单初始应为收起状态")
            first_toggle.click()
            page.wait_for_selector("[data-roster-panel]:visible .student-row")

            rows = page.locator("[data-roster-panel]:visible .student-row")
            expect(rows.count() == 3, "展开后学员名单数量不正确")
            expect(page.locator("[data-roster-panel]:visible .student-attendance-input:checked").count() == 3, "默认应尊重校管家出勤状态")

            roster_search = page.locator("[data-roster-panel]:visible [data-action='roster-search']")
            roster_search.fill("林")
            expect(page.locator("[data-roster-panel]:visible .student-row:visible").count() == 1, "学员搜索未生效")
            roster_search.fill("")
            expect(page.locator("[data-roster-panel]:visible .student-row:visible").count() == 3, "清空学员搜索后名单未恢复")

            first_present = page.locator("[data-roster-panel]:visible .student-attendance-input").first
            first_present.uncheck()
            reason = page.locator("[data-roster-panel]:visible .absence-reason").first
            expect(reason.is_visible(), "缺勤后应显示原因选择")
            reason.select_option("病假")

            second_present = page.locator("[data-roster-panel]:visible .student-attendance-input").nth(1)
            second_present.uncheck()
            page.locator("[data-roster-panel]:visible .absence-reason").nth(1).select_option("事假")

            summary = page.locator("[data-roster-panel]:visible [data-role='roster-summary']")
            expect("出勤 1" in summary.inner_text(), "考勤统计未实时更新")
            expect("缺勤 2" in summary.inner_text(), "缺勤统计未实时更新")

            page.locator("[data-roster-panel]:visible [data-action='submit-roster']").click()
            dialog = page.locator("#confirmDialog")
            expect(dialog.is_visible(), "提交前缺少确认对话框")
            expect("2 人缺勤" in dialog.inner_text(), "确认对话框未显示缺勤人数")
            page.locator("#confirmSubmitBtn").click()
            page.wait_for_timeout(100)

            expect(len(submitted) == 1, "确认后应提交一次")
            expect(submitted[0]["presentIds"] == ["003"], "提交的出勤名单不正确")
            expect(
                submitted[0]["absenceReasons"] == {"001": "病假", "002": "事假"},
                "提交的缺勤原因不正确",
            )

            page.screenshot(path=str(OUT / "desktop.png"), full_page=True)
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(100)
            expect(
                page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
                "移动端出现横向溢出",
            )
            page.screenshot(path=str(OUT / "mobile.png"), full_page=True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    print("PASS: attendance UI contract")
    print(f"screenshots={OUT}")


if __name__ == "__main__":
    main()
