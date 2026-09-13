/**
 * 界面辅助：转义 / 格式化 / 提示 / 异步按钮守卫 / 状态渲染
 *
 * 全站约定一：任何动态数据拼进 innerHTML 之前必须先过 escHtml()。
 *   选手名、比赛名是编辑员可写的，不转义就是存储型 XSS。
 *   用 textContent 的地方天然安全，问题只出在 innerHTML 拼接。
 *
 * 全站约定二：写操作按钮统一走 guard(this, fn)。
 *   防重复点击 + 加载中反馈 + 异常兜底。手滑连点两次这类问题在这一层解决。
 */

/* ---------------- 转义 ---------------- */

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------------- 选择器与设值 ---------------- */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}
/** 安全设文本（自动转义不了 innerHTML，但 textContent 无需转义） */
function setText(sel, text, root) {
  var el = typeof sel === 'string' ? $(sel, root) : sel;
  if (el) el.textContent = text == null ? '' : String(text);
}
/** 安全设 HTML：调用方负责已转义 */
function setHtml(sel, html, root) {
  var el = typeof sel === 'string' ? $(sel, root) : sel;
  if (el) el.innerHTML = html;
}
function show(el) {
  if (typeof el === 'string') el = $(el);
  if (el) el.hidden = false;
}
function hide(el) {
  if (typeof el === 'string') el = $(el);
  if (el) el.hidden = true;
}

/* ---------------- 格式化 ---------------- */

/** 成绩时间：DNS / DNF / 数值(+2) / — */
function formatAttemptTime(row) {
  if (!row) return '—';
  if (row.is_dns) return 'DNS';
  if (row.is_dnf) return 'DNF';
  if (row.solve_time == null) return '—';
  var t = Number(row.solve_time);
  var s = (Math.round(t * 1000) / 1000).toString();
  return s + (row.is_plus_two ? '+' : '');
}

/** 秒数格式化为 mm:ss.SS（超过 60 秒时） */
function formatSeconds(sec) {
  if (sec == null || isNaN(sec)) return '—';
  var n = Number(sec);
  if (n < 60) return (Math.round(n * 100) / 100).toFixed(2);
  var m = Math.floor(n / 60);
  var rest = n - m * 60;
  return m + ':' + (rest < 10 ? '0' : '') + (Math.round(rest * 100) / 100).toFixed(2);
}

/** '2026-09-13' → '2026年9月13日'；空值返回 fallback */
function formatDate(iso, fallback) {
  if (!iso) return fallback == null ? '日期未定' : fallback;
  var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  return m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
}

/** 数字加千分位 */
function formatNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN');
}

/* ---------------- 提示条（Toast） ---------------- */

var alertTimer = null;

/**
 * 顶部提示条。普通反馈用它；登录错误例外——那种情况就地显示在表单下方。
 * @param {string} message
 * @param {'info'|'success'|'error'|'warn'} [type]
 */
function showAlert(message, type) {
  var box = document.getElementById('alert-box');
  if (!box) return;
  box.className = 'alert alert-' + (type || 'info');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(alertTimer);
  alertTimer = setTimeout(function () { box.hidden = true; }, 4000);
}

document.addEventListener('click', function (e) {
  var box = document.getElementById('alert-box');
  if (box && e.target === box) box.hidden = true;
});

/* ---------------- 异步按钮守卫 ----------------
 * 用法：<button onclick="guard(this, doSomething)">
 * ------------------------------------------------ */

function setBusy(btn, on) {
  if (!btn) return;
  if (on) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn._idleLabel = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.textContent = '处理中…';
  } else {
    btn.dataset.busy = '0';
    btn.disabled = false;
    btn.classList.remove('is-busy');
    if (btn._idleLabel != null) btn.textContent = btn._idleLabel;
  }
}

/**
 * 异步按钮守卫。
 *
 * 把按钮本身作为第一个参数传给 fn —— 这一点对管理台的行内事件是必需的：
 *   <button onclick="guard(this, doApprove)">
 * guard 内部调 fn()，fn 拿不到 this（行内事件里的 this 不会穿透到嵌套函数），
 * 而按钮上往往挂着 data-id 这类「这一行是谁」的信息。所以由 guard 把按钮递过去。
 * 早先的调用方不接这个参数，多传一个实参对它们没有影响。
 *
 * @param {HTMLButtonElement} btn
 * @param {Function} fn 形如 async function (btn) { … }
 */
async function guard(btn, fn) {
  if (!btn) { if (fn) await fn(); return; }
  if (btn.dataset.busy === '1') return;   // 已在执行，忽略重复触发
  setBusy(btn, true);
  try {
    if (typeof fn === 'function') await fn(btn);
  } catch (err) {
    console.error(err);
    showAlert('操作失败：' + (err && err.message ? err.message : '未知错误'), 'error');
  } finally {
    setBusy(btn, false);
  }
}

/* ---------------- 加载 / 空 / 错误三态 ---------------- */
/* 每个异步区块都必须能表达这三种状态，否则用户会以为页面坏了。 */

function renderLoading(sel, text) {
  setHtml(sel, '<div class="state state-loading">' +
    '<span class="spinner" aria-hidden="true"></span>' +
    '<span>' + escHtml(text || '加载中…') + '</span></div>');
}

function renderEmpty(sel, text, hint) {
  setHtml(sel, '<div class="state state-empty">' +
    '<p class="state-title">' + escHtml(text || '暂无数据') + '</p>' +
    (hint ? '<p class="state-hint">' + escHtml(hint) + '</p>' : '') + '</div>');
}

function renderError(sel, text) {
  setHtml(sel, '<div class="state state-error" role="alert">' +
    '<p class="state-title">加载失败</p>' +
    '<p class="state-hint">' + escHtml(text || '请稍后重试') + '</p></div>');
}
