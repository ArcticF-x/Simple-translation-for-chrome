/* AI 网页翻译 - 页面脚本 */
(() => {
  if (window.__aiPageTranslatorInjected) return;
  window.__aiPageTranslatorInjected = true;

  const SKIP_SELECTOR = [
    'script',
    'style',
    'noscript',
    'template',
    'textarea',
    'input',
    'select',
    'option',
    'optgroup',
    'code',
    'pre',
    'kbd',
    'samp',
    'var',
    'svg',
    'canvas',
    'iframe',
    'video',
    'audio',
    'object',
    'embed',
    'math',
    'button',
    '[role="button"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[translate="no"]',
    '[aria-hidden="true"]',
    '.notranslate',
    '.ai-trans',
    '#ai-translator-status',
    '#ai-selection-tools'
  ].join(',');

  const state = {
    running: false,
    cancelled: false,
    translated: false,
    mode: 'bilingual',
    lang: '简体中文',
    token: 0,
    batchSeq: 0,
    activeBatch: null,
    cache: new Map(),
    records: [],
    progress: { done: 0, total: 0 }
  };

  let statusHost = null;
  let statusRoot = null;
  let statusTextEl = null;
  let statusStopBtn = null;
  let statusTrackEl = null;
  let statusBarEl = null;
  let statusCardEl = null;
  let statusTimer = null;
  let progressNotifyTimer = null;

  function getState() {
    return {
      translated: state.translated,
      running: state.running,
      mode: state.mode,
      lang: state.lang,
      progress: { ...state.progress }
    };
  }

  function notify(extra = {}) {
    try {
      const result = chrome.runtime.sendMessage({ type: 'TRANSLATION_PROGRESS', ...getState(), ...extra });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {
      /* 弹窗未打开时忽略 */
    }
  }

  /* ------------------------------ 文本收集 ------------------------------ */

  function collectTextNodes() {
    if (!document.body) return [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const raw = node.nodeValue;
        if (!raw || !raw.trim()) return NodeFilter.FILTER_REJECT;
        if (!/\p{L}/u.test(raw)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (parent.getClientRects().length === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);
    return nodes;
  }

  function splitWhitespace(raw) {
    const lead = (raw.match(/^\s+/) || [''])[0];
    const trail = (raw.match(/\s+$/) || [''])[0];
    return [lead, trail];
  }

  function applyTranslation(node, translation) {
    const raw = node.nodeValue;
    if (raw == null || raw.trim() === '') return;
    const [lead, trail] = splitWhitespace(raw);

    if (state.mode === 'replace') {
      state.records.push({ node, raw, type: 'replace' });
      node.nodeValue = lead + translation + trail;
      return;
    }

    if (!node.parentNode) return;
    const parent = node.parentElement;
    const display = parent ? getComputedStyle(parent).display : 'inline';
    const isInline = display.startsWith('inline') || display === 'contents' || display === 'ruby';

    const span = document.createElement('span');
    span.className = 'ai-trans ' + (isInline ? 'ai-trans--inline' : 'ai-trans--block');
    span.setAttribute('data-ai-trans', '1');
    span.textContent = translation;

    node.parentNode.insertBefore(span, node.nextSibling);
    state.records.push({ node, raw, type: 'insert', el: span });
  }

  function restorePage(shouldNotify = true) {
    if (state.running) state.cancelled = true;
    state.token += 1;

    for (let i = state.records.length - 1; i >= 0; i--) {
      const record = state.records[i];
      if (record.type === 'replace') {
        try {
          record.node.nodeValue = record.raw;
        } catch (_) {
          /* 节点可能已被页面移除 */
        }
      } else if (record.el && record.el.parentNode) {
        record.el.parentNode.removeChild(record.el);
      }
    }

    state.records = [];
    state.translated = false;
    state.running = false;
    state.cancelled = false;
    state.activeBatch = null;
    state.progress = { done: 0, total: 0 };
    clearTimeout(progressNotifyTimer);
    progressNotifyTimer = null;
    hideStatus();

    if (shouldNotify) notify({ state: 'restored' });
    return getState();
  }

  /* ------------------------------ 分批与请求 ------------------------------ */

  /** 计算一段文本相对当前视口的优先级：可见 > 下方最近 > 上方最近 */
  function viewportPriority(key, byKey) {
    const nodes = byKey.get(key) || [];
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    let best = null;

    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent) continue;

      let rect = parent.getBoundingClientRect();

      // display:contents 等情况父元素没有尺寸，退回到文本自身的范围
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          rect = range.getBoundingClientRect();
        } catch (_) {
          /* ignore */
        }
      }
      if (!rect || (rect.width === 0 && rect.height === 0)) continue;

      let candidate;
      if (rect.bottom > 0 && rect.top < viewportHeight) {
        candidate = { group: 0, distance: Math.max(0, rect.top) };
      } else if (rect.top >= viewportHeight) {
        candidate = { group: 1, distance: rect.top - viewportHeight };
      } else {
        candidate = { group: 2, distance: -rect.bottom };
      }

      if (
        !best ||
        candidate.group < best.group ||
        (candidate.group === best.group && candidate.distance < best.distance)
      ) {
        best = candidate;
      }
    }

    return best || { group: 3, distance: 0 };
  }

  /** 每次请求前按当前视口重新排序，用户滚动后下一批会跟上 */
  function prioritizePending(pending, byKey) {
    return pending
      .map((key, order) => ({ key, order, ...viewportPriority(key, byKey) }))
      .sort(
        (a, b) => a.group - b.group || a.distance - b.distance || a.order - b.order
      )
      .map((item) => item.key);
  }

  async function requestTranslations(segments, batchId) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_SEGMENTS',
        segments,
        targetLang: state.lang,
        batchId
      });
    } catch (_) {
      throw new Error('扩展后台无响应，请重新加载扩展');
    }

    if (!response) throw new Error('扩展后台无响应，请重新加载扩展');
    if (!response.ok) {
      const error = new Error(response.error || '翻译请求失败');
      error.fatal = !!response.fatal;
      throw error;
    }
    return Array.isArray(response.translations) ? response.translations : [];
  }

  /* ------------------------------ 翻译流程 ------------------------------ */

  function applyFromCache() {
    const nodes = collectTextNodes();
    for (const node of nodes) {
      const key = node.nodeValue.trim();
      const translation = state.cache.get(key);
      if (translation != null && translation !== key) {
        applyTranslation(node, translation);
      }
    }
    state.translated = state.records.length > 0;
  }

  function noteProgress(active, key) {
    if (!active || active.done.has(key)) return;
    active.done.add(key);
    state.progress.done = Math.min(state.progress.total, state.progress.done + 1);
    updateStatus(state.progress.done, state.progress.total);

    if (progressNotifyTimer) return;
    progressNotifyTimer = setTimeout(() => {
      progressNotifyTimer = null;
      notify({ state: 'running' });
    }, 150);
  }

  /** 后台流式推送：收到一条译文就立刻渲染一条 */
  function applyDelta(msg) {
    const active = state.activeBatch;
    if (!active || !state.running || state.cancelled) return;
    if (active.id !== msg.batchId) return;

    const index = Number(msg.index);
    if (!Number.isInteger(index) || index < 0) return;
    const key = active.keys[index];
    if (key == null) return;
    if (active.applied.has(key)) return;

    const text = String(msg.text || '').trim();
    if (!text || text === key) {
      noteProgress(active, key);
      return;
    }

    active.applied.add(key);
    state.cache.set(key, text);
    for (const node of active.byKey.get(key) || []) {
      if (node.nodeValue.trim() === key) applyTranslation(node, text);
    }
    state.translated = state.records.length > 0;
    noteProgress(active, key);
  }

  async function translatePage(mode, targetLang) {
    if (state.running) return;
    if (state.translated) restorePage(false);

    const nextMode = mode === 'replace' ? 'replace' : 'bilingual';
    const nextLang = String(targetLang || state.lang || '简体中文').trim() || '简体中文';

    if (state.lang !== nextLang) {
      state.cache.clear();
      state.lang = nextLang;
    }
    state.mode = nextMode;

    const token = ++state.token;
    state.running = true;
    state.cancelled = false;
    state.activeBatch = null;
    state.progress = { done: 0, total: 0 };
    notify({ state: 'running' });

    const nodes = collectTextNodes();
    if (!nodes.length) {
      state.running = false;
      state.progress = { done: 0, total: 0 };
      showStatus('未找到可翻译的文本', { error: true, autoHide: 3000 });
      notify({ state: 'empty', message: '未找到可翻译的文本' });
      return;
    }

    const byKey = new Map();
    for (const node of nodes) {
      const key = node.nodeValue.trim();
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(node);
    }

    // 先用缓存立即渲染（切换模式 / 重复翻译时几乎无等待）
    for (const [key, list] of byKey) {
      const translation = state.cache.get(key);
      if (translation == null) continue;
      for (const node of list) {
        if (node.nodeValue.trim() === key) applyTranslation(node, translation);
      }
    }
    state.translated = state.records.length > 0;

    const pending = [];
    for (const key of byKey.keys()) {
      if (!state.cache.has(key)) pending.push(key);
    }

    if (!pending.length) {
      state.running = false;
      state.progress = { done: 0, total: 0 };
      const message = state.translated ? '翻译完成' : '没有需要翻译的内容';
      showStatus(message, { autoHide: 2200 });
      notify({ state: 'done', message });
      return;
    }

    let queue = pending.slice();
    state.progress = { done: 0, total: pending.length };
    showStatus(`翻译中 0/${pending.length}`, { stop: true });
    notify({ state: 'running' });

    let failedBatches = 0;
    let succeededBatches = 0;
    let fatalError = null;

    while (queue.length) {
      if (state.cancelled || token !== state.token) break;

      const ordered = prioritizePending(queue, byKey);
      const batch = [];
      let chars = 0;
      for (const key of ordered) {
        if (batch.length && (batch.length >= 10 || chars + key.length > 900)) break;
        batch.push(key);
        chars += key.length;
      }
      if (!batch.length) break;

      const selected = new Set(batch);
      queue = queue.filter((key) => !selected.has(key));
      const active = {
        id: ++state.batchSeq,
        keys: batch,
        byKey,
        applied: new Set(),
        done: new Set()
      };
      state.activeBatch = active;

      try {
        const translations = await requestTranslations(batch, active.id);
        if (token !== state.token) return;
        if (state.cancelled) break;

        if (translations.length !== batch.length) throw new Error('翻译结果数量不匹配');

        for (let i = 0; i < batch.length; i++) {
          const key = batch[i];
          const translation = typeof translations[i] === 'string' ? translations[i].trim() : '';
          const finalText = translation || key;

          // 流式阶段已经渲染过的片段不再重复插入
          if (!active.applied.has(key)) {
            state.cache.set(key, finalText);
            if (finalText !== key) {
              active.applied.add(key);
              for (const node of active.byKey.get(key) || []) {
                if (node.nodeValue.trim() === key) applyTranslation(node, finalText);
              }
            }
          }
          noteProgress(active, key);
        }
        state.translated = state.records.length > 0;
        succeededBatches += 1;
      } catch (err) {
        if (err && err.fatal) {
          fatalError = err;
          break;
        }
        failedBatches += 1;
      } finally {
        if (state.activeBatch === active) state.activeBatch = null;
      }

      notify({ state: 'running' });
    }

    state.activeBatch = null;
    if (token !== state.token) return;

    const cancelled = state.cancelled;
    state.running = false;
    state.cancelled = false;

    if (cancelled) {
      notify({ state: 'stopped' });
      return;
    }

    if (fatalError) {
      const message = fatalError.message || '请求失败';
      showStatus(`翻译失败：${message}`, { error: true, autoHide: 6000 });
      notify({ state: 'error', message });
      return;
    }

    if (state.translated) {
      const message = failedBatches
        ? `翻译完成（${failedBatches} 段未成功）`
        : '翻译完成';
      showStatus(message, { autoHide: 2200 });
      notify({ state: 'done', message });
    } else if (succeededBatches > 0) {
      const message = '页面已是目标语言，无需翻译';
      showStatus(message, { autoHide: 2600 });
      notify({ state: 'done', message });
    } else {
      const message = '翻译失败，请检查接口设置';
      showStatus(message, { error: true, autoHide: 5000 });
      notify({ state: 'error', message });
    }
  }

  function setMode(mode) {
    const nextMode = mode === 'replace' ? 'replace' : 'bilingual';
    const wasTranslated = state.translated;
    if (state.mode === nextMode) return getState();

    if (state.running) {
      state.cancelled = true;
      state.token += 1;
      state.running = false;
      state.cancelled = false;
      state.activeBatch = null;
    }

    state.mode = nextMode;

    if (wasTranslated) {
      state.token += 1;
      restorePage(false);
      applyFromCache();
      notify({ state: 'mode' });
    } else {
      notify({ state: 'mode' });
    }

    return getState();
  }

  /* ------------------------------ 状态提示 ------------------------------ */

  const STATUS_CSS = `
    :host { all: initial; }
    .card {
      display: flex; align-items: center; gap: 10px;
      min-width: 196px; max-width: 320px;
      padding: 10px 12px; border-radius: 12px;
      background: rgba(23, 26, 38, .94); color: #fff;
      font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .25);
      box-sizing: border-box; user-select: none;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #7c9cff; flex: none;
      animation: pulse 1.4s ease-in-out infinite;
    }
    .body { flex: 1; min-width: 0; }
    .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
    .track { display: none; height: 3px; margin-top: 6px; border-radius: 999px; background: rgba(255,255,255,.16); overflow: hidden; }
    .track i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #6f8cff, #a77bff); transition: width .25s ease; }
    .stop {
      border: 0; background: rgba(255,255,255,.14); color: #fff;
      font: inherit; font-size: 11px; padding: 4px 8px;
      border-radius: 7px; cursor: pointer; flex: none;
    }
    .stop:hover { background: rgba(255,255,255,.26); }
    .card.error .dot { background: #ff6b6b; animation: none; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  `;

  function ensureStatus() {
    if (statusHost && statusHost.isConnected) return;

    statusHost = document.createElement('div');
    statusHost.id = 'ai-translator-status';
    statusHost.style.cssText =
      'all: initial; position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; display: none;';
    statusRoot = statusHost.attachShadow({ mode: 'open' });
    statusRoot.innerHTML = `
      <style>${STATUS_CSS}</style>
      <div class="card">
        <div class="dot"></div>
        <div class="body">
          <div class="text"></div>
          <div class="track"><i></i></div>
        </div>
        <button class="stop" type="button">停止</button>
      </div>
    `;

    statusCardEl = statusRoot.querySelector('.card');
    statusTextEl = statusRoot.querySelector('.text');
    statusTrackEl = statusRoot.querySelector('.track');
    statusBarEl = statusRoot.querySelector('.track i');
    statusStopBtn = statusRoot.querySelector('.stop');

    statusStopBtn.addEventListener('click', () => {
      state.cancelled = true;
      statusTextEl.textContent = '正在停止…';
      statusStopBtn.style.display = 'none';
    });

    (document.body || document.documentElement).appendChild(statusHost);
  }

  function showStatus(text, options = {}) {
    ensureStatus();
    clearTimeout(statusTimer);
    statusHost.style.display = 'block';
    statusCardEl.classList.toggle('error', !!options.error);
    statusTextEl.textContent = text;
    statusStopBtn.style.display = options.stop ? 'inline-block' : 'none';
    statusTrackEl.style.display = options.stop ? 'block' : 'none';
    statusBarEl.style.width = '0%';

    if (options.autoHide) {
      statusTimer = setTimeout(hideStatus, options.autoHide);
    }
  }

  function updateStatus(done, total) {
    if (!statusHost || !statusHost.isConnected) return;
    statusTextEl.textContent = `翻译中 ${done}/${total}`;
    statusTrackEl.style.display = 'block';
    statusBarEl.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  }

  function hideStatus() {
    clearTimeout(statusTimer);
    if (statusHost && statusHost.isConnected) statusHost.style.display = 'none';
  }

  /* ------------------------------ 划词翻译 ------------------------------ */

  const SELECTION_MAX_CHARS = 5000;
  const SELECTION_SKIP_SELECTOR = [
    'input',
    'textarea',
    'select',
    'option',
    'button',
    '[role="button"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '#ai-selection-tools',
    '#ai-translator-status',
    'pre',
    'code'
  ].join(',');

  const selectionCache = new Map();
  const selectionState = {
    ui: null,
    info: null,
    mode: 'bilingual',
    lang: '简体中文',
    cardOpen: false,
    loading: false,
    requestId: 0,
    text: '',
    range: null,
    anchorNode: null,
    replaced: null,
    lastRect: null
  };
  let selectionTimer = null;
  let selectionFrame = null;

  const SELECTION_CSS = `
    :host { all: initial; }
    .sel-btn {
      position: fixed;
      width: 34px; height: 34px;
      border: 0; border-radius: 10px;
      display: grid; place-items: center;
      background: linear-gradient(135deg, #4f6ef7, #8b5cf6);
      color: #fff;
      font: 700 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 6px 18px rgba(30, 40, 90, .3);
      transition: transform .12s ease, filter .12s ease;
    }
    .sel-btn:hover { transform: translateY(-1px) scale(1.04); filter: brightness(1.05); }
    .sel-btn:active { transform: scale(.96); }
    .sel-btn[hidden] { display: none !important; }

    .sel-card {
      position: fixed;
      width: min(380px, calc(100vw - 24px));
      max-height: min(45vh, 420px);
      display: flex; flex-direction: column;
      background: #fff;
      color: #171a26;
      border: 1px solid rgba(20, 30, 60, .09);
      border-radius: 12px;
      box-shadow: 0 16px 44px rgba(20, 30, 60, .22);
      font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      overflow: hidden;
      pointer-events: auto;
      z-index: 1;
    }
    .sel-card[hidden] { display: none !important; }
    .sel-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
      padding: 8px 8px 6px 12px;
      color: #6b7280;
      font-size: 11px;
      flex: none;
    }
    .sel-title { font-weight: 600; letter-spacing: .3px; }
    .sel-close {
      border: 0; background: transparent; color: #8a90a0;
      width: 22px; height: 22px; border-radius: 6px;
      font: 400 17px/1 -apple-system, sans-serif;
      cursor: pointer;
    }
    .sel-close:hover { background: rgba(0, 0, 0, .06); color: #333; }
    .sel-body {
      padding: 0 12px 10px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      max-height: calc(45vh - 66px);
      color: inherit;
    }
    .sel-body.loading { color: #6b7280; }
    .sel-body.error { color: #c62828; }
    .sel-foot {
      display: flex; gap: 8px;
      padding: 0 12px 10px;
      flex: none;
    }
    .sel-foot[hidden] { display: none !important; }
    .sel-action {
      border: 0; border-radius: 7px;
      padding: 5px 9px;
      background: #eef1ff; color: #3d54c9;
      font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif;
      cursor: pointer;
    }
    .sel-action:hover { background: #e2e7ff; }
    .sel-action[hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) {
      .sel-card {
        background: #1c1f29;
        color: #eef1f8;
        border-color: #2a2f3d;
        box-shadow: 0 16px 44px rgba(0, 0, 0, .55);
      }
      .sel-head { color: #9aa2b4; }
      .sel-close:hover { background: rgba(255, 255, 255, .08); color: #fff; }
      .sel-body.loading { color: #9aa2b4; }
      .sel-body.error { color: #ff9b94; }
      .sel-action { background: #2a2f4a; color: #aab6ff; }
      .sel-action:hover { background: #333a5a; }
    }
  `;

  function eventInSelectionUi(event) {
    const host = selectionState.ui && selectionState.ui.host;
    if (!host) return false;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.includes(host) || event.target === host;
  }

  function ensureSelectionUi() {
    if (selectionState.ui && selectionState.ui.host.isConnected) return selectionState.ui;

    const host = document.createElement('div');
    host.id = 'ai-selection-tools';
    host.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${SELECTION_CSS}</style>
      <button class="sel-btn" type="button" title="翻译选中内容" aria-label="翻译选中内容" hidden>译</button>
      <div class="sel-card" role="dialog" aria-label="选中内容译文" hidden>
        <div class="sel-head">
          <span class="sel-title">译文</span>
          <button class="sel-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="sel-body" dir="auto"></div>
        <div class="sel-foot" hidden>
          <button class="sel-action sel-undo" type="button" hidden>撤销替换</button>
          <button class="sel-action sel-retry" type="button" hidden>重试</button>
        </div>
      </div>
    `;

    const ui = {
      host,
      root,
      btn: root.querySelector('.sel-btn'),
      card: root.querySelector('.sel-card'),
      title: root.querySelector('.sel-title'),
      body: root.querySelector('.sel-body'),
      close: root.querySelector('.sel-close'),
      foot: root.querySelector('.sel-foot'),
      undo: root.querySelector('.sel-undo'),
      retry: root.querySelector('.sel-retry')
    };

    const keepSelection = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    ui.btn.addEventListener('pointerdown', keepSelection, true);
    ui.btn.addEventListener('mousedown', keepSelection, true);
    ui.btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      translateSelection();
    });
    ui.card.addEventListener('pointerdown', (event) => event.stopPropagation());
    ui.card.addEventListener('mousedown', (event) => event.stopPropagation());
    ui.card.addEventListener('click', (event) => event.stopPropagation());
    ui.close.addEventListener('click', () => closeSelectionCard());
    ui.undo.addEventListener('click', () => undoSelectionReplace());
    ui.retry.addEventListener('click', () => retrySelectionTranslation());

    (document.documentElement || document.body).appendChild(host);
    selectionState.ui = ui;
    return ui;
  }

  function rangeRect(range) {
    let rect = null;
    const rects = range.getClientRects ? range.getClientRects() : null;
    if (rects && rects.length) rect = rects[rects.length - 1];
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const box = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
      if (box && (box.width || box.height)) rect = box;
    }
    return rect || null;
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const text = selection.toString().trim();
    if (!text || !/\p{L}/u.test(text) || text.length > SELECTION_MAX_CHARS) return null;

    const container = range.commonAncestorContainer;
    const asElement = (node) =>
      node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    const element = asElement(container);
    if (!element) return null;
    if (element.getRootNode() !== document) return null;
    if (element.closest(SELECTION_SKIP_SELECTOR)) return null;

    const startElement = asElement(range.startContainer);
    const endElement = asElement(range.endContainer);
    const blocked = (node) =>
      !node || node.getRootNode() !== document || node.closest(SELECTION_SKIP_SELECTOR);
    if (blocked(startElement) || blocked(endElement)) return null;

    const rect = rangeRect(range);
    if (!rect) return null;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    if (rect.bottom < 0 || rect.top > viewportHeight) return null;

    return { range: range.cloneRange(), text, rect };
  }

  function positionSelectionButton(rect) {
    const ui = selectionState.ui;
    if (!ui || !rect) return;

    const size = 34;
    const margin = 8;
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    if (rect.bottom < 0 || rect.top > vh) {
      ui.btn.hidden = true;
      return;
    }

    let left = rect.right + margin;
    let top = rect.bottom - size;
    if (left + size > vw - margin) left = rect.left - size - margin;
    if (left < margin) {
      left = Math.min(vw - size - margin, Math.max(margin, rect.right - size));
    }
    top = Math.max(margin, Math.min(top, vh - size - margin));

    ui.btn.style.left = `${Math.round(left)}px`;
    ui.btn.style.top = `${Math.round(top)}px`;
  }

  function refreshSelectionButton() {
    if (selectionState.loading) return;
    const info = readSelection();
    if (!info) {
      hideSelectionButton();
      return;
    }

    selectionState.info = info;
    selectionState.lastRect = info.rect;
    const ui = ensureSelectionUi();
    positionSelectionButton(info.rect);
    ui.btn.hidden = false;
  }

  function hideSelectionButton() {
    if (selectionState.ui) selectionState.ui.btn.hidden = true;
  }

  function scheduleSelectionCheck() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(refreshSelectionButton, 140);
  }

  function currentAnchorRect() {
    if (selectionState.range) {
      const rect = rangeRect(selectionState.range);
      if (rect) return rect;
    }
    if (selectionState.anchorNode && selectionState.anchorNode.isConnected) {
      const parent = selectionState.anchorNode.parentElement;
      if (parent) {
        const rect = parent.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) return rect;
      }
    }
    return selectionState.lastRect || null;
  }

  function positionSelectionCard() {
    const ui = selectionState.ui;
    if (!ui || !selectionState.cardOpen) return;

    const card = ui.card;
    const margin = 8;
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const width = Math.min(380, vw - margin * 2);
    card.style.width = `${width}px`;

    const height = card.offsetHeight;
    const rect = currentAnchorRect();

    let left = rect ? rect.left : margin;
    let top = rect ? rect.bottom + 10 : vh - height - margin;

    if (rect && top + height > vh - margin) {
      const above = rect.top - height - 10;
      top = above >= margin ? above : Math.max(margin, vh - height - margin);
    }

    left = Math.max(margin, Math.min(left, vw - width - margin));
    top = Math.max(margin, Math.min(top, vh - height - margin));

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = 'visible';
  }

  function scheduleSelectionReposition() {
    if (selectionFrame) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = null;
      if (!selectionState.ui) return;

      if (!selectionState.ui.btn.hidden) {
        const rect = selectionState.info ? rangeRect(selectionState.info.range) : null;
        if (rect) positionSelectionButton(rect);
        else hideSelectionButton();
      }
      if (selectionState.cardOpen) positionSelectionCard();
    });
  }

  function ensureSelectionCardOpen() {
    const ui = ensureSelectionUi();
    if (!selectionState.cardOpen) {
      selectionState.cardOpen = true;
      ui.card.style.visibility = 'hidden';
      ui.card.hidden = false;
    }
    return ui;
  }

  function setSelectionLoading() {
    const ui = ensureSelectionCardOpen();
    selectionState.loading = true;
    ui.title.textContent = '翻译中';
    ui.body.className = 'sel-body loading';
    ui.body.textContent = '正在翻译选中的内容…';
    ui.foot.hidden = true;
    ui.undo.hidden = true;
    ui.retry.hidden = true;
    positionSelectionCard();
    positionSelectionCard();
    requestAnimationFrame(positionSelectionCard);
  }

  function setSelectionText(text, showUndo = false) {
    const ui = ensureSelectionCardOpen();
    selectionState.loading = false;
    ui.title.textContent = showUndo ? '已覆盖原文' : '译文';
    ui.body.className = 'sel-body';
    ui.body.textContent = text;
    ui.foot.hidden = !showUndo;
    ui.undo.hidden = !showUndo;
    ui.retry.hidden = true;
    positionSelectionCard();
    positionSelectionCard();
    requestAnimationFrame(positionSelectionCard);
  }

  function setSelectionError(message) {
    const ui = ensureSelectionCardOpen();
    selectionState.loading = false;
    ui.title.textContent = '翻译失败';
    ui.body.className = 'sel-body error';
    ui.body.textContent = message;
    ui.foot.hidden = false;
    ui.undo.hidden = true;
    ui.retry.hidden = false;
    positionSelectionCard();
    positionSelectionCard();
    requestAnimationFrame(positionSelectionCard);
  }

  function closeSelectionCard() {
    selectionState.requestId += 1;
    selectionState.cardOpen = false;
    selectionState.loading = false;
    selectionState.replaced = null;
    selectionState.range = null;
    selectionState.anchorNode = null;
    selectionState.text = '';

    if (selectionState.ui) {
      selectionState.ui.card.hidden = true;
      selectionState.ui.foot.hidden = true;
      selectionState.ui.undo.hidden = true;
      selectionState.ui.retry.hidden = true;
    }
  }

  function replaceSelectionContents(range, translation) {
    if (!range) return null;
    try {
      const fragment = range.extractContents();
      const node = document.createTextNode(translation);
      range.insertNode(node);
      if (!node.parentNode) return null;
      return { node, fragment };
    } catch (_) {
      return null;
    }
  }

  function undoSelectionReplace() {
    const replaced = selectionState.replaced;
    if (!replaced || !replaced.node || !replaced.node.isConnected || !replaced.node.parentNode) {
      closeSelectionCard();
      return;
    }
    try {
      replaced.node.parentNode.replaceChild(replaced.fragment, replaced.node);
    } catch (_) {
      /* 页面结构已变化 */
    }
    closeSelectionCard();
  }

  function finishSelectionTranslation(translation, requestId) {
    if (requestId !== selectionState.requestId) return;

    const text = selectionState.text;
    let replaced = null;
    if (selectionState.mode === 'replace' && translation !== text) {
      replaced = replaceSelectionContents(selectionState.range, translation);
    }

    selectionState.replaced = replaced;
    if (replaced) {
      selectionState.range = null;
      selectionState.anchorNode = replaced.node;
      selectionState.lastRect = null;
      try {
        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
      } catch (_) {
        /* ignore */
      }
    }

    setSelectionText(translation, !!replaced);
  }

  async function requestSelectionTranslation(requestId) {
    let prefs = { mode: state.mode, targetLang: state.lang || '简体中文' };
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SELECTION_PREFS' });
      if (response && response.ok) {
        prefs = {
          mode: response.mode === 'replace' ? 'replace' : 'bilingual',
          targetLang: response.targetLang || prefs.targetLang
        };
      }
    } catch (_) {
      /* 使用默认值 */
    }
    if (requestId !== selectionState.requestId) return;

    selectionState.mode = prefs.mode;
    selectionState.lang = prefs.targetLang;

    const cacheKey = `${selectionState.lang}|${selectionState.text}`;
    const cached = selectionCache.get(cacheKey);
    if (cached) {
      finishSelectionTranslation(cached, requestId);
      return;
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_SEGMENTS',
        segments: [selectionState.text],
        targetLang: selectionState.lang
      });
    } catch (_) {
      if (requestId === selectionState.requestId) {
        setSelectionError('扩展后台无响应，请重新加载扩展');
      }
      return;
    }

    if (requestId !== selectionState.requestId) return;

    if (!response || !response.ok) {
      setSelectionError(response?.error || '翻译失败');
      return;
    }

    const translation = String(response.translations?.[0] || '').trim();
    if (!translation) {
      setSelectionError('AI 没有返回译文');
      return;
    }

    selectionCache.set(cacheKey, translation);
    if (selectionCache.size > 100) {
      const oldest = selectionCache.keys().next().value;
      selectionCache.delete(oldest);
    }

    finishSelectionTranslation(translation, requestId);
  }

  function translateSelection() {
    const info = selectionState.info;
    if (!info) return;

    hideSelectionButton();
    selectionState.range = info.range.cloneRange();
    selectionState.anchorNode = null;
    selectionState.replaced = null;
    selectionState.text = info.text;
    selectionState.lastRect = info.rect;
    selectionState.requestId += 1;

    ensureSelectionCardOpen();
    setSelectionLoading();
    requestSelectionTranslation(selectionState.requestId);
  }

  function retrySelectionTranslation() {
    if (!selectionState.text || selectionState.loading) return;
    hideSelectionButton();
    selectionState.requestId += 1;
    setSelectionLoading();
    requestSelectionTranslation(selectionState.requestId);
  }

  document.addEventListener('selectionchange', scheduleSelectionCheck);
  document.addEventListener('mouseup', (event) => {
    if (!eventInSelectionUi(event)) scheduleSelectionCheck();
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') return;
    scheduleSelectionCheck();
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (eventInSelectionUi(event)) return;
      hideSelectionButton();
      if (selectionState.cardOpen) closeSelectionCard();
    },
    true
  );
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSelectionButton();
      closeSelectionCard();
    }
  });
  window.addEventListener('scroll', scheduleSelectionReposition, { passive: true, capture: true });
  window.addEventListener('resize', scheduleSelectionReposition);

  /* ------------------------------ 消息监听 ------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'AI_PING':
      case 'AI_GET_STATE':
        sendResponse({ ok: true, state: getState() });
        return;
      case 'AI_TRANSLATE_PAGE':
        translatePage(msg.mode, msg.targetLang);
        sendResponse({ ok: true, state: getState() });
        return;
      case 'AI_TRANSLATION_DELTA':
        applyDelta(msg);
        return;
      case 'AI_SET_MODE':
        sendResponse({ ok: true, state: setMode(msg.mode) });
        return;
      case 'AI_RESTORE_PAGE':
        sendResponse({ ok: true, state: restorePage(true) });
        return;
      case 'AI_STOP':
        state.cancelled = true;
        hideStatus();
        sendResponse({ ok: true });
        return;
      default:
        return;
    }
  });
})();
