/* ============================================================
   Joker X · 鲸鱼娘桌宠
   ------------------------------------------------------------
   素材来自 f0909172434/dsh-deepseek-girl-pet（MIT），只做裁切/重排；
   版权与改动说明见 assets/pet/NOTICE.md。

   行为：
     · 拖拽移动（鼠标 / 触屏），位置记住，缩放窗口自动夹回可视区
     · 点一下：挥手 + 随机一句话；双击：放大 / 复原
     · 悬停出现「×」收起，收起后右下角留一个小圆钮召回
     · 首访提示只说一次；prefers-reduced-motion 时不播帧动画
     · 页面加载完成后再创建，避免影响首屏
   ============================================================ */
(function () {
  'use strict';

  var POS_KEY = 'jx_pet_pos_v1';
  var HIDE_KEY = 'jx_pet_hidden_v1';
  var SCALE_KEY = 'jx_pet_scale_v1';
  var HINT_KEY = 'jx_pet_hint_v1';

  var LINES = [
    '今天也要顺顺利利呀',
    '点名前记得刷新一下名单',
    '喝口水吧，我帮你看时间',
    'β1 的同学可以先排除哦',
    '拖我去别的位置也可以',
    '慢一点也没关系'
  ];

  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function prefersReduced() {
    return !!(reduceQuery && reduceQuery.matches);
  }

  function read(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // 隐私模式：忽略
    }
  }

  var pet = null;
  var bubble = null;
  var closeBtn = null;
  var restoreBtn = null;
  var pos = { x: 0, y: 0 };
  var scale = read(SCALE_KEY, '1') === '1.3' ? 1.3 : 1;
  var drag = null;
  var suppressClick = false;
  var bubbleTimer = 0;
  var greetTimer = 0;
  var clickTimer = 0;

  function parsePos(raw) {
    var parts = String(raw || '').split(',');
    if (parts.length !== 2) return null;
    var x = Number(parts[0]);
    var y = Number(parts[1]);
    if (!isFinite(x) || !isFinite(y)) return null;
    return { x: x, y: y };
  }

  function metrics() {
    var rect = pet ? pet.getBoundingClientRect() : { width: 96, height: 104 };
    var w = rect.width || 96;
    var h = rect.height || 104;
    return {
      w: w,
      h: h,
      // 缩放原点在右下角：视觉左上角会比布局盒更靠左上
      left: w * (scale - 1),
      top: h * (scale - 1)
    };
  }

  function clampPos(x, y) {
    var m = metrics();
    var minX = Math.max(6, m.left + 6);
    var minY = Math.max(6, m.top + 6);
    var maxX = Math.max(minX, window.innerWidth - m.w - 6);
    var maxY = Math.max(minY, window.innerHeight - m.h - 6);
    return {
      x: Math.min(Math.max(minX, x), maxX),
      y: Math.min(Math.max(minY, y), maxY)
    };
  }

  function applyPos(persist) {
    if (!pet) return;
    pet.style.transform = 'translate3d(' + pos.x + 'px,' + pos.y + 'px,0) scale(' + scale + ')';
    if (persist) {
      write(POS_KEY, Math.round(pos.x) + ',' + Math.round(pos.y));
    }
  }

  function moveTo(x, y, persist) {
    pos = clampPos(x, y);
    applyPos(persist);
  }

  function showBubble(text) {
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add('is-on');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () {
      bubble.classList.remove('is-on');
    }, 3800);
  }

  function greet() {
    if (!pet || pet.hidden) return;
    if (!prefersReduced()) {
      pet.classList.remove('is-greeting');
      void pet.offsetWidth; // 重启动画
      pet.classList.add('is-greeting');
      clearTimeout(greetTimer);
      greetTimer = setTimeout(function () {
        pet.classList.remove('is-greeting');
      }, 780);
    }
    showBubble(LINES[Math.floor(Math.random() * LINES.length)]);
  }

  function ensureRestore(show) {
    if (!restoreBtn) {
      restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'jx-pet-restore';
      restoreBtn.setAttribute('aria-label', '叫回鲸鱼娘桌宠');
      restoreBtn.title = '叫回鲸鱼娘';
      restoreBtn.addEventListener('click', function () {
        write(HIDE_KEY, '0');
        if (pet) pet.hidden = false;
        restoreBtn.hidden = true;
        showBubble('我回来啦');
      });
      document.body.appendChild(restoreBtn);
    }
    restoreBtn.hidden = !show;
  }

  function toggleScale() {
    scale = scale === 1 ? 1.3 : 1;
    write(SCALE_KEY, String(scale));
    moveTo(pos.x, pos.y, true);
    showBubble(scale === 1 ? '恢复原来的大小' : '这样可以看得更清楚');
  }

  function bindDrag() {
    pet.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target === closeBtn) return;
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: pos.x,
        originY: pos.y,
        moved: false
      };
      try {
        pet.setPointerCapture(event.pointerId);
      } catch (error) {
        // 老浏览器：忽略
      }
      pet.classList.add('is-dragging');
      bubble.classList.remove('is-on');
    });

    pet.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.id) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      moveTo(drag.originX + dx, drag.originY + dy, false);
    });

    function endDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      var moved = drag.moved;
      drag = null;
      pet.classList.remove('is-dragging');
      try {
        pet.releasePointerCapture(event.pointerId);
      } catch (error) {
        // 忽略
      }
      if (moved) {
        suppressClick = true;
        setTimeout(function () {
          suppressClick = false;
        }, 350);
        applyPos(true);
      }
    }

    pet.addEventListener('pointerup', endDrag);
    pet.addEventListener('pointercancel', endDrag);

    pet.addEventListener('click', function (event) {
      if (event.target === closeBtn) return;
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      // 延迟一点再说话：双击时取消，避免「放大」还附带两句话
      clearTimeout(clickTimer);
      clickTimer = setTimeout(greet, 220);
    });

    pet.addEventListener('dblclick', function () {
      clearTimeout(clickTimer);
      toggleScale();
    });

    pet.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        greet();
      }
    });
  }

  function build() {
    pet = document.createElement('div');
    pet.className = 'jx-pet';
    pet.setAttribute('role', 'button');
    pet.setAttribute('tabindex', '0');
    pet.setAttribute('aria-label', '鲸鱼娘桌宠：拖动能移动，点一下会说话，双击放大');
    pet.innerHTML =
      '<div class="jx-pet__viewport"><div class="jx-pet__strip"></div></div>' +
      '<span class="jx-pet__bubble" role="status" aria-live="polite"></span>' +
      '<button class="jx-pet__close" type="button" aria-label="收起桌宠">×</button>';
    document.body.appendChild(pet);

    bubble = pet.querySelector('.jx-pet__bubble');
    closeBtn = pet.querySelector('.jx-pet__close');

    var saved = parsePos(read(POS_KEY, ''));
    var m = metrics();
    if (saved) {
      moveTo(saved.x, saved.y, false);
    } else {
      moveTo(window.innerWidth - m.w - 20, window.innerHeight - m.h - 20, false);
    }

    if (read(HIDE_KEY, '0') === '1') {
      pet.hidden = true;
      ensureRestore(true);
    }

    closeBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      write(HIDE_KEY, '1');
      pet.hidden = true;
      ensureRestore(true);
    });

    bindDrag();

    if (read(HINT_KEY, '0') !== '1' && !pet.hidden) {
      setTimeout(function () {
        showBubble('拖我一下试试～');
        write(HINT_KEY, '1');
      }, 2200);
    }

    window.addEventListener('resize', function () {
      if (!pet || pet.hidden) return;
      moveTo(pos.x, pos.y, true);
    }, { passive: true });
  }

  function schedule() {
    var start = function () {
      setTimeout(build, 600);
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(start, { timeout: 2500 });
    } else {
      start();
    }
  }

  if (document.readyState === 'complete') {
    schedule();
  } else {
    window.addEventListener('load', schedule, { once: true });
  }
})();
