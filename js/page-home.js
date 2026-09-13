/**
 * 首页
 *
 * 首页承担的唯一任务是：让第一次来的人在三屏之内搞清楚「这个组织是谁」。
 * 因此上面的文案全部是静态 HTML（不依赖 JS 就能读），
 * JS 只负责两件事：把 content.js 里的数字同步进来、把赛事数据取回来。
 */

/** 首页的几个数字改为从 content.js 读取，避免和内容文件冲突 */
function syncHomeFacts() {
  var arts = CHARTER.meta.articles;
  var chaps = CHARTER.meta.chapters;
  var insts = ORG_CHART.core.length + ORG_CHART.functions.length;

  setText('#stat-articles', arts);
  setText('#stat-chapters', chaps);
  setText('#stat-articles-2', arts);
  setText('#stat-chapters-2', chaps);
  setText('#stat-institutions', insts);

  // 组织名与定位也一并同步，改 content.js 后无需再改 HTML
  setText('#foot-name', ORG.name);
}

/**
 * 最近赛事。
 *
 * ⚠️ 为什么不直接取"总数"：云函数的数据代理不转发客户端的 Prefer 头，
 *    拿不到 PostgREST 的 count=exact。所以这里只能把行取回来数长度，
 *    并显式设一个上界（赛事量级远小于此，不会被截断；若真被截断了也只会显示下界）。
 */
var HOME_EVENT_LIMIT = 200;
var HOME_EVENT_SHOW = 3;

async function loadRecentEvents() {
  renderLoading('#recent-events', '正在读取赛事记录…');

  var res = await db('competitions')
    .select('id,competition_number,name,competition_date,location,notes')
    .order('competition_number', { ascending: false })
    .limit(HOME_EVENT_LIMIT);

  if (res.error) {
    renderError('#recent-events', res.error.message);
    setText('#stat-competitions', '—');
    return;
  }

  var rows = res.data || [];
  setText('#stat-competitions', rows.length);

  if (!rows.length) {
    renderEmpty('#recent-events', '还没有记录任何赛事',
      '赛事记录由编辑员以上权限的成员在管理台录入，录入后这里会自动出现。');
    return;
  }

  var html = '<div class="list">' + rows.slice(0, HOME_EVENT_SHOW).map(function (c) {
    return '<a class="list-item" href="events.html#' + escHtml(c.id) + '">' +
      '<span class="list-no">#' + escHtml(c.competition_number == null ? '—' : c.competition_number) + '</span>' +
      '<span class="list-main">' +
        '<span class="list-title">' + escHtml(c.name || '未命名赛事') + '</span>' +
        '<span class="list-meta">' +
          '<span>' + escHtml(formatDate(c.competition_date)) + '</span>' +
          (c.location ? '<span>' + escHtml(c.location) + '</span>' : '') +
        '</span>' +
      '</span>' +
      '<span class="list-side faint">详情 →</span>' +
    '</a>';
  }).join('') + '</div>';

  setHtml('#recent-events', html);
}

document.addEventListener('DOMContentLoaded', function () {
  syncHomeFacts();
  renderPrinciples('#principles');
  renderOrgChart('#org-chart-home', { compact: true });
  renderStatusCard('#status-card-home');
  loadRecentEvents();
});
