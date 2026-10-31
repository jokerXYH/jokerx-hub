# -*- coding: utf-8 -*-
"""校管家纯接口考勤客户端（不依赖 Playwright）。"""

import argparse
import http.cookiejar
import json
import os
import re
import sys
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest


LOGIN_URL = "https://tms22.xiaogj.com/login.aspx"
LOGIN_API = "https://tms22.xiaogj.com/api/login/LoginGate"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
EMPTY_GUID = "00000000-0000-0000-0000-000000000000"
ABSENCE_REASONS = ("事假", "病假", "旷课")
DATA_DIR = Path(__file__).resolve().parent / "data"
STATE_FILE = DATA_DIR / "api_session.json"

DISPLAY_ONLY_FIELDS = {
    "canCost", "remainAmount", "MachineChecked", "canAttend", "highlight",
    "FreezeCount", "OutAmount", "RemainAmount", "AbsentCauseCount",
    "CanUseShiftRelation", "HasShiftRelationRemain", "hasShiftRelationRemain",
    "IsShiftRelation", "DefaultAttend", "FaceCreateTime", "IsSign",
    "DelayLimit", "DelayLimitList", "CustomerStudentID", "EndDate", "Unit",
    "IsDynamicConsume", "FeeCusTypesName", "IsTwins", "IsConfirmed", "SMSTel",
    "StudentStatus", "StudentType", "IsSource", "AwawType", "CreateTime",
    "Photo", "StudentPhoto", "CostDisabledByArrears", "AvailableReceipts",
}


class ApiError(Exception):
    """接口业务异常。"""


class ApiLoginFailed(ApiError):
    """账号或密码错误。"""


class ApiSessionExpired(ApiError):
    """登录状态失效。"""


def _as_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _brief(value, limit=180):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def build_course_list(rows, teacher_id):
    """把 Course/Query 原始行转换成前端课程结构。"""
    teacher_key = str(teacher_id or "").strip().lower()
    courses = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        if teacher_key and teacher_key not in str(row.get("TeacherIDs") or "").lower():
            continue
        course_id = str(row.get("ID") or "").strip()
        if not course_id:
            continue
        start = str(row.get("StartTime") or "")
        end = str(row.get("EndTime") or "")
        start_hm = start[11:16] if len(start) >= 16 else ""
        end_hm = end[11:16] if len(end) >= 16 else ""
        signed = _as_int(row.get("AttendanceCount"))
        total = _as_int(row.get("StudentCount"))
        finished = _as_int(row.get("Finished")) == 1
        done = finished or (total > 0 and signed >= total)
        courses.append({
            "room": str(row.get("ClassroomName") or "未设置教室"),
            "key": course_id,
            "classCode": str(row.get("ClassName") or ""),
            "courseName": str(row.get("ShiftName") or row.get("ClassName") or ""),
            "time": "-".join(part for part in (start_hm, end_hm) if part),
            "teacher": str(row.get("TeacherNames") or ""),
            "signed": signed,
            "total": total,
            "status": "已点名" if done else "未点名",
            "done": done,
        })
    return courses


def clean_student_for_submit(student):
    """移除页面展示字段，保留 SetAttendance 所需的学生状态。"""
    return {
        key: value for key, value in (student or {}).items()
        if key not in DISPLAY_ONLY_FIELDS
    }


def _can_charge(student):
    if _as_int(student.get("IsDayFeeCost")) == 1:
        return False
    if str(student.get("AwawType") or "").strip():
        return False
    if "canCost" in student:
        return bool(student.get("canCost"))
    if student.get("CostDisabledByArrears") in (True, 1, "1", "true", "True"):
        return False
    status = student.get("StudentStatus")
    if status not in (None, "", 0, "0", 1, "1"):
        return False
    return True


def _last_class_time(course):
    start = str(course.get("StartTime") or "")
    end = str(course.get("EndTime") or "")
    if len(start) < 16 or len(end) < 16:
        return ""
    try:
        day = datetime.fromisoformat(start).strftime("%a")
    except ValueError:
        day = ""
    return f"{start[:10]}{start[11:16]}-{end[11:16]}[{day}]"


def _reason_name(value):
    """去掉字典值中的序号，只保留事假 / 病假 / 旷课。"""
    return re.sub(r"^\d+\s*[-：:]\s*", "", str(value or "").strip())


def build_submit_payload(
        course, present_ids, notify_parents, absence_reasons=None, absence_causes=None):
    """构造与校管家 classCheckForm.js 一致的提交结构。"""
    course = course or {}
    students = [clean_student_for_submit(item) for item in (course.get("students") or [])]
    wanted = {str(item) for item in (present_ids or [])}
    known = {str(item.get("ID") or "") for item in students}
    unknown = sorted(wanted - known)
    if unknown:
        preview = "、".join(unknown[:3])
        more = f" 等 {len(unknown)} 个" if len(unknown) > 3 else ""
        raise ApiError(f"名单中不存在学号：{preview}{more}，请刷新课程后重试")

    reasons = {
        str(student_id): _reason_name(reason)
        for student_id, reason in (absence_reasons or {}).items()
    }
    unknown_reason_ids = sorted(set(reasons) - known)
    if unknown_reason_ids:
        preview = "、".join(unknown_reason_ids[:3])
        raise ApiError(f"缺勤原因对应了未知学号：{preview}，请刷新课程后重试")
    causes_by_name = {
        _reason_name(item.get("Value") or item.get("Name")): item
        for item in (absence_causes or [])
        if isinstance(item, dict) and _reason_name(item.get("Value") or item.get("Name"))
    }

    for index, student in enumerate(students):
        source = (course.get("students") or [])[index]
        student_id = str(student.get("ID") or "")
        present = student_id in wanted
        student["IsAttend"] = 1 if present else 0
        if present:
            student["AbsentCauseID"] = ""
            student["AbsentCauseName"] = ""
            student["IsCost"] = 1 if _can_charge(source) else 0
        else:
            student["IsCost"] = 0
            reason = reasons.get(student_id, "")
            cause = causes_by_name.get(reason) if reason else None
            if reason and not cause:
                raise ApiError(f"校管家未配置缺勤原因：{reason}")
            student["AbsentCauseID"] = str(cause.get("ID") or "") if cause else EMPTY_GUID
            student["AbsentCauseName"] = (
                str(cause.get("Value") or cause.get("Name") or reason) if cause else ""
            )

    teachers = [item for item in (course.get("Teacher") or []) if isinstance(item, dict)]
    main_teacher = next((item for item in teachers if _as_int(item.get("Role")) == 1), None)
    if main_teacher is None and teachers:
        main_teacher = teachers[0]
    main_teacher = main_teacher or {}

    return {
        "Students": students,
        "CourseID": str(course.get("ID") or ""),
        "Describe": str(course.get("describe") or ""),
        "Content": str(course.get("content") or ""),
        "shiftAmount": str(course.get("shiftAmount") or ""),
        "ShiftScheduleID": str(course.get("scheduleId") or EMPTY_GUID),
        "UpdateTime": str(course.get("updateTime") or ""),
        "Action": 1,
        "Weixin": 1 if notify_parents else 0,
        "LastClasstime": _last_class_time(course),
        "ComeFrom": 1,
        "Agnet": 0,
        "IsEditTeacher": 0 if main_teacher else 1,
        "TeacherID": str(main_teacher.get("ID") or EMPTY_GUID),
        "TeacherCommissionIDs": str(main_teacher.get("TeacherCommissionIDs") or ""),
    }


def _group_schedule_rows(rows, teacher_id):
    days = {}
    teacher_key = str(teacher_id or "").lower()
    for row in rows or []:
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
            {"start": start_hm, "end": end_hm, "classes": []},
        )
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


class ApiWorker:
    """与 BrowserWorker 同接口的纯 HTTP 考勤工作器。"""

    def __init__(self, session_ttl=7 * 24 * 3600, state_file=None):
        self.session_ttl = session_ttl
        self.state_file = Path(state_file) if state_file else STATE_FILE
        self._sessions = {}
        self._lock = threading.RLock()

    def warmup(self):
        return None

    def close(self):
        with self._lock:
            self._sessions.clear()

    def has_saved_state(self):
        return self.state_file.exists()

    def username_of(self, token):
        with self._lock:
            session = self._sessions.get(token)
            return str((session or {}).get("username") or "")

    def is_logged_in(self, token):
        return bool(self.username_of(token))

    def drop(self, token):
        with self._lock:
            self._sessions.pop(token, None)

    def _prune(self):
        now = time.time()
        for token, session in list(self._sessions.items()):
            if now - session.get("last_used", now) > self.session_ttl:
                self._sessions.pop(token, None)

    def _session(self, token):
        with self._lock:
            self._prune()
            session = self._sessions.get(token)
        if not session:
            raise ApiSessionExpired("未登录或会话已过期，请重新登录")
        session["last_used"] = time.time()
        return session

    @staticmethod
    def _opener(jar=None):
        jar = jar or http.cookiejar.CookieJar()
        return urlrequest.build_opener(urlrequest.HTTPCookieProcessor(jar)), jar

    @staticmethod
    def _open(session, method, url, data=None, headers=None, timeout=30):
        request_headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": session.get("base_url", LOGIN_URL) + "/",
        }
        request_headers.update(headers or {})
        request = urlrequest.Request(
            url,
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with session["lock"]:
                with session["opener"].open(request, timeout=timeout) as response:
                    return response.status, response.read()
        except urlerror.HTTPError as exc:
            body = exc.read()
            if exc.code in (401, 403):
                raise ApiSessionExpired("登录状态已失效，请重新登录") from exc
            return exc.code, body
        except urlerror.URLError as exc:
            raise ApiError(f"网络连接失败：{_brief(exc.reason)}") from exc

    def _json_request(self, session, method, url, data=None, headers=None):
        status, raw = self._open(session, method, url, data=data, headers=headers)
        try:
            payload = json.loads(raw.decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError):
            if status in (401, 403):
                raise ApiSessionExpired("登录状态已失效，请重新登录")
            raise ApiError(f"服务返回异常（HTTP {status}）")
        code = _as_int(payload.get("ErrorCode"), status)
        if code in (401, 403):
            raise ApiSessionExpired("登录状态已失效，请重新登录")
        if status >= 400 or code != 200:
            raise ApiError(_brief(payload.get("ErrorMsg") or f"接口请求失败（HTTP {status}）"))
        return payload

    def _login_session(self, username, password):
        opener, jar = self._opener()
        session = {
            "opener": opener,
            "jar": jar,
            "lock": threading.RLock(),
            "username": username,
            "last_used": time.time(),
            "base_url": "",
        }
        status, _ = self._open(session, "GET", LOGIN_URL)
        if status >= 400:
            raise ApiLoginFailed(f"登录页访问失败（HTTP {status}）")
        data = urlparse.urlencode({
            "name": username,
            "pwd": password,
            "jx": "true",
        }).encode("utf-8")
        try:
            payload = self._json_request(
                session,
                "POST",
                LOGIN_API,
                data=data,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Referer": LOGIN_URL,
                },
            )
        except ApiError as exc:
            raise ApiLoginFailed(str(exc)) from exc

        host_text = str(payload.get("ErrorMsg") or "").strip()
        host = urlparse.urlsplit(
            host_text if "://" in host_text else f"https://{host_text}"
        ).hostname or ""
        host = host.replace("xgjtms", "xiaogj")
        if not host.endswith("xiaogj.com"):
            raise ApiLoginFailed("登录后未取得有效机构地址")
        base_url = f"https://{host}"
        session["base_url"] = base_url
        gate_query = urlparse.urlencode({
            "name": username,
            "pwd": password,
            "url": f"{host}/?pname=AppStore",
            "ssx": "undefined",
        })
        status, _ = self._open(
            session,
            "GET",
            f"{base_url}/api/login/GateReturnUrl?{gate_query}",
            headers={"Referer": LOGIN_URL},
        )
        if status >= 400:
            raise ApiLoginFailed(f"机构登录失败（HTTP {status}）")
        who = self._json_request(session, "GET", f"{base_url}/api/user/whoami")
        user = who.get("Data") or {}
        if not user.get("ID"):
            raise ApiLoginFailed("登录状态校验失败")
        session["user"] = user
        return session

    def _save_state(self, session):
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            cookies = []
            for cookie in session["jar"]:
                cookies.append({
                    "name": cookie.name,
                    "value": cookie.value,
                    "domain": cookie.domain,
                    "path": cookie.path,
                    "secure": bool(cookie.secure),
                    "expires": cookie.expires,
                })
            self.state_file.write_text(json.dumps({
                "username": session["username"],
                "base_url": session["base_url"],
                "cookies": cookies,
                "savedAt": datetime.now().isoformat(timespec="seconds"),
            }, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def _load_saved_session(self, username):
        try:
            saved = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        saved_user = str(saved.get("username") or "")
        if username and saved_user and username != saved_user:
            return None
        jar = http.cookiejar.CookieJar()
        for item in saved.get("cookies") or []:
            domain = str(item.get("domain") or "")
            if not domain:
                continue
            jar.set_cookie(http.cookiejar.Cookie(
                version=0,
                name=str(item.get("name") or ""),
                value=str(item.get("value") or ""),
                port=None,
                port_specified=False,
                domain=domain,
                domain_specified=domain.startswith("."),
                domain_initial_dot=domain.startswith("."),
                path=str(item.get("path") or "/"),
                path_specified=True,
                secure=bool(item.get("secure")),
                expires=item.get("expires"),
                discard=False,
                comment=None,
                comment_url=None,
                rest={},
                rfc2109=False,
            ))
        opener, jar = self._opener(jar)
        base_url = str(saved.get("base_url") or "").rstrip("/")
        if not base_url:
            return None
        session = {
            "opener": opener,
            "jar": jar,
            "lock": threading.RLock(),
            "username": saved_user or username,
            "last_used": time.time(),
            "base_url": base_url,
        }
        try:
            who = self._json_request(session, "GET", f"{base_url}/api/user/whoami")
        except ApiError:
            return None
        user = who.get("Data") or {}
        if not user.get("ID"):
            return None
        session["user"] = user
        return session

    def restore(self, token, username):
        session = self._load_saved_session(username)
        if not session:
            raise ApiLoginFailed("登录态已失效，请重新登录")
        with self._lock:
            self._sessions[token] = session

    def login(self, token, username, password, allow_restore=False):
        if allow_restore:
            saved = self._load_saved_session(username)
            if saved:
                with self._lock:
                    self._sessions[token] = saved
                return
        session = self._login_session(username, password)
        with self._lock:
            self._sessions[token] = session
        self._save_state(session)

    def _course_query(self, session, start, end, page_size=500):
        user = session.get("user") or {}
        campus_list = user.get("CampusList") or []
        campus_id = str((campus_list[0] or {}).get("ID") or "") if campus_list else ""
        if not user.get("ID") or not campus_id:
            raise ApiError("未读到用户或校区信息")
        base = {
            "Grade": "0", "Subject": "0", "Category": "0", "teachType": "-1",
            "startDate": start, "endDate": end, "teacher": "", "shiftName": "",
            "className": "", "classroom": "", "studentId": "", "headMasterName": "",
            "headMasterId": "", "masters": "", "Year": "", "Term": "", "ClassType": "0",
            "CourseType": "0", "assistantTeacher": "", "createUserId": "",
            "teacherRoleType": "0", "PageSize": str(page_size), "PageIndex": "0",
            "TotalCount": "0", "PageCount": "0", "campus": campus_id,
            "Forenoon": "1", "Afternoon": "1", "Nightnoon": "1",
            "finishType": "0,1,2", "shiftType": "7", "isContainFinished": "0",
            "courseFlag": "", "classLabelIds": "", "desc": "0", "sort": "StartTime",
            "showField": "学员",
        }
        rows = []
        total = 0
        for page_index in range(10):
            form = dict(base, PageIndex=str(page_index))
            payload = self._json_request(
                session,
                "POST",
                f"{session['base_url']}/api/Course/Query",
                data=urlparse.urlencode(form).encode("utf-8"),
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Referer": f"{session['base_url']}/",
                },
            )
            page_rows = payload.get("Data") or []
            total = _as_int(payload.get("TotalCount"), len(page_rows))
            if not isinstance(page_rows, list) or not page_rows:
                break
            rows.extend(page_rows)
            if len(rows) >= total:
                break
        return rows

    def list_courses(self, token):
        session = self._session(token)
        today = date.today().isoformat()
        rows = self._course_query(session, today, today)
        return build_course_list(rows, (session.get("user") or {}).get("ID"))

    def list_schedule(self, token, start, end):
        session = self._session(token)
        rows = self._course_query(session, start, end)
        user = session.get("user") or {}
        return {
            "teacher": user.get("FullName") or user.get("UserName") or "",
            "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "total": len(rows),
            "days": _group_schedule_rows(rows, str(user.get("ID") or "")),
        }

    def _attendance(self, session, course_id):
        course_id = str(course_id or "").strip()
        if not course_id:
            raise ApiError("缺少课程标识")
        payload = self._json_request(
            session,
            "GET",
            f"{session['base_url']}/api/Course/GetAttendance?"
            + urlparse.urlencode({"id": course_id}),
        )
        data = payload.get("Data") or {}
        if not isinstance(data, dict):
            raise ApiError("课程名单格式异常")
        return data

    def _absent_causes(self, session):
        """读取当前校区的缺勤原因字典，避免把中文名称误当成接口 ID。"""
        user = session.get("user") or {}
        campus_list = user.get("CampusList") or []
        campus_id = str((campus_list[0] or {}).get("ID") or "") if campus_list else ""
        if not campus_id:
            raise ApiError("登录信息中缺少校区标识")
        payload = self._json_request(
            session,
            "GET",
            f"{session['base_url']}/api/Dictionary/Get?"
            + urlparse.urlencode({"type": "ABSENT_CAUSE", "campus": campus_id}),
        )
        return [
            item for item in (payload.get("Data") or [])
            if isinstance(item, dict) and _as_int(item.get("Status"), 1) == 1
        ]

    def read_roster(self, token, key):
        session = self._session(token)
        data = self._attendance(session, key)
        causes = self._absent_causes(session)
        students = []
        for student in data.get("students") or []:
            if not isinstance(student, dict) or not student.get("ID"):
                continue
            students.append({
                "id": str(student.get("ID") or ""),
                "name": str(student.get("Name") or ""),
                "phone": str(student.get("SMSTel") or ""),
                "present": _as_int(student.get("IsAttend")) == 1,
                "reason": _reason_name(student.get("AbsentCauseName")),
            })
        return {
            "students": students,
            "meta": {},
            "absenceReasons": [
                {
                    "id": str(cause.get("ID") or ""),
                    "name": _reason_name(cause.get("Value") or cause.get("Name")),
                    "value": str(cause.get("Value") or ""),
                }
                for cause in causes
            ],
        }

    def submit_attendance(
            self, token, key, present_ids, notify_parents, absence_reasons=None):
        session = self._session(token)
        data = self._attendance(session, key)
        if _as_int(data.get("Finished")) != 0:
            raise ApiError("该课程已经点名，请刷新课程列表")
        original = {
            str(item.get("ID") or ""): _as_int(item.get("IsAttend"))
            for item in (data.get("students") or []) if isinstance(item, dict)
        }
        causes = self._absent_causes(session)
        payload = build_submit_payload(
            data,
            present_ids,
            notify_parents,
            absence_reasons=absence_reasons,
            absence_causes=causes,
        )
        self._json_request(
            session,
            "POST",
            f"{session['base_url']}/api/Course/SetAttendance",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json; charset=UTF-8",
                "Referer": f"{session['base_url']}/",
            },
        )
        wanted = {str(item) for item in (present_ids or [])}
        changed = sum(
            1 for student_id, before in original.items()
            if before != (1 if student_id in wanted else 0)
        )
        return {"ok": True, "changed": changed, "total": len(original)}


def _load_config(path):
    config_path = Path(path or (Path(__file__).resolve().parent / "config.json"))
    config = json.loads(config_path.read_text(encoding="utf-8"))
    account = config.get("xiaogj") or {}
    username = str(account.get("username") or "").strip()
    password = str(account.get("password") or "")
    if not username or not password:
        raise ApiError("config.json 未配置校管家账号")
    return username, password


def _course_at(courses, selector):
    if str(selector).isdigit():
        index = int(selector)
        if 0 <= index < len(courses):
            return courses[index]
        raise ApiError(f"课程序号超出范围：0-{max(0, len(courses) - 1)}")
    for course in courses:
        if course.get("key") == str(selector):
            return course
    return {"key": str(selector), "courseName": str(selector)}


def _print_courses(courses):
    for index, course in enumerate(courses):
        print(
            f"[{index}] {course['time']} {course['room']} "
            f"{course['classCode']} / {course['courseName']} "
            f"{course['signed']}/{course['total']} {course['status']}"
        )
    if not courses:
        print("今日没有课程")


def _cli():
    parser = argparse.ArgumentParser(description="校管家纯接口考勤（默认只读）")
    parser.add_argument("--config", default="")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("courses", help="读取今日课程")
    roster_parser = sub.add_parser("roster", help="读取课程名单")
    roster_parser.add_argument("course", help="课程序号或课程 ID")
    submit_parser = sub.add_parser("submit", help="提交点名")
    submit_parser.add_argument("course", help="课程序号或课程 ID")
    submit_parser.add_argument("--present", default="", help="出勤学号，逗号分隔")
    submit_parser.add_argument("--all", action="store_true", help="全部出勤")
    submit_parser.add_argument("--notify", action="store_true", help="通知家长")
    submit_parser.add_argument("--yes", action="store_true", help="跳过确认")
    args = parser.parse_args()

    try:
        username, password = _load_config(args.config)
        worker = ApiWorker()
        worker.login("cli", username, password)
        courses = worker.list_courses("cli")
        if args.command == "courses":
            _print_courses(courses)
            return 0

        course = _course_at(courses, args.course)
        roster = worker.read_roster("cli", course["key"])
        students = roster.get("students") or []
        if args.command == "roster":
            print(f"{course.get('classCode') or ''} / {course.get('courseName') or ''}")
            for student in students:
                mark = "出勤" if student.get("present") else "未出勤"
                print(f"{student['id']} {student['name']} {mark}")
            return 0

        present_ids = [item.strip() for item in args.present.split(",") if item.strip()]
        if args.all:
            present_ids = [student["id"] for student in students]
        if not present_ids:
            raise ApiError("请用 --all 或将 --present 指定出勤学号")
        if not args.yes:
            answer = input(
                f"将提交 {course.get('classCode') or course['key']}，"
                f"出勤 {len(present_ids)}/{len(students)} 人。输入 yes 继续："
            )
            if answer.strip().lower() not in ("yes", "y"):
                print("已取消")
                return 1
        result = worker.submit_attendance(
            "cli", course["key"], present_ids, args.notify)
        print(f"提交成功：{result['changed']}/{result['total']} 人状态已更新")
        return 0
    except (ApiError, OSError, ValueError) as exc:
        print(f"错误：{_brief(exc)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(_cli())
