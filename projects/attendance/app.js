/**
 * 考勤 · 校管家
 * 课程内展开名单、批量调整状态、缺勤原因与提交前核对。
 */

const API_BASE = window.location.protocol.startsWith('http')
  ? 'api'
  : 'http://127.0.0.1:8974/api';
const API_TIMEOUTS = {
  status: 30000,
  login: 240000,
  courses: 90000,
  roster: 90000,
  submit: 180000,
  logout: 30000,
};
const AUTH_STORAGE_KEY = 'attendance_auth';
const ABSENCE_REASONS = ['事假', '病假', '旷课'];

const ICONS = {
  room: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h16M6 20V8l6-4 6 4v12M9 12h.01M15 12h.01M9 16h.01M15 16h.01"/></svg>',
  teacher: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.4-4.2 2.9-6.4 7-6.4s6.6 2.2 7 6.4"/></svg>',
  users: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="9" cy="9" r="3"/><path d="M3 19c.3-3.6 2.3-5.4 6-5.4s5.7 1.8 6 5.4"/><path d="M15.5 7.2a2.8 2.8 0 0 1 0 5.4M16 16.5c2.6.3 4.1 1.8 4.5 4"/></svg>',
  search: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>',
  chevron: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg>',
};

const state = {
  courses: [],
  expandedKey: null,
  rosters: new Map(),
  courseQuery: '',
  courseFilter: 'all',
  rosterQueries: new Map(),
  rosterFilters: new Map(),
  notifyParents: false,
  savedUser: '',
  actionBusy: false,
  lastBatchFailures: [],
  lastBatchNotify: false,
  confirmAction: null,
  confirmLabel: '确认提交',
  confirmBusy: false,
  confirmReturnFocus: null,
};

let rosterRequestSeq = 0;

/* --------------------------- 基础工具 --------------------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateToken() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function loadAuth() {
  try {
    const auth = JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
    return auth && auth.token ? auth : null;
  } catch (error) {
    return null;
  }
}

function saveAuth(token, username) {
  try {
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, username }));
  } catch (error) {
    // 存储失败不影响本次请求。
  }
}

function clearAuth() {
  try {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch (error) {
    // 忽略存储异常。
  }
}

function currentToken() {
  const auth = loadAuth();
  if (auth) return auth.token;
  const token = generateToken();
  saveAuth(token, '');
  return token;
}

async function api(method, path, body = null, timeout = API_TIMEOUTS.status) {
  const options = {
    method,
    headers: { 'X-Session-Token': currentToken() },
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    options.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeout);
  }
  try {
    const response = await fetch(API_BASE + path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('请求超时，请稍后重试');
      timeoutError.code = 'TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isSessionError(error) {
  return error.status === 401
    || error.message.includes('未登录')
    || error.message.includes('重新登录')
    || error.message.includes('会话');
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('toast--error', isError);
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function showBatchFailures(failures, notify) {
  state.lastBatchFailures = failures.slice();
  state.lastBatchNotify = Boolean(notify);
  const panel = document.getElementById('batchFailures');
  const list = document.getElementById('batchFailureList');
  list.innerHTML = '';
  failures.forEach((item) => {
    const row = document.createElement('li');
    row.textContent = `${item.course.classCode || item.course.courseName || '未知课程'}：${item.message}`;
    list.appendChild(row);
  });
  panel.hidden = false;
  document.getElementById('batchRetryBtn').disabled = false;
}

function clearBatchFailures() {
  state.lastBatchFailures = [];
  state.lastBatchNotify = false;
  document.getElementById('batchFailures').hidden = true;
  document.getElementById('batchFailureList').innerHTML = '';
}

function setInlineError(id, message) {
  const element = document.getElementById(id);
  element.textContent = message || '';
  element.hidden = !message;
}

function showView(loggedIn, username = '') {
  document.getElementById('loginCard').hidden = loggedIn;
  document.getElementById('workArea').hidden = !loggedIn;
  document.getElementById('userArea').hidden = !loggedIn;
  document.getElementById('passwordInput').value = '';
  if (loggedIn) {
    const displayName = username.split('@')[0] || username || '考勤';
    document.getElementById('userBadge').textContent = username;
    document.getElementById('userAvatar').textContent = displayName.slice(0, 1);
  }
}

function splitCourseTime(value) {
  const parts = String(value || '').split('·').map((part) => part.trim()).filter(Boolean);
  return {
    time: parts[0] || '—',
    duration: parts.slice(1).join(' · '),
  };
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? `尾号 ${digits.slice(-4)}` : '';
}

function renderToday() {
  const formatted = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());
  document.getElementById('todayLabel').textContent = formatted;
}

function statusOf(course) {
  if (!course.total) {
    return { label: '无学员', className: 'status-pill--empty' };
  }
  if (course.done) {
    return { label: '已点名', className: 'status-pill--done' };
  }
  return { label: '待点名', className: 'status-pill--pending' };
}

function isPending(course) {
  return Number(course.total) > 0 && !course.done;
}

/* --------------------------- 登录 --------------------------- */

async function handleLogin(event) {
  event.preventDefault();
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  if (!username || !password) {
    setInlineError('loginError', '请输入用户名和密码。');
    return;
  }

  const button = document.getElementById('loginBtn');
  button.disabled = true;
  button.textContent = '正在登录…';
  setInlineError('loginError', '');
  try {
    await api('POST', '/login', { username, password }, API_TIMEOUTS.login);
    saveAuth(currentToken(), username);
    document.getElementById('passwordInput').value = '';
    showView(true, username);
    await loadCourses();
  } catch (error) {
    setInlineError('loginError', error.message);
  } finally {
    button.disabled = false;
    button.textContent = '登录并读取课程';
  }
}

async function handleLogout() {
  if (state.actionBusy) return;
  try {
    await api('POST', '/logout', null, API_TIMEOUTS.logout);
  } catch (error) {
    // 服务端会话可能已经失效。
  }
  clearAuth();
  state.courses = [];
  state.rosters.clear();
  state.expandedKey = null;
  clearBatchFailures();
  closeConfirm();
  closeHelp();
  showView(false);
  showLoginEntry(state.savedUser);
}

function handleSessionExpiry() {
  clearAuth();
  showView(false);
  showLoginEntry(state.savedUser);
  setInlineError('loginError', '登录状态已过期，请重新登录。');
  showToast('登录状态已过期', true);
}

function showLoginEntry(savedUser = '', username = '') {
  if (username) document.getElementById('usernameInput').value = username;
  document.getElementById('quickLoginBtn').hidden = !savedUser;
  document.getElementById('quickLoginHint').hidden = !savedUser;
  document.getElementById('quickLoginUser').textContent = savedUser || '';
}

async function tryRestoreLogin(username) {
  const button = document.getElementById('loginBtn');
  button.disabled = true;
  button.textContent = '正在恢复登录…';
  try {
    await api('POST', '/login', { mode: 'restore', username }, API_TIMEOUTS.login);
    saveAuth(currentToken(), username);
    showView(true, username);
    await loadCourses({ skeleton: true });
    return true;
  } catch (error) {
    return false;
  } finally {
    button.disabled = false;
    button.textContent = '登录并读取课程';
  }
}

async function handleQuickLogin() {
  const button = document.getElementById('quickLoginBtn');
  button.disabled = true;
  button.textContent = '正在登录…';
  setInlineError('loginError', '');
  try {
    const data = await api('POST', '/login', { mode: 'saved' }, API_TIMEOUTS.login);
    const username = data.username || state.savedUser;
    saveAuth(currentToken(), username);
    showView(true, username);
    await loadCourses({ skeleton: true });
  } catch (error) {
    setInlineError('loginError', error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = `一键登录 <span id="quickLoginUser">${escapeHtml(state.savedUser)}</span>`;
  }
}

/* --------------------------- 课程列表 --------------------------- */

function renderCourseSkeleton() {
  document.getElementById('courseList').innerHTML = `
    <div class="skeleton-list" aria-label="正在加载课程">
      <div class="skeleton skeleton--row"></div>
      <div class="skeleton skeleton--row"></div>
      <div class="skeleton skeleton--row"></div>
    </div>`;
}

async function loadCourses({ skeleton = false } = {}) {
  const info = document.getElementById('courseInfo');
  info.textContent = '正在读取今日课程…';
  if (skeleton) renderCourseSkeleton();
  try {
    const data = await api('GET', '/courses', null, API_TIMEOUTS.courses);
    state.courses = Array.isArray(data.courses) ? data.courses : [];
    clearBatchFailures();
    if (!state.courses.some((course) => course.key === state.expandedKey)) {
      state.expandedKey = null;
    }
    renderCourses();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionExpiry();
      return;
    }
    info.textContent = `课程读取失败：${error.message}`;
    document.getElementById('courseList').innerHTML = `
      <div class="course-empty">
        暂时无法读取课程。
        <button class="button button--quiet" id="courseRetryBtn" type="button">重新读取</button>
      </div>`;
    document.getElementById('courseRetryBtn').addEventListener('click', () => loadCourses({ skeleton: true }));
  }
}

function matchesCourse(course) {
  if (state.courseFilter === 'pending' && !isPending(course)) return false;
  if (state.courseFilter === 'done' && !(Number(course.total) > 0 && course.done)) return false;
  const query = state.courseQuery.trim().toLowerCase();
  if (!query) return true;
  return [course.classCode, course.courseName, course.room, course.teacher, course.time]
    .some((value) => String(value || '').toLowerCase().includes(query));
}

function renderFilterCounts() {
  const counts = {
    all: state.courses.length,
    pending: state.courses.filter(isPending).length,
    done: state.courses.filter((course) => Number(course.total) > 0 && course.done).length,
  };
  Object.entries(counts).forEach(([name, count]) => {
    const element = document.querySelector(`[data-count="${name}"]`);
    if (element) element.textContent = count;
  });
  document.querySelectorAll('#statusFilter button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === state.courseFilter));
  });

  const batchButton = document.getElementById('batchPresentBtn');
  batchButton.disabled = counts.pending === 0;
  batchButton.querySelector('span').textContent = counts.pending
    ? `批量全勤 · ${counts.pending} 门`
    : '今日均已点名';
}

function renderCourses() {
  renderFilterCounts();
  const list = document.getElementById('courseList');
  const info = document.getElementById('courseInfo');
  const filtered = state.courses.filter(matchesCourse);

  if (state.courses.length === 0) {
    info.textContent = '今天没有排课';
    list.innerHTML = '<div class="course-empty">今天没有课程，无需考勤。</div>';
    return;
  }

  const pendingCount = state.courses.filter(isPending).length;
  info.textContent = `共 ${state.courses.length} 门课程 · ${pendingCount} 门待点名`;
  if (filtered.length === 0) {
    list.innerHTML = '<div class="course-no-results">没有符合当前条件的课程。</div>';
    return;
  }

  const rooms = new Map();
  filtered.forEach((course) => {
    const room = course.room || '未分配教室';
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room).push(course);
  });

  list.innerHTML = '';
  rooms.forEach((courses, roomName) => {
    const group = document.createElement('section');
    group.className = 'room-group';
    const students = courses.reduce((sum, course) => sum + (Number(course.total) || 0), 0);
    group.innerHTML = `
      <div class="room-heading">
        <strong>${escapeHtml(roomName)}</strong>
        <span>${courses.length} 门课程 · ${students} 人应到</span>
      </div>`;
    courses.forEach((course) => {
      group.insertAdjacentHTML('beforeend', buildCourseCard(course));
    });
    list.appendChild(group);
  });
}

function buildCourseCard(course) {
  const index = state.courses.indexOf(course);
  const expanded = state.expandedKey === course.key;
  const status = statusOf(course);
  const time = splitCourseTime(course.time);
  const rosterId = `roster-${index}`;
  const actionLabel = !course.total ? '暂无学员' : expanded ? '收起名单' : '展开名单';
  const attendanceText = course.total
    ? `${Number(course.signed) || 0}/${Number(course.total)} 人`
    : '暂无应到人员';

  return `
    <article class="course-card" data-course-card data-course-index="${index}">
      <div class="course-overview">
        <div class="course-time">
          <strong>${escapeHtml(time.time)}</strong>
          <span>${escapeHtml(time.duration || '今日课程')}</span>
        </div>
        <button class="course-summary" type="button" data-action="toggle-roster"
          data-course-index="${index}" aria-expanded="${expanded}" aria-controls="${rosterId}"
          ${course.total ? '' : 'disabled'}>
          <span class="course-title-line">
            <span class="course-name">${escapeHtml(course.courseName || course.classCode || '未命名课程')}</span>
            <span class="status-pill ${status.className}">${status.label}</span>
          </span>
          <span class="course-meta">
            ${course.classCode && course.classCode !== course.courseName
              ? `<span>${escapeHtml(course.classCode)}</span>`
              : ''}
            <span>${ICONS.room}${escapeHtml(course.room || '未分配教室')}</span>
            <span>${ICONS.teacher}${escapeHtml(course.teacher || '老师未填写')}</span>
            <span>${ICONS.users}${escapeHtml(attendanceText)}</span>
          </span>
        </button>
        <button class="course-disclosure" type="button" data-action="toggle-roster"
          data-course-index="${index}" aria-expanded="${expanded}" aria-controls="${rosterId}"
          ${course.total ? '' : 'disabled '}>
          <span>${actionLabel}</span>
          ${ICONS.chevron}
        </button>
      </div>
      ${expanded ? renderRosterPanel(course, index, rosterId) : ''}
    </article>`;
}

function renderRosterPanel(course, courseIndex, rosterId) {
  const roster = state.rosters.get(course.key);
  const panelStart = `<section class="roster-panel" id="${rosterId}" data-roster-panel data-course-index="${courseIndex}">`;
  if (!roster || roster.loading) {
    return `${panelStart}
      <div class="skeleton-list" aria-label="正在读取学员名单">
        <div class="skeleton skeleton--row"></div>
        <div class="skeleton skeleton--row"></div>
      </div>
    </section>`;
  }
  if (roster.error) {
    return `${panelStart}
      <div class="roster-error">
        <span>名单读取失败：${escapeHtml(roster.error)}</span>
        <button class="button button--quiet" type="button" data-action="retry-roster"
          data-course-index="${courseIndex}">重新读取</button>
      </div>
    </section>`;
  }
  if (!roster.students.length) {
    return `${panelStart}<div class="course-empty">该课程暂无学员。</div></section>`;
  }

  const meta = roster.meta || {};
  const query = state.rosterQueries.get(course.key) || '';
  const filter = state.rosterFilters.get(course.key) || 'all';
  const className = meta['班级名称'] || course.classCode || '';
  const courseName = meta['课程名称'] || course.courseName || '';
  const time = meta['上课时间'] || course.time || '';
  const teacher = meta['任课老师'] || course.teacher || '';
  const readOnly = Boolean(roster.readOnly || course.done);
  const reasonNames = getRosterReasons(roster);
  const studentsHtml = roster.students
    .map((student, studentIndex) => (
      renderStudentRow(student, courseIndex, studentIndex, reasonNames, readOnly)
    ))
    .join('');

  return `${panelStart}
    <header class="roster-head">
      <div>
        <h4>${escapeHtml(courseName || className)}</h4>
        <p>${escapeHtml([className, time, teacher].filter(Boolean).join(' · '))}</p>
      </div>
      <span class="status-pill status-pill--empty">${roster.students.length} 人</span>
    </header>
    <div class="roster-tools">
      <label class="roster-search">
        ${ICONS.search}
        <input type="search" value="${escapeHtml(query)}" autocomplete="off"
          data-action="roster-search" aria-label="搜索学员" placeholder="搜索姓名或学号">
      </label>
      <div class="bulk-actions" aria-label="批量调整考勤状态" ${readOnly ? 'hidden' : ''}>
        <button type="button" data-action="roster-all-present">全部出勤</button>
        <button type="button" data-action="roster-all-absent">全部缺勤</button>
        <button type="button" data-action="roster-invert">反选</button>
      </div>
    </div>
    <div class="roster-tools">
      <div class="roster-filter" role="group" aria-label="筛选学员">
        ${['all', 'present', 'absent'].map((name) => {
          const labels = { all: '全部', present: '出勤', absent: '缺勤' };
          return `<button type="button" data-action="roster-filter" data-filter="${name}"
            aria-pressed="${filter === name}">${labels[name]}</button>`;
        }).join('')}
      </div>
      <span class="page-meta">批量操作作用于当前筛选结果</span>
    </div>
    <div class="student-list">${studentsHtml}</div>
    <footer class="roster-footer">
      <div>
        <div class="roster-summary" data-role="roster-summary">${rosterSummary(roster.students)}</div>
        <p class="roster-validation" data-role="roster-validation" hidden></p>
      </div>
      ${readOnly ? `
        <div class="roster-footer-actions">
          <span class="readonly-note">已提交，仅查看</span>
          <button class="button button--quiet" type="button" data-action="toggle-roster"
            data-course-index="${courseIndex}">关闭名单</button>
        </div>` : `
        <div class="roster-footer-actions">
          <label class="notify-toggle">
            <input type="checkbox" data-action="roster-notify" ${state.notifyParents ? 'checked' : ''}>
            <span>通知家长</span>
          </label>
          <button class="button button--primary" type="button" data-action="submit-roster"
            data-course-index="${courseIndex}">提交考勤</button>
        </div>`}
    </footer>
  </section>`;
}

function renderStudentRow(
  student, courseIndex, studentIndex, reasonNames = ABSENCE_REASONS, readOnly = false,
) {
  const checkboxId = `student-${courseIndex}-${studentIndex}`;
  const absent = !student.present;
  const meta = [student.id, maskPhone(student.phone)].filter(Boolean).join(' · ');
  const options = reasonNames.map((reason) => (
    `<option value="${reason}" ${student.reason === reason ? 'selected' : ''}>${reason}</option>`
  )).join('');
  return `
    <div class="student-row ${absent ? 'is-absent' : 'is-present'}"
      data-student-row data-student-index="${studentIndex}" data-present="${student.present}">
      <label class="student-main" for="${checkboxId}">
        <input class="student-attendance-input" id="${checkboxId}" type="checkbox"
          data-action="student-attendance" ${student.present ? 'checked' : ''}
          ${readOnly ? 'disabled' : ''}>
        <span class="student-copy">
          <span class="student-name">${escapeHtml(student.name || '未命名学员')}</span>
          <span class="student-meta">${escapeHtml(meta)}</span>
        </span>
        <span class="student-state">${student.present ? '出勤' : '缺勤'}</span>
      </label>
      <label class="student-reason">
        <span>原因</span>
        <select class="absence-reason ${absent && !student.reason ? 'is-invalid' : ''}"
          data-action="student-reason" ${readOnly ? 'disabled' : ''}>
          <option value="">请选择</option>
          ${options}
        </select>
      </label>
    </div>`;
}

function rosterSummary(students) {
  const present = students.filter((student) => student.present).length;
  const absent = students.length - present;
  return `
    <span><i class="summary-dot summary-dot--present"></i>出勤 ${present} 人</span>
    <span><i class="summary-dot summary-dot--absent"></i>缺勤 ${absent} 人</span>
    <span>共 ${students.length} 人</span>`;
}

function getRoster(courseKey) {
  return state.rosters.get(courseKey);
}

function getRosterReasons(roster) {
  return Array.isArray(roster?.reasons) && roster.reasons.length
    ? roster.reasons
    : ABSENCE_REASONS;
}

function getFilteredStudents(course) {
  const roster = getRoster(course.key);
  if (!roster) return [];
  const query = (state.rosterQueries.get(course.key) || '').trim().toLowerCase();
  const filter = state.rosterFilters.get(course.key) || 'all';
  return roster.students.filter((student) => {
    if (filter === 'present' && !student.present) return false;
    if (filter === 'absent' && student.present) return false;
    if (!query) return true;
    return [student.name, student.id, student.phone]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
}

function focusWithinCourse(courseIndex, selector) {
  requestAnimationFrame(() => {
    document.querySelector(
      `[data-course-card][data-course-index="${courseIndex}"] ${selector}`,
    )?.focus();
  });
}

function applyRosterVisibility(course) {
  const panel = document.querySelector(`[data-roster-panel][data-course-index="${state.courses.indexOf(course)}"]`);
  if (!panel) return;
  const visibleIds = new Set(getFilteredStudents(course).map((student) => student.id));
  panel.querySelectorAll('.student-row').forEach((row) => {
    const student = getRoster(course.key).students[Number(row.dataset.studentIndex)];
    row.classList.toggle('is-filtered', !visibleIds.has(student.id));
  });
}

function updateRosterSummary(course) {
  const panel = document.querySelector(`[data-roster-panel][data-course-index="${state.courses.indexOf(course)}"]`);
  const roster = getRoster(course.key);
  if (!panel || !roster) return;
  panel.querySelector('[data-role="roster-summary"]').innerHTML = rosterSummary(roster.students);

  const allowedReasons = getRosterReasons(roster);
  const missingReason = roster.students.filter(
    (student) => !student.present && !allowedReasons.includes(student.reason),
  ).length;
  const validation = panel.querySelector('[data-role="roster-validation"]');
  validation.hidden = missingReason === 0;
  validation.textContent = missingReason
    ? `请为 ${missingReason} 名缺勤学员选择原因。`
    : '';
  const submit = panel.querySelector('[data-action="submit-roster"]');
  if (submit) submit.disabled = missingReason > 0;
  panel.querySelectorAll('.absence-reason').forEach((select) => {
    const student = roster.students[Number(select.closest('.student-row').dataset.studentIndex)];
    select.classList.toggle('is-invalid', !student.present && !student.reason);
  });
}

async function toggleRoster(courseIndex) {
  const course = state.courses[courseIndex];
  if (!course || !Number(course.total)) return;
  if (state.expandedKey === course.key) {
    rosterRequestSeq += 1;
    state.expandedKey = null;
    renderCourses();
    focusWithinCourse(courseIndex, '[data-action="toggle-roster"]');
    return;
  }

  state.expandedKey = course.key;
  if (!state.rosters.has(course.key)) {
    state.rosters.set(course.key, { loading: true, students: [], meta: {} });
  }
  renderCourses();
  if (getRoster(course.key).loading) {
    await loadRoster(course);
  }
  if (state.expandedKey === course.key) {
    focusWithinCourse(courseIndex, '[data-action="toggle-roster"]');
  }
}

async function loadRoster(course) {
  const requestId = ++rosterRequestSeq;
  const previous = getRoster(course.key) || {};
  state.rosters.set(course.key, {
    ...previous,
    loading: true,
    error: '',
  });
  if (state.expandedKey === course.key) renderCourses();
  try {
    const data = await api(
      'POST', '/roster', { key: course.key }, API_TIMEOUTS.roster,
    );
    if (requestId !== rosterRequestSeq) return;
    const students = (data.students || []).map((student) => ({
      ...student,
      present: Boolean(student.present),
      reason: student.reason || '',
    }));
    const meta = data.meta || {};
    if (meta['班级名称']) course.classCode = meta['班级名称'];
    if (meta['课程名称']) course.courseName = meta['课程名称'];
    if (meta['任课老师']) course.teacher = meta['任课老师'];
    state.rosters.set(course.key, {
      loading: false,
      error: '',
      students,
      meta,
      readOnly: Boolean(course.done),
      reasons: (data.absenceReasons || [])
        .map((item) => String(item.name || ''))
        .filter(Boolean),
    });
    if (state.expandedKey === course.key) renderCourses();
  } catch (error) {
    if (requestId !== rosterRequestSeq) return;
    if (isSessionError(error)) {
      handleSessionExpiry();
      return;
    }
    state.rosters.set(course.key, {
      loading: false,
      error: error.message,
      students: [],
      meta: {},
    });
    if (state.expandedKey === course.key) renderCourses();
  }
}

function updateStudent(course, studentIndex, updater) {
  const student = getRoster(course.key).students[studentIndex];
  updater(student);
  const row = document.querySelector(
    `[data-roster-panel][data-course-index="${state.courses.indexOf(course)}"] `
    + `[data-student-index="${studentIndex}"]`,
  );
  if (row) {
    row.classList.toggle('is-absent', !student.present);
    row.classList.toggle('is-present', student.present);
    row.dataset.present = String(student.present);
    row.querySelector('.student-state').textContent = student.present ? '出勤' : '缺勤';
  }
  updateRosterSummary(course);
}

function applyBulkAction(course, action) {
  const roster = getRoster(course.key);
  if (!roster || roster.readOnly || course.done) return;
  const targets = getFilteredStudents(course);
  if (!targets.length) {
    showToast('当前筛选下没有学员', true);
    return;
  }
  const targetIds = new Set(targets.map((student) => student.id));
  getRoster(course.key).students.forEach((student) => {
    if (!targetIds.has(student.id)) return;
    if (action === 'roster-all-present') student.present = true;
    if (action === 'roster-all-absent') student.present = false;
    if (action === 'roster-invert') student.present = !student.present;
  });
  renderCourses();
  focusWithinCourse(state.courses.indexOf(course), `[data-action="${action}"]`);
}

function buildRosterConfirm(course) {
  const roster = getRoster(course.key);
  const present = roster.students.filter((student) => student.present);
  const absent = roster.students.filter((student) => !student.present);
  const absentList = absent.map((student) => `
    <li><span>${escapeHtml(student.name)}</span><span>${escapeHtml(student.reason || '未选原因')}</span></li>
  `).join('');
  return `
    <div class="confirm-course">
      <h3>${escapeHtml(course.courseName || course.classCode)}</h3>
      <p>${escapeHtml([course.room, course.time, course.teacher].filter(Boolean).join(' · '))}</p>
    </div>
    <p class="confirm-summary">共 ${roster.students.length} 人，${present.length} 人出勤，${absent.length} 人缺勤。</p>
    <div class="confirm-stats">
      <div class="confirm-stat"><span>出勤</span><strong>${present.length} 人</strong></div>
      <div class="confirm-stat"><span>缺勤</span><strong>${absent.length} 人</strong></div>
    </div>
    ${absent.length ? `<ul class="confirm-list">${absentList}</ul>` : ''}
    <label class="notify-toggle confirm-notify">
      <input type="checkbox" id="confirmNotify" ${state.notifyParents ? 'checked' : ''}>
      <span>提交后给家长发送签到信息</span>
    </label>`;
}

function openConfirm({ title, body, action, confirmLabel = '确认提交' }) {
  state.confirmReturnFocus = document.activeElement;
  state.confirmAction = action;
  state.confirmLabel = confirmLabel;
  state.confirmBusy = false;
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmBody').innerHTML = body;
  document.getElementById('confirmError').hidden = true;
  document.getElementById('confirmError').textContent = '';
  const submitButton = document.getElementById('confirmSubmitBtn');
  submitButton.disabled = false;
  submitButton.textContent = confirmLabel;
  const dialog = document.getElementById('confirmDialog');
  dialog.hidden = false;
  document.body.style.overflow = 'hidden';
  document.getElementById('confirmNotify')?.addEventListener('change', (event) => {
    state.notifyParents = event.target.checked;
  });
  submitButton.focus();
}

function closeConfirm() {
  const dialog = document.getElementById('confirmDialog');
  if (!dialog || dialog.hidden || state.confirmBusy) return;
  dialog.hidden = true;
  document.body.style.overflow = '';
  state.confirmAction = null;
  state.confirmBusy = false;
  if (state.confirmReturnFocus && document.contains(state.confirmReturnFocus)) {
    state.confirmReturnFocus.focus();
  }
}

function openHelp() {
  if (state.confirmBusy) return;
  const dialog = document.getElementById('helpDialog');
  dialog.hidden = false;
  document.body.style.overflow = 'hidden';
  dialog.querySelector('[data-action="close-help"]')?.focus();
}

function closeHelp() {
  const dialog = document.getElementById('helpDialog');
  if (!dialog || dialog.hidden || state.confirmBusy) return;
  dialog.hidden = true;
  if (document.getElementById('confirmDialog').hidden) {
    document.body.style.overflow = '';
  }
  document.getElementById('helpBtn')?.focus();
}

async function runConfirmAction() {
  if (!state.confirmAction) return;
  const button = document.getElementById('confirmSubmitBtn');
  state.confirmBusy = true;
  state.actionBusy = true;
  button.disabled = true;
  button.textContent = '正在提交…';
  setInlineError('confirmError', '');
  try {
    const result = await state.confirmAction();
    const message = typeof result === 'string' ? result : result?.message;
    const isError = typeof result === 'object' && Boolean(result?.isError);
    state.confirmBusy = false;
    state.actionBusy = false;
    closeConfirm();
    showToast(message || '操作已完成', isError);
  } catch (error) {
    state.confirmBusy = false;
    state.actionBusy = false;
    if (isSessionError(error)) {
      closeConfirm();
      handleSessionExpiry();
      return;
    }
    setInlineError('confirmError', error.message);
    button.disabled = false;
    button.textContent = state.confirmLabel;
  }
}

function submitRoster(courseIndex) {
  const course = state.courses[courseIndex];
  const roster = getRoster(course.key);
  if (!roster || roster.readOnly || course.done) {
    showToast('该课程已点名，名单为只读状态', true);
    return;
  }
  const missingReason = roster.students.filter(
    (student) => (
      !student.present && !getRosterReasons(roster).includes(student.reason)
    ),
  );
  if (missingReason.length) {
    showToast('请先为缺勤学员选择原因', true);
    return;
  }

  openConfirm({
    title: `提交 ${course.classCode || '本课程'} 考勤`,
    body: buildRosterConfirm(course),
    action: async () => {
      const presentIds = roster.students
        .filter((student) => student.present)
        .map((student) => student.id);
      const absenceReasons = {};
      roster.students.forEach((student) => {
        if (!student.present) absenceReasons[student.id] = student.reason;
      });
      await api('POST', '/submit', {
        key: course.key,
        presentIds,
        absenceReasons,
        notifyParents: state.notifyParents,
      }, API_TIMEOUTS.submit);
      course.signed = presentIds.length;
      course.done = true;
      course.status = '已点名';
      renderCourses();
      const absentCount = roster.students.length - presentIds.length;
      return `已提交：出勤 ${presentIds.length} 人，缺勤 ${absentCount} 人`;
    },
  });
}

async function executeCourseBatch(courses, notify) {
  let completed = 0;
  const failures = [];
  for (const course of courses) {
    try {
      const data = await api(
        'POST', '/roster', { key: course.key }, API_TIMEOUTS.roster,
      );
      const presentIds = (data.students || []).map((student) => student.id);
      if (!presentIds.length) throw new Error('该课程没有学员');
      await api('POST', '/submit', {
        key: course.key,
        presentIds,
        absenceReasons: {},
        notifyParents: notify,
      }, API_TIMEOUTS.submit);
      course.signed = presentIds.length;
      course.done = true;
      course.status = '已点名';
      completed += 1;
    } catch (error) {
      if (isSessionError(error)) throw error;
      failures.push({ course, message: error.message });
    }
  }
  renderCourses();
  return { completed, failures };
}

function batchConfirmationBody(courses) {
  const totalPeople = courses.reduce((sum, course) => sum + Number(course.total || 0), 0);
  const courseList = courses.map((course) => (
    `<li><span>${escapeHtml(course.classCode || course.courseName)}</span><span>${course.total} 人</span></li>`
  )).join('');
  return `
    <p class="confirm-summary">仅处理 ${courses.length} 门待点名课程，共 ${totalPeople} 人。已点名课程不会改变。</p>
    <ul class="confirm-list">${courseList}</ul>
    <label class="notify-toggle confirm-notify">
      <input type="checkbox" id="confirmNotify" ${state.notifyParents ? 'checked' : ''}>
      <span>提交后给家长发送签到信息</span>
    </label>`;
}

async function batchAllPresent() {
  const targets = state.courses.filter(isPending);
  if (!targets.length) return;
  openConfirm({
    title: `完成 ${targets.length} 门待点名课程`,
    confirmLabel: '全部设为出勤',
    body: batchConfirmationBody(targets),
    action: async () => {
      const notify = state.notifyParents;
      const result = await executeCourseBatch(targets, notify);
      if (result.failures.length) {
        showBatchFailures(result.failures, notify);
        return {
          message: `完成 ${result.completed} 门，${result.failures.length} 门失败，可在列表下方重试`,
          isError: true,
        };
      }
      return `已完成 ${result.completed} 门课程的考勤`;
    },
  });
}

async function retryFailedBatch() {
  const courses = state.lastBatchFailures.map((item) => item.course).filter(Boolean);
  if (!courses.length) return;
  openConfirm({
    title: `重试 ${courses.length} 门失败课程`,
    confirmLabel: '重试全部出勤',
    body: batchConfirmationBody(courses),
    action: async () => {
      const notify = state.notifyParents;
      const result = await executeCourseBatch(courses, notify);
      if (result.failures.length) {
        showBatchFailures(result.failures, notify);
        return {
          message: `完成 ${result.completed} 门，仍有 ${result.failures.length} 门失败`,
          isError: true,
        };
      }
      clearBatchFailures();
      return `已重试完成 ${result.completed} 门课程`;
    },
  });
}

/* --------------------------- 事件 --------------------------- */

function handleCourseListClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const card = trigger.closest('[data-course-card]');
  const courseIndex = Number(card?.dataset.courseIndex);
  const course = state.courses[courseIndex];
  if (!course) return;

  switch (trigger.dataset.action) {
    case 'toggle-roster':
      toggleRoster(courseIndex);
      break;
    case 'retry-roster':
      loadRoster(course);
      break;
    case 'roster-filter':
      state.rosterFilters.set(course.key, trigger.dataset.filter || 'all');
      renderCourses();
      focusWithinCourse(
        courseIndex,
        `[data-action="roster-filter"][data-filter="${trigger.dataset.filter || 'all'}"]`,
      );
      break;
    case 'roster-all-present':
    case 'roster-all-absent':
    case 'roster-invert':
      applyBulkAction(course, trigger.dataset.action);
      break;
    case 'submit-roster':
      submitRoster(courseIndex);
      break;
    default:
      break;
  }
}

function handleCourseListInput(event) {
  if (event.target.dataset.action !== 'roster-search') return;
  const card = event.target.closest('[data-course-card]');
  const course = state.courses[Number(card.dataset.courseIndex)];
  if (!course) return;
  state.rosterQueries.set(course.key, event.target.value);
  applyRosterVisibility(course);
}

function handleCourseListChange(event) {
  const card = event.target.closest('[data-course-card]');
  const course = state.courses[Number(card?.dataset.courseIndex)];
  if (!course) return;

  if (event.target.dataset.action === 'student-attendance') {
    const studentIndex = Number(event.target.closest('.student-row').dataset.studentIndex);
    updateStudent(course, studentIndex, (student) => {
      student.present = event.target.checked;
    });
  } else if (event.target.dataset.action === 'student-reason') {
    const studentIndex = Number(event.target.closest('.student-row').dataset.studentIndex);
    updateStudent(course, studentIndex, (student) => {
      student.reason = event.target.value;
    });
  } else if (event.target.dataset.action === 'roster-notify') {
    state.notifyParents = event.target.checked;
  }
}

function bindEvents() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('quickLoginBtn').addEventListener('click', handleQuickLogin);
  document.getElementById('passwordInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      document.getElementById('loginForm').requestSubmit();
    }
  });
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('refreshBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    await loadCourses({ skeleton: true });
    button.disabled = false;
  });
  document.getElementById('batchPresentBtn').addEventListener('click', batchAllPresent);
  document.getElementById('batchRetryBtn').addEventListener('click', retryFailedBatch);
  document.getElementById('courseSearch').addEventListener('input', (event) => {
    state.courseQuery = event.target.value;
    renderCourses();
  });
  document.getElementById('statusFilter').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.courseFilter = button.dataset.filter;
    state.expandedKey = null;
    renderCourses();
  });
  document.getElementById('courseList').addEventListener('click', handleCourseListClick);
  document.getElementById('courseList').addEventListener('input', handleCourseListInput);
  document.getElementById('courseList').addEventListener('change', handleCourseListChange);
  document.querySelectorAll('[data-action="close-confirm"]').forEach((element) => {
    element.addEventListener('click', closeConfirm);
  });
  document.querySelectorAll('[data-action="close-help"]').forEach((element) => {
    element.addEventListener('click', closeHelp);
  });
  document.getElementById('helpBtn').addEventListener('click', openHelp);
  document.getElementById('confirmSubmitBtn').addEventListener('click', runConfirmAction);
  document.getElementById('serverRetryBtn').addEventListener('click', init);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeHelp();
      closeConfirm();
    }
  });
}

/* --------------------------- 初始化 --------------------------- */

async function init() {
  renderToday();
  const auth = loadAuth();
  if (auth && auth.username) {
    document.getElementById('usernameInput').value = auth.username;
  }
  document.getElementById('serverBanner').hidden = true;
  try {
    const status = await api('GET', '/status', null, API_TIMEOUTS.status);
    state.savedUser = status.savedUser || '';
    if (status.loggedIn) {
      showView(true, status.username || '');
      await loadCourses({ skeleton: true });
      return;
    }
    showView(false);
    if (auth && auth.username && status.canRestore) {
      showLoginEntry('', auth.username);
      if (await tryRestoreLogin(auth.username)) return;
    }
    showLoginEntry(state.savedUser, auth && auth.username ? auth.username : '');
  } catch (error) {
    document.getElementById('serverBanner').hidden = false;
    document.getElementById('loginCard').hidden = true;
    document.getElementById('workArea').hidden = true;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    init();
  });
} else {
  bindEvents();
  init();
}
