/* ============================================================
   Joker X · 动态交互背景（动效层）
   ------------------------------------------------------------
   只做一件事：创建 .jx-ambient 装饰层，并让光晕 / 网格跟随光标。
   样式全部在 assets/ambient/ambient.css，这里只管位置。

   行为约定：
     · 鼠标（hover:hover + pointer:fine）：光晕跟手，网格慢半拍，
       色块随光标做轻微视差 → “有交互但不抢内容”。
     · 触屏：不跑循环（CSS 已隐藏光晕与网格），只留缓慢色块漂移。
     · prefers-reduced-motion：只摆一个静态光晕，完全不跑 rAF。
     · 页签不可见时暂停，回来再恢复；光标静止约半秒后自动停表。
   ============================================================ */
(function () {
  'use strict';

  var body = document.body;
  if (!body) return;

  var GLOW_SIZE = 760;   // 与 ambient.css 中 .jx-ambient__glow 尺寸保持一致
  var SPOT_SIZE = 1000;  // 与 .jx-ambient__spot 一致
  var PARALLAX = 22;     // 色块视差位移上限（px）

  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var fineQuery = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : null;

  function prefersReduced() {
    return !!(reduceQuery && reduceQuery.matches);
  }

  function hasFinePointer() {
    return !fineQuery || fineQuery.matches;
  }

  // ---- 建层 ----
  // 气泡位置固定（不用随机数），保证每次刷新构图一致、不会闪烁。
  var BUBBLES = [
    [6, 16, 22, 18, -4], [14, 62, 10, 15, -9], [24, 28, 16, 22, -15],
    [33, 78, 7, 13, -2], [44, 12, 12, 19, -11], [54, 66, 20, 24, -6],
    [63, 34, 9, 16, -18], [72, 80, 14, 21, -3], [81, 20, 8, 14, -13],
    [88, 58, 24, 26, -8], [93, 36, 11, 17, -1], [17, 88, 6, 12, -16]
  ];

  function bubbleMarkup() {
    return BUBBLES.map(function (b) {
      return '<span class="jx-ambient__bubble" style="left:' + b[0] + '%;top:' + b[1] +
        '%;width:' + b[2] + 'px;height:' + b[2] + 'px;--dur:' + b[3] +
        's;--delay:' + b[4] + 's"></span>';
    }).join('');
  }

  // 圆滚滚的「大肥鱼」：身体 + 尾鳍 + 小鳍 + 眼睛 + 腮红，全部内联 SVG。
  function fishSvg(suffix) {
    var body = 'jxFishBody' + suffix;
    var fin = 'jxFishFin' + suffix;
    return '<svg viewBox="0 0 300 190" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs>' +
        '<linearGradient id="' + body + '" x1="34" y1="34" x2="262" y2="156" gradientUnits="userSpaceOnUse">' +
          '<stop stop-color="#8b7cf6"/><stop offset=".52" stop-color="#6aa8ff"/><stop offset="1" stop-color="#5eead4"/>' +
        '</linearGradient>' +
        '<linearGradient id="' + fin + '" x1="210" y1="60" x2="286" y2="130" gradientUnits="userSpaceOnUse">' +
          '<stop stop-color="#a78bfa"/><stop offset="1" stop-color="#7dd3fc"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="M28 95c0-42 38-68 84-68 42 0 76 18 100 46 8 9 16 16 30 22-14 6-22 13-30 22-24 28-58 46-100 46-46 0-84-26-84-68Z" fill="url(#' + body + ')" fill-opacity=".92"/>' +
      '<path d="M238 95c14-16 28-27 44-33-7 21-7 45 0 66-16-6-30-17-44-33Z" fill="url(#' + fin + ')" fill-opacity=".88"/>' +
      '<path d="M138 34c7-14 21-21 36-16-10 8-15 17-15 29" fill="#a78bfa" fill-opacity=".75"/>' +
      '<path d="M74 128c10 12 26 16 40 8" stroke="#1e293b" stroke-opacity=".28" stroke-width="3.5" stroke-linecap="round"/>' +
      '<circle cx="92" cy="82" r="6" fill="#1e293b" fill-opacity=".62"/>' +
      '<circle cx="90" cy="80" r="1.8" fill="#fff" fill-opacity=".85"/>' +
      '<circle cx="62" cy="98" r="9" fill="#fb7185" fill-opacity=".22"/>' +
    '</svg>';
  }

  var layer = document.createElement('div');
  layer.className = 'jx-ambient';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML =
    '<div class="jx-ambient__field">' +
      '<span class="jx-ambient__blob jx-ambient__blob--violet"></span>' +
      '<span class="jx-ambient__blob jx-ambient__blob--sky"></span>' +
      '<span class="jx-ambient__blob jx-ambient__blob--mint"></span>' +
    '</div>' +
    '<div class="jx-ambient__grid"></div>' +
    '<div class="jx-ambient__dots"></div>' +
    '<canvas class="jx-ambient__particles"></canvas>' +
    '<div class="jx-ambient__ring"></div>' +
    '<div class="jx-ambient__ring jx-ambient__ring--small"></div>' +
    '<div class="jx-ambient__bubbles">' + bubbleMarkup() + '</div>' +
    '<div class="jx-ambient__fish jx-ambient__fish--a">' +
      '<div class="jx-ambient__fish-bob">' + fishSvg('A') + '</div>' +
    '</div>' +
    '<div class="jx-ambient__fish jx-ambient__fish--b">' +
      '<div class="jx-ambient__fish-bob">' + fishSvg('B') + '</div>' +
    '</div>' +
    '<div class="jx-ambient__veil"></div>' +
    '<div class="jx-ambient__spot"></div>' +
    '<div class="jx-ambient__glow"></div>' +
    '<div class="jx-ambient__grain"></div>';

  var fieldEl = layer.querySelector('.jx-ambient__field');
  var spotEl = layer.querySelector('.jx-ambient__spot');
  var glowEl = layer.querySelector('.jx-ambient__glow');

  var first = body.firstChild;
  if (first) body.insertBefore(layer, first);
  else body.appendChild(layer);

  // ---- 粒子层：细尘 + 星座连线（canvas，不依赖外部库） ----
  function initParticles(root) {
    var canvas = root.querySelector('.jx-ambient__particles');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var items = [];
    var width = 0;
    var height = 0;
    var dpr = 1;
    var raf = 0;
    var last = 0;
    var reduce = prefersReduced();
    var pointer = { x: -9999, y: -9999, active: false };

    function isDark() {
      return document.documentElement.getAttribute('data-theme') === 'dark';
    }

    function palette() {
      return isDark()
        ? {
            dots: ['rgba(165, 180, 252, ', 'rgba(125, 211, 252, ', 'rgba(94, 234, 212, '],
            line: 'rgba(165, 180, 252, '
          }
        : {
            dots: ['rgba(108, 92, 231, ', 'rgba(74, 158, 255, ', 'rgba(0, 194, 168, '],
            line: 'rgba(108, 92, 231, '
          };
    }

    function particleCount() {
      return window.innerWidth <= 720 ? 44 : 110;
    }

    function make() {
      var total = particleCount();
      var clustered = width > 900 ? Math.round(total * 0.38) : 0;
      items = [];
      for (var i = 0; i < total; i += 1) {
        // 右上角稍微加密，形成参考站那种局部星座网
        var inCluster = i < clustered;
        items.push({
          x: inCluster
            ? width * (0.56 + Math.random() * 0.44)
            : Math.random() * width,
          y: inCluster
            ? height * (0.04 + Math.random() * 0.44)
            : Math.random() * height,
          vx: (Math.random() - 0.5) * 0.016,
          vy: (Math.random() - 0.5) * 0.016,
          r: 0.7 + Math.random() * 1.6,
          a: 0.20 + Math.random() * 0.40,
          phase: Math.random() * Math.PI * 2,
          depth: 0.25 + Math.random() * 0.75,
          color: i % 3
        });
      }
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      make();
      if (reduce) drawStatic();
      else start();
    }

    function draw(now, dt) {
      var colors = palette();
      var dark = isDark();
      var ox = pointer.active ? ((pointer.x - width / 2) / width) * 18 : 0;
      var oy = pointer.active ? ((pointer.y - height / 2) / height) * 12 : 0;
      var seconds = now * 0.001;
      var i;
      var j;

      ctx.clearRect(0, 0, width, height);

      for (i = 0; i < items.length; i += 1) {
        var item = items[i];
        item.x += item.vx * dt;
        item.y += item.vy * dt;
        item.x += Math.cos(seconds * 0.25 + item.phase) * 0.006 * dt;
        item.y += Math.sin(seconds * 0.21 + item.phase) * 0.006 * dt;

        if (pointer.active) {
          var pdx = item.x - pointer.x;
          var pdy = item.y - pointer.y;
          var pdist2 = pdx * pdx + pdy * pdy;
          if (pdist2 > 0.01 && pdist2 < 12100) {
            var pdist = Math.sqrt(pdist2);
            var force = (1 - pdist / 110) * 0.32 * (dt / 16.7);
            item.x += (pdx / pdist) * force;
            item.y += (pdy / pdist) * force;
          }
        }

        if (item.x < -24) item.x = width + 24;
        else if (item.x > width + 24) item.x = -24;
        if (item.y < -24) item.y = height + 24;
        else if (item.y > height + 24) item.y = -24;
      }

      // 先画连线，再画粒子，避免点被线压暗
      for (i = 0; i < items.length; i += 1) {
        var a = items[i];
        var ax = a.x + ox * a.depth;
        var ay = a.y + oy * a.depth;
        var links = 0;
        for (j = i + 1; j < items.length && links < 4; j += 1) {
          var b = items[j];
          var bx = b.x + ox * b.depth;
          var by = b.y + oy * b.depth;
          var dx = ax - bx;
          var dy = ay - by;
          var dist2 = dx * dx + dy * dy;
          if (dist2 < 19600) {
            var alpha = (1 - Math.sqrt(dist2) / 140) * (dark ? 0.20 : 0.12);
            ctx.strokeStyle = colors.line + alpha.toFixed(3) + ')';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
            links += 1;
          }
        }
      }

      for (i = 0; i < items.length; i += 1) {
        var dot = items[i];
        var twinkle = 0.72 + 0.28 * Math.sin(seconds * 0.9 + dot.phase);
        var alpha2 = Math.min(dot.a * twinkle * (dark ? 1.15 : 1), 0.72);
        ctx.fillStyle = colors.dots[dot.color] + alpha2.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(
          dot.x + ox * dot.depth,
          dot.y + oy * dot.depth,
          dot.r,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    function drawStatic() {
      draw(performance.now ? performance.now() : Date.now(), 0);
    }

    function frame(now) {
      raf = 0;
      if (document.hidden) return;
      if (prefersReduced()) {
        drawStatic();
        return;
      }
      if (!last) last = now;
      var elapsed = now - last;
      if (elapsed < 32) {
        raf = requestAnimationFrame(frame);
        return;
      }
      last = now;
      draw(now, Math.min(elapsed, 48));
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (reduce || raf || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    }

    function onPointer(event) {
      if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.active = true;
    }

    function onPointerLeave() {
      pointer.active = false;
    }

    function onVisibility() {
      if (document.hidden) stop();
      else if (!reduce) start();
    }

    function onReduceChange() {
      reduce = prefersReduced();
      if (reduce) {
        stop();
        drawStatic();
      } else {
        start();
      }
    }

    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('pointermove', onPointer, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibility);
    if (reduceQuery && reduceQuery.addEventListener) {
      reduceQuery.addEventListener('change', onReduceChange);
    }
    resize();
  }

  initParticles(layer);

  // ---- 状态 ----
  var target = { x: 0, y: 0 };
  var glow = { x: 0, y: 0 };
  var spot = { x: 0, y: 0 };
  var field = { x: 0, y: 0 };
  var rafId = 0;
  var pointerSeen = false;

  function centerPoint() {
    return {
      x: window.innerWidth / 2,
      y: Math.max(window.innerHeight * 0.34, 140)
    };
  }

  function place(el, x, y, size) {
    el.style.transform = 'translate3d(' + (x - size / 2).toFixed(1) + 'px,' +
      (y - size / 2).toFixed(1) + 'px,0)';
  }

  function apply() {
    place(glowEl, glow.x, glow.y, GLOW_SIZE);
    place(spotEl, spot.x, spot.y, SPOT_SIZE);
    fieldEl.style.transform = 'translate3d(' + field.x.toFixed(2) + 'px,' +
      field.y.toFixed(2) + 'px,0)';
  }

  // ---- 缓动：变化足够小就吸附到目标并返回 false（用于自动停表）----
  function ease(pos, goal, factor) {
    var dx = goal.x - pos.x;
    var dy = goal.y - pos.y;
    if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
      pos.x = goal.x;
      pos.y = goal.y;
      return false;
    }
    pos.x += dx * factor;
    pos.y += dy * factor;
    return true;
  }

  function frame() {
    rafId = 0;
    if (document.hidden) return;

    var glowMoving = ease(glow, target, 0.16);
    var spotMoving = ease(spot, target, 0.065);
    var fieldMoving = ease(field, parallaxGoal(), 0.08);

    apply();

    if (glowMoving || spotMoving || fieldMoving) {
      rafId = requestAnimationFrame(frame);
    }
  }

  function parallaxGoal() {
    var cx = window.innerWidth / 2 || 1;
    var cy = window.innerHeight / 2 || 1;
    return {
      x: ((target.x - cx) / cx) * PARALLAX,
      y: ((target.y - cy) / cy) * PARALLAX - Math.min(window.pageYOffset * 0.02, 18)
    };
  }

  function start() {
    if (prefersReduced()) return;
    if (!hasFinePointer()) return;
    if (rafId) return;
    if (document.hidden) return;
    rafId = requestAnimationFrame(frame);
  }

  function syncStatic() {
    // 减弱动效 / 触屏：摆一个稳定的静态构图，不跑循环
    var p = centerPoint();
    glow.x = spot.x = p.x;
    glow.y = spot.y = p.y;
    field.x = field.y = 0;
    apply();
  }

  // ---- 事件 ----
  function onPointerMove(event) {
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    pointerSeen = true;
    target.x = event.clientX;
    target.y = event.clientY;
    start();
  }

  function onPointerLeave() {
    // 光标离开窗口：光晕缓缓回到画面中心，而不是僵在边缘
    var p = centerPoint();
    target.x = p.x;
    target.y = p.y;
    start();
  }

  function onResize() {
    if (!pointerSeen) {
      var p = centerPoint();
      target.x = p.x;
      target.y = p.y;
    }
    if (prefersReduced() || !hasFinePointer()) {
      syncStatic();
      return;
    }
    start();
  }

  function onVisibility() {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    } else {
      start();
    }
  }

  function bind() {
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', start, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    if (reduceQuery && reduceQuery.addEventListener) {
      reduceQuery.addEventListener('change', onResize);
    }
    if (fineQuery && fineQuery.addEventListener) {
      fineQuery.addEventListener('change', onResize);
    }
  }

  var initial = centerPoint();
  target.x = glow.x = spot.x = initial.x;
  target.y = glow.y = spot.y = initial.y;
  apply();

  // 始终挂监听：用户在系统里临时关掉“减弱动效”或换成鼠标时，
  // 无需刷新页面就能自动恢复交互。
  bind();
  if (prefersReduced() || !hasFinePointer()) syncStatic();
})();
