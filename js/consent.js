/**
 * 首访「访问须知」门禁
 *
 * 为什么分成两阶段（这不是绕远路，是为了不留闪烁）：
 *   阶段一 —— 在 <head> 里同步执行，只做「判断 + 打标记」。
 *       此刻 body 还没解析，没有 DOM 可以挂载，但打标记必须早，
 *       早到浏览器还没开始画第一帧。放在 <link rel="stylesheet"> 之后，
 *       脚本会等样式表就绪才执行，标记一定赶在第一帧之前生效。
 *   阶段二 —— 在 DOMContentLoaded 时注入面板。文案从 content.js 的 CONSENT 读，
 *       保持「文案只在一个地方维护」，不让门禁自己藏一份。
 *
 * 若合成一个阶段（等 DOMContentLoaded 才打标记），页面内容会先闪一下再被盖住，
 * 那一下闪烁会让人以为网站被劫持了。
 *
 * 存储：localStorage['wb_consent'] = {"v":条款版本号,"at":同意时间戳}
 *   localStorage 不可用时（隐私模式、被策略禁用）按「未同意」处理，每次访问都问一遍。
 *   宁可多问一次，也不要假装用户同意过。
 *
 * 退出路径：不同意不是死路——面板会就地给出章程仓库地址。
 * 按 Esc 不关闭：这道门是有意设的，不提供「按一下就绕过」。
 */

var CONSENT_KEY = 'wb_consent';

/* ---------------- 读写 ---------------- */

/** 读已存同意记录；读不到 / 解析失败 / localStorage 不可用，一律返回 null */
function consentRead() {
  try {
    var raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    var obj = JSON.parse(raw);
    return (obj && typeof obj.v === 'number') ? obj : null;
  } catch (e) {
    return null;
  }
}

/** 写同意记录；返回是否写入成功（失败也不影响本次进入） */
function consentWrite(v) {
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify({ v: v, at: Date.now() }));
    return true;
  } catch (e) {
    return false;
  }
}

/** 自足的转义：本文件可能在 ui.js 之前执行，不能依赖 escHtml() */
function consentEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------------- 阶段一：head 中同步打标记 ---------------- */

(function phaseOne() {
  // 只有「从未同意过」才能在这里判定——此刻 content.js 还没加载，
  // 拿不到当前条款版本号，所以版本比对留到阶段二。
  if (consentRead()) return;
  document.documentElement.setAttribute('data-consent-pending', '');
})();

/* ---------------- 阶段二：注入面板 ---------------- */

function consentUnmount() {
  document.documentElement.removeAttribute('data-consent-pending');
  var gate = document.getElementById('consent-gate');
  if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
}

function consentMount(C) {
  // 即使阶段一漏了标记（例如条款升级后重问），这里补上，保证内容不可见
  document.documentElement.setAttribute('data-consent-pending', '');

  var itemsHtml = (C.items || []).map(function (it) {
    return '<div class="consent-item">' +
      '<h3 class="consent-item-h">' + consentEsc(it.h) + '</h3>' +
      '<p class="consent-item-p">' + consentEsc(it.p) + '</p>' +
    '</div>';
  }).join('');

  var gate = document.createElement('div');
  gate.className = 'consent-gate';
  gate.id = 'consent-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-labelledby', 'consent-title');
  gate.innerHTML =
    '<div class="consent-panel">' +
      '<h2 class="consent-title" id="consent-title">' + consentEsc(C.title) + '</h2>' +
      '<p class="consent-intro">' + consentEsc(C.intro) + '</p>' +
      '<div class="consent-items">' + itemsHtml + '</div>' +
      '<div class="consent-actions">' +
        '<button class="btn btn-primary" type="button" id="consent-accept">' +
          consentEsc(C.acceptLabel) + '</button>' +
        '<button class="btn btn-ghost" type="button" id="consent-decline">' +
          consentEsc(C.declineLabel) + '</button>' +
      '</div>' +
      '<p class="consent-decline-note" id="consent-decline-note" hidden>' +
        consentEsc(C.declineNote) + ' ' +
        '<a href="' + consentEsc(C.declineHref) + '" target="_blank" rel="noopener noreferrer">' +
          '前往章程仓库 ↗</a>' +
      '</p>' +
    '</div>';

  document.body.appendChild(gate);

  var acceptBtn = document.getElementById('consent-accept');
  var declineBtn = document.getElementById('consent-decline');
  var declineNote = document.getElementById('consent-decline-note');

  // 焦点移进门禁：否则键盘用户会困在被 hidden 的页面上看不见焦点
  if (acceptBtn) {
    try { acceptBtn.focus(); } catch (e) { /* 某些环境 focus 会抛，忽略 */ }
  }

  if (acceptBtn) {
    acceptBtn.addEventListener('click', function () {
      consentWrite(C.version);
      consentUnmount();
    });
  }

  // 不同意：就地展开去处说明，而不是一点就把人甩走
  if (declineBtn) {
    declineBtn.addEventListener('click', function () {
      if (declineNote) declineNote.hidden = false;
      declineBtn.disabled = true;
    });
  }
}

/** 入口：是否需要征求同意（含条款版本比对） */
function consentCheck() {
  var C = (typeof CONSENT !== 'undefined') ? CONSENT : null;
  // 条款数据缺失时放行。门禁是为了告知，不是为了把网站锁死给访客看。
  if (!C || typeof C.version !== 'number') { consentUnmount(); return; }

  var have = consentRead();
  if (have && have.v === C.version) { consentUnmount(); return; }
  consentMount(C);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', consentCheck);
} else {
  consentCheck();
}
