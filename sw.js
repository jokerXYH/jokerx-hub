/* ============================================================
   PWA Service Worker —— 网络优先 + 离线兜底
   页面/静态资源：先走网络，成功则顺手进缓存；断网时回退缓存。
   后端 API（签到表 / 一键考勤）：完全放行 —— 不缓存也不代理响应，
   避免登录状态 / 课程数据被陈旧缓存污染（此前实现只排除了 POST，
   GET 的 API JSON 也会被写进缓存，离线兜底会吐回过期数据）。
   更新策略：网络优先下改完内容刷新页面即生效（离线兜底才可能
   拿到旧缓存），无需为常规改动升 CACHE 名；只有想强制清空
   全部缓存时再把 v1 升到 v2。
   ============================================================ */
const CACHE = 'jokerx-hub-v1';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 只管同源
  // 后端 API 是动态数据（登录态 / 课程 / 学员名单）：交给浏览器原生处理
  if (url.pathname.includes('/api/')) return;
  // 安装包体积大且同名更新频繁，交给浏览器/下载器处理，避免 SW 缓存旧版本
  if (url.pathname.startsWith('/downloads/')) return;

  event.respondWith((async function () {
    try {
      const res = await fetch(req);
      // 只缓存成功的同源静态资源：404 会污染离线兜底，
      // 206 等响应根本不能 put（规范抛错），此前 put 失败还会把
      // 网络已成功的响应也一并变成失败 —— 故 put 单独包 try。
      if (res.ok && res.type === 'basic') {
        try {
          const cache = await caches.open(CACHE);
          await cache.put(req, res.clone());
        } catch (err) { /* 缓存失败不影响本次响应 */ }
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});
