/* ============================================================
   首屏主题初始化（必须在 style.css 之前加载）
   在样式表生效前确定 html[data-theme]，避免刷新时闪一下错误的颜色。
   独立文件的原因：站点 CSP 为 script-src 'self'，内联脚本会被浏览器拦截。
   取值：localStorage.jx_theme 为 'light' | 'dark'；没有记录时跟随系统。
   ============================================================ */
(function () {
  'use strict';
  try {
    var t = localStorage.getItem('jx_theme'); // 'light' | 'dark' | 空(跟随系统)
    if (t !== 'light' && t !== 'dark') t = null;
    if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
