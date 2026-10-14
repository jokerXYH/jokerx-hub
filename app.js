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

  // ---- 状态 ----
  let searchQuery = '';

  // ============================================================
  //  初始化
  // ============================================================
  function init() {
    // 校验配置
    if (typeof LINKS === 'undefined' || !Array.isArray(LINKS)) {
      sectionsEl.innerHTML = '<p class="load-error">config.js 未正确加载，请检查文件。</p>';
      return;
    }

    renderSections();
    bindEvents();
    bindTheme();
    startClock();
    setGreeting();

    yearEl.textContent = new Date().getFullYear();

    // 快捷键：按 / 聚焦搜索，Esc 清空
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== searchInput) {
        e.preventDefault();
        searchInput.focus();
      }
      if (e.key === 'Escape' && document.activeElement === searchInput) {
        searchInput.value = '';
        searchQuery = '';
        searchInput.blur();
        renderSections();
      }
    });
  }

  // ============================================================
  //  渲染：按分类分区（分区顺序 = LINKS 数组顺序）
  // ============================================================
  function renderSections() {
    const q = searchQuery.trim().toLowerCase();

    const groups = new Map();
    LINKS.forEach(function (link) {
      if (q && !matchQuery(link, q)) return;
      const cat = link.cat || '其他';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(link);
    });

    if (groups.size === 0) {
      sectionsEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    const html = [];
    groups.forEach(function (items, cat) {
      html.push(
        '<section class="group">' +
          '<h2 class="group-title">' +
            '<span class="group-name">' + escapeHtml(cat) + '</span>' +
            '<span class="group-count">' + pad2(items.length) + '</span>' +
          '</h2>' +
          '<ul class="card-grid">' + items.map(renderCard).join('') + '</ul>' +
        '</section>'
      );
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

  function matchQuery(link, q) {
    return (link.name || '').toLowerCase().indexOf(q) >= 0 ||
           (link.desc || '').toLowerCase().indexOf(q) >= 0 ||
           (link.url || '').toLowerCase().indexOf(q) >= 0;
  }

  function renderCard(link) {
    const isExternal = /^https?:\/\//i.test(link.url || '');
    const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    return '<li>' +
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
    '</li>';
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
  //  时钟
  // ============================================================
  function startClock() {
    function tick() {
      const now = new Date();
      clockEl.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    }
    tick();
    setInterval(tick, 1000);
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
