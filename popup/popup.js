/* AI 网页翻译 - 弹窗 */

const DEFAULTS = {
  provider: 'openai',
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  mode: 'bilingual',
  thinking: 'none'
};

const PRESETS = {
  openai: { apiBase: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  anthropic: { apiBase: 'https://api.anthropic.com', model: 'claude-haiku-5-5' }
};

const TEXT_MAX = 5000;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let settings = { ...DEFAULTS };
let activeTab = 'page';
let activeTabId = null;
let supported = true;
let running = false;
let translated = false;
let saveTimer = null;
let initialized = false;
let toastTimer = null;
let lastLanguage = settings.targetLang;

const textCache = new Map();

document.addEventListener('DOMContentLoaded', init);

async function init() {
  if (initialized) return;
  initialized = true;

  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  lastLanguage = settings.targetLang;

  renderSettings();
  bindEvents();
  setActiveTab('page');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    supported = /^(https?|file):/i.test(tab?.url || '');

    if (!supported) {
      $('#pageHint').textContent = '此页面不支持整页翻译';
      $('#translateBtn').disabled = true;
      $('#restoreBtn').disabled = true;
      setBadge('仅文本');
      setActiveTab('text');
      return;
    }

    $('#pageHint').textContent = tab?.title ? shorten(tab.title, 30) : '当前网页';
    await refreshState();
  } catch (_) {
    $('#pageHint').textContent = '无法读取当前页面';
    setActiveTab('text');
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function renderSettings() {
  $('#provider').value = settings.provider;
  $('#apiBase').value = settings.apiBase;
  $('#model').value = settings.model;
  $('#thinking').value = settings.thinking || 'none';
  $('#apiKey').value = settings.apiKey;

  const lang = settings.targetLang || '简体中文';
  ensureTargetOption(lang);
  $('#targetLang').value = lang;

  for (const button of $$('[data-mode]')) {
    button.classList.toggle('active', button.dataset.mode === settings.mode);
  }
  renderModeHint();
  renderTargetHints();
}

/** 兼容旧版本里手动输入的自定义语言，不在列表里时补一个选项 */
function ensureTargetOption(lang) {
  const select = $('#targetLang');
  if (!lang) return;
  const exists = Array.from(select.options).some((option) => option.value === lang);
  if (exists) return;
  const option = document.createElement('option');
  option.value = lang;
  option.textContent = lang;
  select.appendChild(option);
}

function renderModeHint() {
  $('#modeHint').textContent =
    settings.mode === 'replace' ? '直接用译文替换原文' : '原文下方显示译文';
}

function renderTargetHints() {
  const lang = ($('#targetLang').value || '').trim() || '简体中文';
  $('#textTargetHint').textContent = `翻译为 ${lang}`;
}

function setActiveTab(tab) {
  activeTab = tab === 'text' ? 'text' : 'page';

  for (const button of $$('[data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === activeTab);
    button.setAttribute('aria-selected', button.dataset.tab === activeTab ? 'true' : 'false');
  }

  $('#panel-page').hidden = activeTab !== 'page';
  $('#panel-text').hidden = activeTab !== 'text';

  if (activeTab === 'text') {
    setTimeout(() => $('#textInput').focus(), 30);
  }
}

function setBadge(text, variant = '') {
  const badge = $('#statusBadge');
  badge.textContent = text;
  badge.className = 'badge' + (variant ? ' ' + variant : '');
}

function renderState(state = {}) {
  running = !!state.running;
  translated = !!state.translated;

  const progress = state.progress || { done: 0, total: 0 };
  const wrap = $('#progressWrap');
  const bar = $('#progressBar');
  const text = $('#progressText');
  const translateBtn = $('#translateBtn');

  translateBtn.classList.toggle('stop', running);
  translateBtn.textContent = running ? '停止翻译' : translated ? '重新翻译' : '翻译此页';
  translateBtn.disabled = !supported;

  $('#restoreBtn').disabled = !translated && !running;

  if (running) {
    wrap.hidden = false;
    const total = progress.total || 0;
    const done = progress.done || 0;
    if (total > 0) {
      bar.style.width = Math.min(100, Math.round((done / total) * 100)) + '%';
      text.textContent = `翻译中 ${done}/${total}`;
    } else {
      bar.style.width = '12%';
      text.textContent = '准备翻译…';
    }
    setBadge('翻译中', 'busy');
  } else {
    wrap.hidden = true;
    bar.style.width = '0%';
    if (translated) setBadge('已翻译', 'on');
    else setBadge(supported ? '就绪' : '仅文本');
  }
}

function shorten(text, max) {
  const value = String(text).trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

/* ------------------------------ 存储 ------------------------------ */

function collectSettings() {
  settings.provider = $('#provider').value;
  settings.apiBase = $('#apiBase').value.trim();
  settings.model = $('#model').value.trim();
  settings.apiKey = $('#apiKey').value.trim();
  settings.targetLang = $('#targetLang').value.trim() || '简体中文';
  settings.thinking = $('#thinking').value;
  return settings;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
}

async function saveSettings() {
  clearTimeout(saveTimer);
  try {
    await chrome.storage.local.set({ settings: { ...collectSettings() } });
  } catch (_) {
    /* ignore */
  }
}

function notifyLanguageChanged() {
  const lang = $('#targetLang').value.trim() || '简体中文';
  renderTargetHints();
  if (lang === lastLanguage) return;
  lastLanguage = lang;
  if (translated && !running) {
    toast(`目标语言已切换为「${lang}」，点「重新翻译」应用到本页`);
  }
}

/* ------------------------------ 文本翻译 ------------------------------ */

function showTextOutput(text, isError = false, loading = false) {
  const wrap = $('#textOutputWrap');
  const output = $('#textOutput');
  const copy = $('#copyBtn');

  wrap.hidden = false;
  output.className = 'text-output-body' + (isError ? ' error' : '');
  output.textContent = text;
  copy.hidden = isError || loading;
  copy.textContent = '复制';
  output.scrollTop = 0;
}

function clearTextTranslation() {
  $('#textInput').value = '';
  $('#textOutputWrap').hidden = true;
  $('#textOutput').textContent = '';
  $('#copyBtn').hidden = true;
  $('#textInput').focus();
}

async function translateText() {
  const button = $('#textTranslateBtn');
  if (button.disabled) return;

  const input = $('#textInput');
  const text = input.value.trim();
  if (!text) {
    toast('请输入要翻译的文字');
    input.focus();
    return;
  }
  if (text.length > TEXT_MAX) {
    toast(`最多翻译 ${TEXT_MAX} 个字符`);
    return;
  }

  await saveSettings();
  const lang = settings.targetLang;
  const cacheKey = `${lang}|${text}`;
  const cached = textCache.get(cacheKey);
  if (cached) {
    showTextOutput(cached);
    return;
  }

  button.disabled = true;
  button.textContent = '翻译中…';
  showTextOutput('正在翻译…', false, true);

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_SEGMENTS',
      segments: [text],
      targetLang: lang
    });
  } catch (err) {
    res = { ok: false, error: err?.message || '翻译失败' };
  }

  button.disabled = false;
  button.textContent = '翻译';

  if (!res?.ok) {
    showTextOutput(res?.error || '翻译失败', true);
    return;
  }

  const translation = String(res.translations?.[0] || '').trim();
  if (!translation) {
    showTextOutput('AI 没有返回译文', true);
    return;
  }

  textCache.set(cacheKey, translation);
  if (textCache.size > 50) {
    textCache.delete(textCache.keys().next().value);
  }
  showTextOutput(translation);
}

async function copyTextOutput() {
  const text = $('#textOutput').textContent;
  if (!text) return;

  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    /* 回退方案 */
  }

  if (!ok) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand('copy');
      area.remove();
    } catch (_) {
      ok = false;
    }
  }

  const button = $('#copyBtn');
  if (!ok) {
    toast('复制失败，请手动选择译文');
    return;
  }
  button.textContent = '已复制';
  setTimeout(() => {
    button.textContent = '复制';
  }, 1200);
}

/* ------------------------------ 页面翻译 ------------------------------ */

async function sendToTab(type, payload = {}) {
  if (activeTabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(activeTabId, { type, ...payload });
  } catch (_) {
    return null;
  }
}

async function refreshState() {
  if (!supported) return;
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'GET_PAGE_STATE', tabId: activeTabId });
  } catch (_) {
    return;
  }
  if (!res?.ok) return;
  renderState(res.state || {});
}

/* ------------------------------ 事件 ------------------------------ */

function bindEvents() {
  for (const button of $$('[data-tab]')) {
    button.addEventListener('click', () => setActiveTab(button.dataset.tab));
  }

  for (const button of $$('[data-mode]')) {
    button.addEventListener('click', () => switchMode(button.dataset.mode));
  }

  $('#provider').addEventListener('change', () => {
    settings.provider = $('#provider').value;
    const preset = PRESETS[settings.provider];
    if (preset) {
      $('#apiBase').value = preset.apiBase;
      $('#model').value = preset.model;
    }
    saveSettings();
  });

  for (const input of ['#apiBase', '#model', '#apiKey', '#thinking']) {
    $(input).addEventListener('input', scheduleSave);
    $(input).addEventListener('change', saveSettings);
  }

  $('#targetLang').addEventListener('input', () => {
    renderTargetHints();
    scheduleSave();
  });

  $('#targetLang').addEventListener('change', async () => {
    notifyLanguageChanged();
    await saveSettings();
  });

  $('#swapLang').addEventListener('click', async () => {
    const current = $('#targetLang').value.trim();
    const next = /中/.test(current) ? 'English' : '简体中文';
    $('#targetLang').value = next;
    renderTargetHints();
    await saveSettings();
    if (translated && !running) {
      toast(`目标语言已切换为「${next}」，点「重新翻译」应用到本页`);
    }
    lastLanguage = next;
  });

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('#translateBtn').addEventListener('click', () => {
    if (running) stopTranslation();
    else startTranslation();
  });

  $('#restoreBtn').addEventListener('click', restorePage);

  $('#testBtn').addEventListener('click', testConnection);

  $('#textTranslateBtn').addEventListener('click', translateText);
  $('#textClearBtn').addEventListener('click', clearTextTranslation);
  $('#copyBtn').addEventListener('click', copyTextOutput);

  $('#textInput').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      translateText();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'TRANSLATION_PROGRESS') return;
    if (sender?.tab?.id != null && activeTabId != null && sender.tab.id !== activeTabId) return;

    if (msg.state === 'error') {
      renderState(msg);
      toast(msg.message || '翻译失败');
    } else {
      renderState(msg);
    }
  });
}

async function switchMode(mode) {
  if (!mode || settings.mode === mode) return;
  settings.mode = mode;
  for (const button of $$('[data-mode]')) {
    button.classList.toggle('active', button.dataset.mode === mode);
  }
  renderModeHint();
  await saveSettings();

  if (running || translated) {
    const res = await sendToTab('AI_SET_MODE', { mode });
    if (res?.state) renderState(res.state);
  }
}

async function startTranslation() {
  if (!supported) return;
  await saveSettings();
  running = true;
  renderState({ running: true, translated, progress: { done: 0, total: 0 } });

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'START_PAGE_TRANSLATION',
      tabId: activeTabId,
      mode: settings.mode,
      targetLang: settings.targetLang
    });
  } catch (err) {
    res = { ok: false, error: err?.message || '启动失败' };
  }

  if (!res?.ok) {
    running = false;
    renderState({ running: false, translated });
    toast(res?.error || '启动翻译失败');
    return;
  }

  await refreshState();
}

async function stopTranslation() {
  await sendToTab('AI_STOP');
  running = false;
  renderState({ running: false, translated });
}

async function restorePage() {
  const res = await sendToTab('AI_RESTORE_PAGE');
  if (res?.state) renderState(res.state);
  else {
    running = false;
    translated = false;
    renderState({});
  }
}

async function testConnection() {
  await saveSettings();
  const result = $('#testResult');
  result.classList.remove('err');
  result.textContent = '测试中…';

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
  } catch (err) {
    res = { ok: false, error: err?.message || '连接失败' };
  }

  if (res?.ok) {
    result.textContent = `连接成功 · ${res.ms}ms · ${shorten(res.result || '', 18)}`;
  } else {
    result.classList.add('err');
    result.textContent = shorten(res?.error || '连接失败', 60);
  }
}
