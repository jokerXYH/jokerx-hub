/* ============================================================
   Joker X 中转站 · 交互逻辑
   渲染卡片、搜索过滤、深浅主题、时钟与问候
   ============================================================ */

(function () {
  'use strict';

  // ---- DOM 引用 ----
  const sectionsEl = document.getElementById('sections');
  const searchInput = document.getElementById('searchInput');
  const emptyEl = document.getElementById('empty');
  const clockEl = document.getElementById('clock');
  const greetingEl = document.getElementById('greeting');
  const yearEl = document.getElementById('year');
  const themeToggle = document.getElementById('themeToggle');
  const viewToggle = document.getElementById('viewToggle');
  const weatherEl = document.getElementById('weather');
  const weatherIconEl = document.getElementById('weatherIcon');
  const weatherTempEl = document.getElementById('weatherTemp');

  // ---- 状态 ----
  let searchQuery = '';
  let currentPins = new Set();

  // 置顶按钮图标（实心/描边都用同一枚，靠颜色区分状态）
  const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3.5h6"/><path d="M10 3.5v5.2L6.6 13h10.8L14 8.7V3.5"/><path d="M12 13v7.5"/></svg>';

  // ---- 视图模式：卡片网格 / 图标网格（Launchpad 风），localStorage 持久 ----
  function readViewMode() {
    try {
      const v = localStorage.getItem('jx_view');
      if (v === 'icons') return 'icons';
    } catch (e) { /* 隐私模式忽略 */ }
    return 'cards';
  }
  let viewMode = readViewMode();

  function applyViewMode() {
    document.documentElement.setAttribute('data-view', viewMode);
    if (viewToggle) {
      viewToggle.setAttribute('title', viewMode === 'cards' ? '切换为图标视图' : '切换为卡片视图');
    }
  }

  // ============================================================
  //  初始化
  // ============================================================
  function init() {
    // 校验配置
    if (typeof LINKS === 'undefined' || !Array.isArray(LINKS)) {
      sectionsEl.innerHTML = '<p class="load-error">config.js 未正确加载，请检查文件。</p>';
      return;
    }

    applyViewMode();
    renderSections();
    bindEvents();
    bindTheme();
    startClock();
    setGreeting();
    initWeather();
    registerSW();

    yearEl.textContent = new Date().getFullYear();

    // 快捷键：按 / 聚焦搜索；Esc 清空；搜索框内 ↑/↓ 选择、Enter 打开
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== searchInput) {
        e.preventDefault();
        searchInput.focus();
        return;
      }
      if (document.activeElement !== searchInput) return;
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchQuery = '';
        searchInput.blur();
        renderSections();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
          e.key === 'Enter' || e.key === 'Home' || e.key === 'End') {
        handleNavigateKey(e);
      }
    });
  }

  // ============================================================
  //  渲染：按分类分区（分区顺序 = LINKS 数组顺序）
  // ============================================================
  function renderSections() {
    const q = searchQuery.trim().toLowerCase();
    kbdIndex = -1; // 重新渲染后清空键盘选中态
    const visits = loadVisits();
    const pins = loadPins();
    currentPins = new Set(pins);

    const pinned = [];
    const groups = new Map();
    LINKS.forEach(function (link) {
      if (q && !matchQuery(link, q)) return;
      if (currentPins.has(link.url)) {
        pinned.push(link);
        return;
      }
      const cat = link.cat || '其他';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(link);
    });

    // 手动置顶按置顶顺序排（新置顶的排最前）
    pinned.sort(function (a, b) {
      return pins.indexOf(a.url) - pins.indexOf(b.url);
    });

    if (pinned.length === 0 && groups.size === 0) {
      sectionsEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    const itemFn = viewMode === 'icons' ? renderItemIcon : renderCard;
    const gridClass = viewMode === 'icons' ? 'icon-grid' : 'card-grid';

    const html = [];
    if (pinned.length) {
      html.push(renderGroup('置顶', pinned, visits, itemFn, gridClass, true));
    }
    groups.forEach(function (items, cat) {
      html.push(renderGroup(cat, items, visits, itemFn, gridClass, false));
    });
    sectionsEl.innerHTML = html.join('');

    // 图标加载失败时回退到 mark 单字标识
    sectionsEl.querySelectorAll('.card-icon img').forEach(function (img) {
      img.addEventListener('error', function () {
        const slot = img.parentElement;
        if (slot) slot.textContent = slot.dataset.fallback || '·';
      });
    });
  }

  function renderGroup(title, items, visits, itemFn, gridClass, isPinnedGroup) {
    const ordered = isPinnedGroup ? items : sortByVisits(items, visits);
    const pinIcon = isPinnedGroup
      ? '<svg class="group-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3.5h6"/><path d="M10 3.5v5.2L6.6 13h10.8L14 8.7V3.5"/><path d="M12 13v7.5"/></svg>'
      : '';
    return '<section class="group' + (isPinnedGroup ? ' group--pinned' : '') + '">' +
      '<h2 class="group-title">' +
        '<span class="group-name">' + pinIcon + escapeHtml(title) + '</span>' +
        '<span class="group-count">' + pad2(ordered.length) + '</span>' +
      '</h2>' +
      '<ul class="' + gridClass + '">' + ordered.map(itemFn).join('') + '</ul>' +
    '</section>';
  }

  function matchQuery(link, q) {
    return (link.name || '').toLowerCase().indexOf(q) >= 0 ||
           (link.desc || '').toLowerCase().indexOf(q) >= 0 ||
           (link.pinyin || '').toLowerCase().indexOf(q) >= 0 ||
           (link.url || '').toLowerCase().indexOf(q) >= 0;
  }

  // ---- 搜索键盘导航：↑/↓ 选择、Enter 打开（Shift+Enter 新窗）----
  let kbdIndex = -1;

  function visibleAnchors() {
    return Array.prototype.slice.call(sectionsEl.querySelectorAll('a.card, a.icon-item'));
  }

  function setKbd(list, idx) {
    const prev = list[kbdIndex];
    if (prev) prev.classList.remove('kbd-active');
    if (!list.length) { kbdIndex = -1; return; }
    kbdIndex = (idx + list.length) % list.length;
    const el = list[kbdIndex];
    el.classList.add('kbd-active');
    el.scrollIntoView({ block: 'nearest' });
  }

  function handleNavigateKey(e) {
    const list = visibleAnchors();
    if (!list.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setKbd(list, kbdIndex < 0 ? 0 : kbdIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setKbd(list, kbdIndex < 0 ? list.length - 1 : kbdIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setKbd(list, 0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setKbd(list, list.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // 未选中时默认打开第一个结果（Shift+Enter 换新窗）
      const el = (kbdIndex >= 0 && kbdIndex < list.length) ? list[kbdIndex] : list[0];
      if (!el) return;
      if (e.shiftKey) {
        window.open(el.href, '_blank', 'noopener');
      } else {
        setKbd(list, list.indexOf(el));
        el.click();
      }
    }
  }

  function renderCard(link) {
    const isExternal = /^https?:\/\//i.test(link.url || '');
    const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    const pinned = currentPins.has(link.url);
    return '<li class="card-item' + (pinned ? ' is-pinned' : '') + '">' +
      '<a class="card" href="' + escapeHtml(link.url) + '"' + target + '>' +
        '<span class="card-icon" data-fallback="' + escapeHtml(markFallback(link)) + '">' +
          renderMark(link) +
        '</span>' +
        '<span class="card-body">' +
          '<span class="card-name">' + escapeHtml(link.name || '未命名') + '</span>' +
          (link.desc ? '<span class="card-desc">' + escapeHtml(link.desc) + '</span>' : '') +
          '<span class="card-host">' + hostHtml(link.url) + '</span>' +
        '</span>' +
      '</a>' +
      pinButton(link, pinned) +
    '</li>';
  }

  function renderItemIcon(link) {
    const isExternal = /^https?:\/\//i.test(link.url || '');
    const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    const pinned = currentPins.has(link.url);
    return '<li class="icon-cell' + (pinned ? ' is-pinned' : '') + '">' +
      '<a class="icon-item" href="' + escapeHtml(link.url) + '"' + target + '>' +
        '<span class="card-icon" data-fallback="' + escapeHtml(markFallback(link)) + '">' +
          renderMark(link) +
        '</span>' +
        '<span class="icon-name">' + escapeHtml(link.name || '未命名') + '</span>' +
      '</a>' +
      pinButton(link, pinned) +
    '</li>';
  }

  function pinButton(link, pinned) {
    const action = pinned ? '取消置顶' : '置顶';
    return '<button class="pin-btn' + (pinned ? ' is-pinned' : '') + '" type="button" ' +
      'data-pin-url="' + escapeHtml(link.url) + '" ' +
      'aria-pressed="' + (pinned ? 'true' : 'false') + '" ' +
      'aria-label="' + action + '：' + escapeHtml(link.name || '未命名') + '" ' +
      'title="' + action + '">' +
      PIN_SVG +
    '</button>';
  }

  // ============================================================
  //  常用置顶（最近访问）：localStorage 记录点击次数
  //  高频条目排到组内最前；未访问条目保持 config.js 原顺序
  //  重置方法：控制台执行 localStorage.removeItem('jx_visits')
  // ============================================================
  function loadVisits() {
    try {
      const v = JSON.parse(localStorage.getItem('jx_visits') || '{}');
      return (v && typeof v === 'object') ? v : {};
    } catch (e) {
      return {};
    }
  }

  function recordVisit(url) {
    if (!url) return;
    try {
      const visits = loadVisits();
      const prev = visits[url] || { n: 0, t: 0 };
      visits[url] = { n: (prev.n || 0) + 1, t: Date.now() };
      localStorage.setItem('jx_visits', JSON.stringify(visits));
    } catch (e) { /* 隐私模式 / 配额满：静默 */ }
  }

  function sortByVisits(items, visits) {
    const scored = items.map(function (item, i) {
      const v = visits[item.url];
      return { item: item, i: i, n: v ? (v.n || 0) : 0, t: v ? (v.t || 0) : 0 };
    });
    scored.sort(function (a, b) {
      if (a.n !== b.n) return b.n - a.n;            // 高频在前
      if (a.n > 0 && a.t !== b.t) return b.t - a.t; // 同频按最近
      return a.i - b.i;                             // 未访问保持原序
    });
    return scored.map(function (s) { return s.item; });
  }

  // ============================================================
  //  手动置顶：localStorage 保存 URL 数组，新置顶的排在最前
  //  重置方法：控制台执行 localStorage.removeItem('jx_pins')
  // ============================================================
  const PINS_KEY = 'jx_pins';

  function loadPins() {
    try {
      const value = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      const known = new Set(LINKS.map(function (link) { return link.url; }));
      return value.filter(function (url) {
        return typeof url === 'string' && url && known.has(url);
      });
    } catch (e) {
      return [];
    }
  }

  function togglePin(url) {
    if (!url) return;
    let pins = loadPins();
    if (pins.indexOf(url) >= 0) {
      pins = pins.filter(function (item) { return item !== url; });
    } else {
      pins = [url].concat(pins.filter(function (item) { return item !== url; }));
    }
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(pins));
    } catch (e) { /* 隐私模式 / 配额满：静默 */ }
    renderSections();
    focusPinButton(url);
  }

  function focusPinButton(url) {
    const buttons = sectionsEl.querySelectorAll('.pin-btn');
    for (let i = 0; i < buttons.length; i += 1) {
      if (buttons[i].getAttribute('data-pin-url') === url) {
        try {
          buttons[i].focus({ preventScroll: true });
        } catch (e) {
          buttons[i].focus();
        }
        return;
      }
    }
  }

  // ============================================================
  //  条目标识：显式 avatar → 外链 favicon → mark 单字
  //  invert: true 的单色图标在深色主题自动反转
  // ============================================================
  function renderMark(link) {
    let url = link.avatar;
    if (!url && /^https?:\/\//i.test(link.url || '')) {
      try {
        url = new URL(link.url).origin + '/favicon.ico';
      } catch (e) { /* 非法 URL 忽略 */ }
    }
    if (url) {
      const cls = link.invert ? ' class="mark-invert"' : '';
      return '<img src="' + escapeHtml(url) + '"' + cls + ' alt="" loading="lazy" decoding="async">';
    }
    return escapeHtml(markFallback(link));
  }

  // 兜底标识：mark 单字 → 名称首字
  function markFallback(link) {
    if (link.mark) return link.mark;
    const name = link.name || '';
    return name ? name.slice(0, 1) : '·';
  }

  // ============================================================
  //  从 URL 提取域名 / 本地项目标识
  // ============================================================
  function safeHost(url) {
    if (!url) return '';
    // 本地相对路径（projects/ 下的子项目）
    if (/^\.?\/?projects\//i.test(url) || /^\.\//.test(url)) {
      const m = url.match(/projects\/([^/]+)/i);
      return m ? ('本地 · ' + m[1]) : '本地项目';
    }
    try {
      const u = new URL(url, window.location.origin);
      return u.hostname.replace(/^www\./, '');
    } catch (e) {
      return url;
    }
  }

  // 网址 / 本地项目名用艺术斜体展示，中文前缀保持系统字体
  function hostHtml(url) {
    const host = safeHost(url);
    const m = host.match(/^([\s\S]*?[\u4e00-\u9fa5·\s])([!-~]+)$/);
    if (!m) return '<span class="en">' + escapeHtml(host) + '</span>';
    return escapeHtml(m[1]) + '<span class="en">' + escapeHtml(m[2]) + '</span>';
  }

  // ============================================================
  //  事件绑定
  // ============================================================
  function bindEvents() {
    let timer;
    searchInput.addEventListener('input', function () {
      clearTimeout(timer);
      searchQuery = searchInput.value;
      // 轻微防抖
      timer = setTimeout(renderSections, 120);
    });

    // 捕获阶段：图钉按钮切换置顶；点卡片记录访问次数（键盘 Enter 也会走这里）
    sectionsEl.addEventListener('click', function (e) {
      const target = e.target;
      const pin = target && target.closest ? target.closest('.pin-btn') : null;
      if (pin) {
        e.preventDefault();
        e.stopPropagation();
        togglePin(pin.getAttribute('data-pin-url'));
        return;
      }
      const a = target && target.closest ? target.closest('a.card, a.icon-item') : null;
      if (a) recordVisit(a.getAttribute('href'));
    }, true);

    // 视图切换：卡片网格 / 图标网格
    if (viewToggle) {
      viewToggle.addEventListener('click', function () {
        viewMode = viewMode === 'cards' ? 'icons' : 'cards';
        try {
          localStorage.setItem('jx_view', viewMode);
        } catch (e) { /* 隐私模式忽略 */ }
        applyViewMode();
        renderSections();
      });
    }
  }

  // ============================================================
  //  主题切换（深色 / 浅色）
  // ============================================================
  function bindTheme() {
    if (!themeToggle) return;

    updateMetaTheme();

    themeToggle.addEventListener('click', function () {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      updateMetaTheme();
      try {
        localStorage.setItem('jx_theme', next);
      } catch (e) { /* 隐私模式忽略 */ }
    });
  }

  // 同步移动端浏览器地址栏 / 状态栏颜色
  function updateMetaTheme() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    meta.setAttribute('content', dark ? '#000000' : '#f5f5f7');
  }

  // ============================================================
  //  天气小组件：open-meteo 免 key（data 缓存 30 分钟）
  //  定位：浏览器授权后精确到出生地；拒绝则退回默认城市（无锡）
  // ============================================================
  const WEATHER_SVG = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/></svg>',
    partly: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 3.4v1M3.4 8H2.4M4.5 4.5l-.7-.7M11.5 4.5l.7-.7M13.2 8h1"/><path d="M8.2 19.5h8.4a3.1 3.1 0 1 0-.7-6.1 4 4 0 0 0-7.7 1 2.6 2.6 0 0 0 0 5.1Z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18.5h10a4 4 0 1 0-1-7.9 5.2 5.2 0 0 0-10 1.4 3.3 3.3 0 0 0 0 6.5Z"/></svg>',
    rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15.5h10a4 4 0 1 0-1-7.9 5.2 5.2 0 0 0-10 1.4 3.3 3.3 0 0 0 0 6.5Z"/><path d="M9 18.5l-.8 1.8M13 18.3l-.9 2M16.2 18.6l-.8 1.8"/></svg>',
    snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15.5h10a4 4 0 1 0-1-7.9 5.2 5.2 0 0 0-10 1.4 3.3 3.3 0 0 0 0 6.5Z"/><path d="M9 19.2v0M12.5 20v0M16 19.2v0" stroke-width="2.4"/></svg>',
    storm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14.5h10a4 4 0 1 0-1-7.9 5.2 5.2 0 0 0-10 1.4 3.3 3.3 0 0 0 0 6.5Z"/><path d="M12.6 15.5l-2 3h2.4l-1.6 3"/></svg>'
  };
  const FALLBACK_CITY = { name: '无锡', lat: 31.5714, lon: 120.3035 };

  function weatherKind(code) {
    if (code === 0) return 'sun';
    if (code === 1 || code === 2) return 'partly';
    if (code === 3 || code === 45 || code === 48) return 'cloud';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'cloud';
  }

  function showWeather(temp, code, city) {
    if (!weatherEl || !weatherIconEl || !weatherTempEl) return;
    weatherIconEl.innerHTML = WEATHER_SVG[weatherKind(code)] || WEATHER_SVG.cloud;
    weatherTempEl.textContent = Math.round(temp) + '°';
    let label = weatherEl.querySelector('.weather-city');
    if (city) {
      if (!label) {
        label = document.createElement('span');
        label.className = 'weather-city';
        weatherEl.appendChild(label);
      }
      label.textContent = city;
    } else if (label) {
      label.remove();
    }
    weatherEl.hidden = false;
  }

  function weatherCacheGet() {
    try {
      const c = JSON.parse(localStorage.getItem('jx_weather') || 'null');
      if (c && c.t && Date.now() - c.t < 30 * 60 * 1000) return c;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function applyWeather(c) { showWeather(c.temp, c.code, c.city || ''); }

  async function loadWeather(city) {
    const cached = weatherCacheGet();
    if (cached) applyWeather(cached);
    try {
      const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + city.lat + '&longitude=' + city.lon + '&current=temperature_2m,weather_code');
      if (!r.ok) return;
      const j = await r.json();
      const cur = j && j.current;
      if (!cur || cur.temperature_2m == null) return;
      const rec = { temp: cur.temperature_2m, code: cur.weather_code || 0, city: city.name || '', t: Date.now() };
      try { localStorage.setItem('jx_weather', JSON.stringify(rec)); } catch (e) { /* 忽略 */ }
      applyWeather(rec);
    } catch (e) { /* 网络失败：保持隐藏 */ }
  }

  function initWeather() {
    if (!weatherEl) return;
    let city = null;
    try {
      const g = JSON.parse(localStorage.getItem('jx_geo') || 'null');
      if (g && typeof g.lat === 'number') city = { name: '', lat: g.lat, lon: g.lon };
    } catch (e) { /* 忽略 */ }
    if (city) { loadWeather(city); return; }
    if (!navigator.geolocation) { loadWeather(FALLBACK_CITY); return; }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        const c = { lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) };
        try { localStorage.setItem('jx_geo', JSON.stringify(c)); } catch (e) { /* 忽略 */ }
        loadWeather({ name: '', lat: c.lat, lon: c.lon });
      },
      function () { loadWeather(FALLBACK_CITY); },
      { timeout: 8000, maximumAge: 30 * 60 * 1000 }
    );
  }

  // ============================================================
  //  PWA：注册 Service Worker（仅 https 且同源; file:// 下静默跳过）
  // ============================================================
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:') return;
    navigator.serviceWorker.register('/sw.js').catch(function () { /* 静默失败：无 SW 仅损失离线能力 */ });
  }

  // ============================================================
  //  时钟（精确到分钟即可：对齐到分钟边界更新，切回前台立即校准）
  // ============================================================
  function startClock() {
    function tick() {
      const now = new Date();
      clockEl.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    }
    let timer = null;
    function schedule() {
      clearTimeout(timer);
      const now = new Date();
      const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 30;
      timer = setTimeout(function () { tick(); schedule(); }, delay);
    }
    tick();
    schedule();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        tick();
        schedule(); // 后台暂停后回前台：立即校准并重置对齐
      }
    });
  }

  // ============================================================
  //  根据时间问候
  // ============================================================
  function setGreeting() {
    const h = new Date().getHours();
    let g;
    if (h < 6) g = '夜深了';
    else if (h < 11) g = '早上好';
    else if (h < 13) g = '中午好';
    else if (h < 18) g = '下午好';
    else g = '晚上好';
    greetingEl.textContent = g;
  }

  // ============================================================
  //  工具
  // ============================================================
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // HTML 转义
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 启动
  init();
})();
