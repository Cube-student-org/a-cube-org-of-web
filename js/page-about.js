/**
 * 关于我们
 *
 * 叙述性文案（谁、什么状态）来自 content.js，
 * 结构化列表（机构、核心特征）也来自 content.js——
 * 这样运营委员会改组织信息只需要动一个文件，不必在 7 个 HTML 里找。
 */

/** 把段落数组渲染成 <p> 序列 */
function renderParagraphs(sel, paragraphs) {
  var host = typeof sel === 'string' ? $(sel) : sel;
  if (!host) return;
  host.innerHTML = (paragraphs || []).map(function (t) {
    return '<p>' + escHtml(t) + '</p>';
  }).join('');
}

document.addEventListener('DOMContentLoaded', function () {
  renderParagraphs('#intro', ORG.intro);
  renderParagraphs('#status-detail', STATUS_DETAIL.body);

  // 标题也跟随 content.js，避免改了内容文件但页面标题还是旧说法
  setText('#status-heading', STATUS_DETAIL.heading);
  setText('#hash-heading', CHARTER.hashNote.heading);

  renderParagraphs('#hash-note', CHARTER.hashNote.body);
  renderOrgChart('#org-chart', { compact: false });
  renderPrinciples('#principles-about');

  // 从首页跳过来带锚点时要能定位（浏览器自身处理，这里只是确保锚点元素存在）
  if (location.hash) {
    var target = document.querySelector(location.hash);
    if (target) target.scrollIntoView();
  }
});
