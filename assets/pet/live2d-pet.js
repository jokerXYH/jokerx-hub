/* ============================================================
   Joker X · 鲸鱼娘桌宠（Live2D）
   ------------------------------------------------------------
   代码 MIT：Andersen216/dsh-whale-girl-live2d
   模型 CC BY-NC-SA 4.0（上善无形 / ZipZipPipe / 氵六青）
   运行时：PIXI.js、pixi-live2d-display、Live2D Cubism Core、@pixi/unsafe-eval
   详见 assets/pet/NOTICE.md。

   交互：
     · 拖拽移动（位置记住）
     · 点一下：挥手 + 台词
     · 右键 / 长按：动作与表情菜单（含摸摸头、隐藏）
     · 视线跟随、随机小动作、切后台暂停
     · 默认不加载模型（约 5 MB），召唤一次后下次自动加载
   ============================================================ */
(function () {
  'use strict';

  var BASE = 'assets/pet/live2d/';
  var API_BASE = '/api/pet/';
  var MODEL_PATH = 'model/c_0120.model3.json';
  var SCRIPTS = [
    BASE + 'vendor/pixi.min.js',
    BASE + 'vendor/unsafe-eval.min.js',
    BASE + 'vendor/live2dcubismcore.min.js',
    BASE + 'vendor/cubism4.min.js'
  ];

  var POS_KEY = 'jx_pet2_pos_v2';
  var HIDE_KEY = 'jx_pet2_hidden_v2';
  var AUTO_KEY = 'jx_pet2_auto_v2';

  var LINES = [
    '今天也要顺顺利利呀',
    '点名前记得刷新一下名单',
    '喝口水吧，我帮你看时间',
    'β1 的同学可以先排除哦',
    '拖我去别的位置也可以',
    '慢一点也没关系'
  ];
  var MOTIONS = [
    { name: 'selfie', label: '自拍' },
    { name: 'openLid', label: '开盖' },
    { name: 'ketchup', label: '番茄酱' }
  ];
  var EXPRESSIONS = [
    { name: '开心兴奋', label: '开心' },
    { name: '生气', label: '生气' },
    { name: '哭', label: '哭' },
    { name: '脸红', label: '脸红' },
    { name: '星星眼', label: '星星眼' },
    { name: '爱心眼', label: '爱心眼' },
    { name: '墨镜', label: '墨镜' },
    { name: '吐舌', label: '吐舌' },
    { name: '晕晕', label: '晕晕' },
    { name: '调皮', label: '调皮' }
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
  var canvas = null;
  var bubble = null;
  var chip = null;
  var menu = null;
  var app = null;
  var model = null;
  var artBox = null;
  var loaded = false;
  var loading = false;
  var failed = false;
  var pos = { x: 0, y: 0 };
  var drag = null;
  var suppressClick = false;
  var bubbleTimer = 0;
  var clickTimer = 0;
  var focusRaf = 0;
  var pointer = null;
  var pressTimer = 0;
  var idleTimer = 0;
  var expressionTimer = 0;
  var resetOnFinish = false;
  var propSnapshot = null;
  var wantShow = false;
  var loadWatchdog = 0;

  // 动作会用到的道具参数（手机 / 泡泡 / 蛋包饭…）。这些参数动作结束后不会自动复位，
  // 但也不能一律清零：像 paopao* 在待机时本来就有值，清零会让眼睛变花。
  var PROP_PARAMS = [
    'phone', 'phone2', 'phone3', 'phone4', 'phone5', 'phone6',
    'pointZ2', 'point', 'keyboard', 'xbox',
    'danbaofan', 'danbaoX', 'danbaoY', 'danbaoz', 'ji', 'aixing',
    'paopao', 'paopao2', 'paopao3', 'paopao4', 'paopao5',
    'chuipaopao', 'chuipaopao1', 'chuipaopao2', 'chuipaopao3',
    'chuipaopao4', 'chuipaopao5', 'chuipaopao6', 'chuipaopao7'
  ];

  /** 播放前记下道具参数，动作结束按原值还原（不碰表情与眼睛）。 */
  function snapshotProps() {
    if (!model) return;
    var core = model.internalModel.coreModel;
    propSnapshot = {};
    PROP_PARAMS.forEach(function (id) {
      try {
        propSnapshot[id] = core.getParameterValueById(id);
      } catch (error) {
        // 忽略
      }
    });
  }

  function restoreProps() {
    if (!model || !propSnapshot) return;
    var core = model.internalModel.coreModel;
    Object.keys(propSnapshot).forEach(function (id) {
      try {
        core.setParameterValueById(id, propSnapshot[id], 1);
      } catch (error) {
        // 忽略
      }
    });
  }

  /* ---------- 位置 ---------- */

  function metrics() {
    var rect = pet ? pet.getBoundingClientRect() : { width: 240, height: 300 };
    return { w: rect.width || 240, h: rect.height || 300 };
  }

  function clampPos(x, y) {
    var m = metrics();
    return {
      x: Math.min(Math.max(6, x), Math.max(6, window.innerWidth - m.w - 6)),
      y: Math.min(Math.max(6, y), Math.max(6, window.innerHeight - m.h - 6))
    };
  }

  function applyPos(persist) {
    if (!pet) return;
    pet.style.transform = 'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)';
    if (persist) {
      write(POS_KEY, Math.round(pos.x) + ',' + Math.round(pos.y));
    }
  }

  function moveTo(x, y, persist) {
    pos = clampPos(x, y);
    applyPos(persist);
  }

  function parsePos(raw) {
    var parts = String(raw || '').split(',');
    if (parts.length !== 2) return null;
    var x = Number(parts[0]);
    var y = Number(parts[1]);
    if (!isFinite(x) || !isFinite(y)) return null;
    return { x: x, y: y };
  }

  /* ---------- 气泡 ---------- */

  function showBubble(text) {
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add('is-on');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () {
      bubble.classList.remove('is-on');
    }, 3600);
  }

  function randomLine() {
    return LINES[Math.floor(Math.random() * LINES.length)];
  }

  /* ---------- 小胶囊：召唤 / 加载 / 召回 ---------- */

  function setChip(label, options) {
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'jx-pet2-chip';
      chip.addEventListener('click', onChipClick);
      // 鼠标移到胶囊上就开始预加载：点下去基本是秒出
      chip.addEventListener('pointerenter', function () {
        if (!loaded && !loading && !failed) loadPet({ silent: true });
      });
      document.body.appendChild(chip);
    }
    chip.textContent = label;
    chip.disabled = Boolean(options && options.disabled);
    chip.hidden = Boolean(options && options.hidden);
  }

  function showPetNow() {
    if (!pet) return;
    write(HIDE_KEY, '0');
    pet.hidden = false;
    setChip('', { hidden: true });
    resumeRender();
  }

  function onChipClick() {
    wantShow = true;
    if (loading) {
      setChip('正在召唤鲸鱼娘…', { disabled: true });
      return;
    }
    if (failed) {
      failed = false;
      loadPet();
      return;
    }
    if (loaded) {
      showPetNow();
      showBubble('我回来啦');
    } else {
      loadPet();
    }
  }

  /* ---------- Live2D ---------- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var timer = setTimeout(function () {
        reject(new Error('timeout: ' + src));
      }, 20000);
      script.src = src;
      script.async = false;
      script.onload = function () {
        clearTimeout(timer);
        resolve();
      };
      script.onerror = function () {
        clearTimeout(timer);
        reject(new Error('script failed: ' + src));
      };
      document.head.appendChild(script);
    });
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('timeout: ' + label));
      }, ms);
      promise.then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function loadScripts() {
    return SCRIPTS.reduce(function (chain, src) {
      return chain.then(function () { return loadScript(src); });
    }, Promise.resolve());
  }

  function measureArt() {
    // 模型画布 4068×4068，四周大量透明留白；按真实像素范围缩放才显得大小合适
    var m = metrics();
    var probe = Math.min(m.w, m.h) / 4200;
    model.scale.set(probe);
    model.anchor.set(0, 0);
    model.x = 0;
    model.y = 0;
    try {
      app.renderer.render(app.stage);
      var shot = app.renderer.extract.pixels();
      var px = shot.pixels;
      var w = shot.width;
      var h = shot.height;
      var minX = w;
      var minY = h;
      var maxX = -1;
      var maxY = -1;
      for (var y = 0; y < h; y += 2) {
        for (var x = 0; x < w; x += 2) {
          if (px[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0 || maxY < 0) return null;
      return {
        x: minX / probe,
        y: minY / probe,
        w: (maxX - minX + 1) / probe,
        h: (maxY - minY + 1) / probe
      };
    } catch (error) {
      return null;
    }
  }

  function fitModel() {
    var m = metrics();
    if (!artBox) {
      var iw = model.internalModel.width || 1;
      var ih = model.internalModel.height || 1;
      var fallback = Math.min(m.w / iw, m.h / ih) * 0.98;
      model.scale.set(fallback);
      model.anchor.set(0.5, 0.5);
      model.x = m.w / 2;
      model.y = m.h / 2;
      return;
    }
    var fit = Math.min(m.w / artBox.w, m.h / artBox.h) * 0.98;
    model.scale.set(fit);
    model.anchor.set(0, 0);
    model.x = m.w / 2 - (artBox.x + artBox.w / 2) * fit;
    model.y = m.h / 2 - (artBox.y + artBox.h / 2) * fit;
  }

  function startIdle() {
    if (!model || prefersReduced()) return;
    try {
      model.motion('idle');
    } catch (error) {
      // 没有 idle 动作：忽略
    }
  }

  function initLive2d() {
    var m = metrics();
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas = document.createElement('canvas');
    pet.insertBefore(canvas, pet.firstChild);
    app = new PIXI.Application({
      view: canvas,
      width: m.w,
      height: m.h,
      backgroundAlpha: 0,
      antialias: true,
      resolution: dpr,
      autoDensity: true,
      powerPreference: 'low-power'
    });
    app.ticker.maxFPS = 30;

    var Live2DModel = PIXI.live2d.Live2DModel;
    Live2DModel.registerTicker(PIXI.Ticker);

    // 站点 nginx 禁止直接访问 *.json，模型设置/动作走 /api/pet/ 透传；
    // 本地静态预览没有这个接口，回退到静态路径。
    return withTimeout(Live2DModel.from(API_BASE + MODEL_PATH, { autoInteract: false }), 30000, 'api model')
      .catch(function () {
        return withTimeout(Live2DModel.from(BASE + MODEL_PATH, { autoInteract: false }), 30000, 'static model');
      })
      .then(function (instance) {
        model = instance;
        app.stage.addChild(model);
        artBox = measureArt();
        fitModel();
        startIdle();
        model.internalModel.motionManager.on('motionFinish', function () {
          if (resetOnFinish) {
            resetOnFinish = false;
            restoreProps();
            resetExpression();
          }
          startIdle();
        });
        scheduleIdleAction();
      });
  }

  function loadPet(options) {
    options = options || {};
    if (options.show) wantShow = true;
    if (loading || loaded) return;
    loading = true;
    failed = false;
    if (wantShow) setChip('正在召唤鲸鱼娘…', { disabled: true });

    loadScripts()
      .then(initLive2d)
      .then(function () {
        clearTimeout(loadWatchdog);
        loading = false;
        loaded = true;
        write(AUTO_KEY, '1');
        if (wantShow) {
          showPetNow();
          showBubble(randomLine());
        } else {
          // 预加载完成：先藏着，点胶囊秒出
          if (pet) pet.hidden = true;
          setChip('召唤鲸鱼娘', {});
        }
      })
      .catch(function (error) {
        clearTimeout(loadWatchdog);
        failLoad(error);
      });

    // 看门狗：脚本/模型任一环节卡死时，别让按钮一直转
    clearTimeout(loadWatchdog);
    loadWatchdog = setTimeout(function () {
      if (!loading) return;
      failLoad(new Error('load watchdog timeout'));
    }, 60000);
  }

  function failLoad(error) {
    loading = false;
    failed = true;
    if (wantShow) setChip('加载失败，点我重试', {});
    if (app) {
      try { app.destroy(true); } catch (e) { /* 忽略 */ }
      app = null;
    }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    if (window.console && console.warn) console.warn('[桌宠] 加载失败', error);
  }

  function resumeRender() {
    if (app) app.ticker.start();
  }

  function pauseRender() {
    if (app) app.ticker.stop();
  }

  /* ---------- 动作 / 表情 ---------- */

  function playMotion(name, options) {
    if (!model || !name) return;
    // 菜单里点的动作：做完回到默认表情 + 待机（随机小动作不清表情）
    resetOnFinish = !(options && options.keepExpression);
    // 先记下道具参数，动作结束按快照还原，手机 / 蛋包饭不会残留
    snapshotProps();
    try {
      model.motion(name, 0, 3);
    } catch (error) {
      // 动作不存在：忽略
    }
  }

  /** 道具参数归零：手机、泡泡、蛋包饭等不会再留在画面里。 */
  function clearProps() {
    if (!model) return;
    var core = model.internalModel.coreModel;
    PROP_PARAMS.forEach(function (id) {
      try {
        core.setParameterValueById(id, 0, 1);
      } catch (error) {
        // 模型里没有这个参数：忽略
      }
    });
  }

  /** 恢复默认表情（Live2D 的表情会一直生效，必须显式重置）。 */
  function resetExpression() {
    clearTimeout(expressionTimer);
    if (!model) return;
    try {
      model.expression();
    } catch (error) {
      // 忽略
    }
  }

  function applyExpression(name) {
    if (!model) return;
    try {
      model.expression(name || undefined);
    } catch (error) {
      // 表情不存在：忽略
    }
    clearTimeout(expressionTimer);
    if (name) {
      // 表情只保持 8 秒，然后回到默认
      expressionTimer = setTimeout(resetExpression, 8000);
    }
  }

  function pat() {
    if (!model) return;
    if (!prefersReduced()) {
      playMotion(MOTIONS[Math.floor(Math.random() * MOTIONS.length)].name);
    }
    showBubble(randomLine());
  }

  /** 每隔 30~70 秒自己做个随机小动作，让她看起来是活的。 */
  function scheduleIdleAction() {
    clearTimeout(idleTimer);
    if (prefersReduced()) return;
    var delay = 30000 + Math.random() * 40000;
    idleTimer = setTimeout(function () {
      if (pet && !pet.hidden && !document.hidden && model) {
        playMotion(MOTIONS[Math.floor(Math.random() * MOTIONS.length)].name,
          { keepExpression: true });
      }
      scheduleIdleAction();
    }, delay);
  }

  /* ---------- 右键菜单 ---------- */

  function buildMenu() {
    menu = document.createElement('div');
    menu.className = 'jx-pet2-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    var motionChips = MOTIONS.map(function (item) {
      return '<button type="button" data-motion="' + item.name + '">' + item.label + '</button>';
    }).join('');
    var expressionChips = EXPRESSIONS.map(function (item) {
      return '<button type="button" data-expression="' + item.name + '">' + item.label + '</button>';
    }).join('');

    menu.innerHTML =
      '<p class="jx-pet2-menu-title">小动作</p>' +
      '<div class="jx-pet2-menu-chips">' + motionChips + '</div>' +
      '<p class="jx-pet2-menu-title">表情</p>' +
      '<div class="jx-pet2-menu-chips">' + expressionChips +
        '<button type="button" data-expression="">恢复</button></div>' +
      '<div class="jx-pet2-menu-actions">' +
        '<button type="button" data-action="pat">摸摸头</button>' +
        '<button type="button" data-action="hide">隐藏桌宠</button>' +
      '</div>';

    menu.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      var motion = button.getAttribute('data-motion');
      var expression = button.getAttribute('data-expression');
      var action = button.getAttribute('data-action');
      if (motion) playMotion(motion);
      else if (expression !== null) applyExpression(expression);
      else if (action === 'pat') pat();
      else if (action === 'hide') hidePet();
      hideMenu();
    });

    document.body.appendChild(menu);
  }

  function showMenu(clientX, clientY) {
    if (!menu) buildMenu();
    menu.hidden = false;
    var rect = menu.getBoundingClientRect();
    var x = Math.min(Math.max(8, clientX), window.innerWidth - rect.width - 8);
    var y = Math.min(Math.max(8, clientY), window.innerHeight - rect.height - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function hideMenu() {
    if (menu && !menu.hidden) menu.hidden = true;
  }

  function hidePet() {
    if (!pet) return;
    write(HIDE_KEY, '1');
    pet.hidden = true;
    pauseRender();
    hideMenu();
    resetExpression();
    restoreProps();
    setChip('叫回鲸鱼娘', {});
  }

  /* ---------- 交互 ---------- */

  function focusAt(clientX, clientY) {
    if (!model || !canvas) return;
    pointer = { x: clientX, y: clientY };
    if (focusRaf) return;
    focusRaf = window.requestAnimationFrame(function () {
      focusRaf = 0;
      if (!model || !canvas || !pointer) return;
      var rect = canvas.getBoundingClientRect();
      try {
        model.focus(pointer.x - rect.left, pointer.y - rect.top);
      } catch (error) {
        // 忽略
      }
    });
  }

  function bindInteractions() {
    pet.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      hideMenu();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: pos.x,
        originY: pos.y,
        moved: false
      };
      try { pet.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
      pet.classList.add('is-dragging');

      // 触屏长按 = 右键菜单
      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        if (drag && !drag.moved) {
          showMenu(drag.startX, drag.startY);
          drag = null;
          pet.classList.remove('is-dragging');
        }
      }, 550);
    });

    pet.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.id) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      clearTimeout(pressTimer);
      moveTo(drag.originX + dx, drag.originY + dy, false);
    });

    function endDrag(event) {
      clearTimeout(pressTimer);
      if (!drag || event.pointerId !== drag.id) return;
      var moved = drag.moved;
      drag = null;
      pet.classList.remove('is-dragging');
      try { pet.releasePointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
      if (moved) {
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 350);
        applyPos(true);
      }
    }

    pet.addEventListener('pointerup', endDrag);
    pet.addEventListener('pointercancel', endDrag);

    pet.addEventListener('click', function () {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(pat, 220);
    });

    pet.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      showMenu(event.clientX, event.clientY);
    });

    pet.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pat();
      }
    });

    document.addEventListener('pointerdown', function (event) {
      if (menu && !menu.hidden && !menu.contains(event.target) && !pet.contains(event.target)) {
        hideMenu();
      }
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') hideMenu();
    });

    window.addEventListener('pointermove', function (event) {
      if (!loaded || !pet || pet.hidden) return;
      focusAt(event.clientX, event.clientY);
    }, { passive: true });

    window.addEventListener('resize', function () {
      if (!pet || pet.hidden) return;
      moveTo(pos.x, pos.y, true);
      if (app) {
        var m = metrics();
        app.renderer.resize(m.w, m.h);
        if (model) fitModel();
      }
      hideMenu();
    }, { passive: true });

    document.addEventListener('visibilitychange', function () {
      if (!app) return;
      if (document.hidden) app.ticker.stop();
      else if (pet && !pet.hidden) app.ticker.start();
    });
  }

  /* ---------- 构建 ---------- */

  /** 桌面端、非省流量、非慢网时才静默预加载（避免手机流量用户白下 3MB）。 */
  function shouldPreload() {
    if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      return false;
    }
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return true;
    if (conn.saveData) return false;
    var type = conn.effectiveType || '';
    return type !== 'slow-2g' && type !== '2g' && type !== '3g';
  }

  function build() {
    pet = document.createElement('div');
    pet.className = 'jx-pet2';
    pet.setAttribute('role', 'button');
    pet.setAttribute('tabindex', '0');
    pet.setAttribute('aria-label', '鲸鱼娘桌宠：拖动移动，点一下会说话，右键打开动作菜单');
    pet.innerHTML = '<span class="jx-pet2__bubble" role="status" aria-live="polite"></span>';
    document.body.appendChild(pet);

    bubble = pet.querySelector('.jx-pet2__bubble');

    var saved = parsePos(read(POS_KEY, ''));
    var m = metrics();
    if (saved) moveTo(saved.x, saved.y, false);
    else moveTo(window.innerWidth - m.w - 16, window.innerHeight - m.h - 16, false);

    bindInteractions();
    buildMenu();

    if (read(HIDE_KEY, '0') === '1') {
      pet.hidden = true;
      setChip('叫回鲸鱼娘', {});
      return;
    }

    pet.hidden = true; // 模型加载后再显示，避免空白框

    if (read(AUTO_KEY, '0') === '1') {
      // 召唤过：延后自动加载，加载完直接出现（不再先显示空白框）
      setTimeout(function () { loadPet({ show: true }); }, 1200);
    } else {
      setChip('召唤鲸鱼娘', {});
      // 桌面端空闲时先悄悄加载好，点胶囊基本秒出
      if (shouldPreload()) {
        setTimeout(function () { loadPet({ silent: true }); }, 2500);
      }
    }
  }

  function schedule() {
    var start = function () { setTimeout(build, 500); };
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
