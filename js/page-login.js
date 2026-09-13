/**
 * 登录页专属渲染
 *
 * 为什么不塞进 auth.js：auth.js 是全站共用的认证模块，
 * 每个页面都会加载它；而「协议面板」这个 DOM 只有登录页有。
 * 把页面专有的东西留在页面文件里，公共模块才不会越长越臃肿。
 *
 * 文案全部来自 content.js 的 MEMBER_TERMS——改条款只改那一个文件，
 * 这里的标题、简介、条目都会跟着变。
 */

function renderMemberTerms() {
  if (typeof MEMBER_TERMS === 'undefined') return;

  var labelText = document.getElementById('agree-label-text');
  if (labelText) labelText.textContent = '我已阅读并同意《' + MEMBER_TERMS.title + '》';

  var summary = document.getElementById('agree-summary');
  if (summary) summary.textContent = '展开读《' + MEMBER_TERMS.title + '》';

  var body = document.getElementById('member-terms-body');
  if (!body) return;

  // 条目之间靠 .agree-item + .agree-item 的顶边线分隔，
  // 所以不需要再套一层容器 div——多一层没有职责的 div 只会让审计报告多一条噪音。
  body.innerHTML =
    '<p class="muted">' + escHtml(MEMBER_TERMS.intro) + '</p>' +
    (MEMBER_TERMS.items || []).map(function (it) {
      return '<div class="agree-item">' +
        '<h3 class="agree-item-h">' + escHtml(it.h) + '</h3>' +
        '<p class="agree-item-p">' + escHtml(it.p) + '</p>' +
      '</div>';
    }).join('') +
    '<p class="faint mt-4">本须知的版本号为 ' + escHtml(String(MEMBER_TERMS.version)) +
      '。内容更新后版本号会提升，届时会重新征求你的同意。</p>';
}

document.addEventListener('DOMContentLoaded', renderMemberTerms);
