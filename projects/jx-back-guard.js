/* ============================================================
   jx-back-guard · 子项目页面的返回键兜底
   从 APK / PWA / 直链进入子项目时，保证系统返回键能回到中转站。
   ============================================================ */
(function () {
  'use strict';

  var HUB_URL = '../../index.html';
  history.replaceState({ jxSub: 1 }, '');
  history.pushState({ jxGuard: 1 }, '');

  window.addEventListener('popstate', function (event) {
    if (!event.state || !event.state.jxSub) return;
    location.replace(HUB_URL);
  });
})();
