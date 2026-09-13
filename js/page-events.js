/**
 * 活动与赛事
 *
 * 三次查询拼出完整视图（都可以匿名读，RLS 会挡住不该看的数据）：
 *   1. competitions        比赛
 *   2. competition_events  比赛×项目 关联（顺带把 events 的项目名嵌出来）
 *   3. attempts(approved)  已通过的成绩，只用来数每个项目有多少条
 *
 * ⚠️ 上界说明：数据代理不支持分页与精确总数（见 api.js 顶部注释），
 *    所以这里的每个查询都显式设了上界。中學社团的数据量远小于上界，
 *    但如果哪天真的撞到上界，项目数会显示不完整——所以下面会检查是否撞界并提示。
 */

var EV_LIMIT_COMPETITIONS = 200;
var EV_LIMIT_CE = 1000;
var EV_LIMIT_ATTEMPTS = 5000;

/** 该回前端的字段（少取字段能显著减小响应体） */
var EV_FIELDS_COMPETITION = 'id,competition_number,name,competition_date,location,notes';

async function loadEventsPage() {
  renderLoading('#events-list', '正在读取赛事记录…');

  var resC = await db('competitions').select(EV_FIELDS_COMPETITION)
    .order('competition_number', { ascending: false }).limit(EV_LIMIT_COMPETITIONS);
  if (resC.error) {
    renderError('#events-list', resC.error.message);
    setText('#events-summary', '读取失败');
    return;
  }

  var competitions = resC.data || [];

  if (!competitions.length) {
    renderEmpty('#events-list', '还没有记录任何赛事',
      '赛事记录由编辑员以上权限的成员在管理台录入。录入并审核通过后，这里与成绩页都会自动出现。');
    setText('#events-summary', '暂无记录');
    return;
  }

  // 两次辅助查询：失败了也不该让整页挂掉，因此各自容忍错误
  var resCE = await db('competition_events')
    .select('id,competition_id,event_number,events(event_name,event_code)')
    .limit(EV_LIMIT_CE);
  var resA = await db('attempts')
    .select('competition_event_id')
    .eq('status', 'approved')
    .limit(EV_LIMIT_ATTEMPTS);

  var ceRows = resCE.error ? [] : (resCE.data || []);
  var attemptRows = resA.error ? [] : (resA.data || []);

  // 项目数 / 成绩数 按比赛聚合
  var ceByCompetition = {};
  var attemptsByCE = {};
  attemptRows.forEach(function (a) {
    if (!a.competition_event_id) return;
    attemptsByCE[a.competition_event_id] = (attemptsByCE[a.competition_event_id] || 0) + 1;
  });
  ceRows.forEach(function (ce) {
    if (!ce.competition_id) return;
    (ceByCompetition[ce.competition_id] || (ceByCompetition[ce.competition_id] = [])).push(ce);
  });

  var totalEvents = ceRows.length;
  setText('#events-summary',
    '共 ' + competitions.length + ' 场比赛、' + totalEvents + ' 个参赛项目。' +
    (resCE.error ? '（项目数据读取失败，仅显示比赛）' : ''));

  var html = competitions.map(function (c) {
    var ces = ceByCompetition[c.id] || [];
    var attemptCount = ces.reduce(function (sum, ce) {
      return sum + (attemptsByCE[ce.id] || 0);
    }, 0);

    var inner;
    if (!ces.length) {
      inner = '<p class="faint">这场比赛还没有录入项目。</p>';
    } else {
      inner = '<div class="table-wrap"><table class="table">' +
        '<caption>本场比赛的参赛项目</caption>' +
        '<thead><tr>' +
          '<th scope="col">项目编号</th><th scope="col">项目</th>' +
          '<th scope="col">项目代码</th><th scope="col" class="num">已通过成绩</th>' +
        '</tr></thead><tbody>' +
        ces.sort(function (x, y) {
          return (x.event_number == null ? 0 : x.event_number) - (y.event_number == null ? 0 : y.event_number);
        }).map(function (ce) {
          var ev = ce.events || {};
          return '<tr>' +
            '<td class="num">' + escHtml(ce.event_number == null ? '—' : ce.event_number) + '</td>' +
            '<td>' + escHtml(ev.event_name || '未命名项目') + '</td>' +
            '<td class="faint">' + escHtml(ev.event_code || '—') + '</td>' +
            '<td class="num">' + (attemptsByCE[ce.id] || 0) + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    return '<details class="disclosure" id="' + escHtml(c.id) + '" open>' +
      '<summary>' +
        '<span class="list-no">#' + escHtml(c.competition_number == null ? '—' : c.competition_number) + '</span>' +
        '<span>' + escHtml(c.name || '未命名赛事') + '</span>' +
        '<span class="faint" style="margin-left:auto">' +
          escHtml(formatDate(c.competition_date)) +
          (c.location ? ' · ' + escHtml(c.location) : '') +
          ' · ' + ces.length + ' 个项目 / ' + attemptCount + ' 条成绩' +
        '</span>' +
      '</summary>' +
      '<div class="disclosure-body">' +
        (c.notes ? '<p class="muted mb-4">' + escHtml(c.notes) + '</p>' : '') +
        inner +
      '</div>' +
    '</details>';
  }).join('');

  setHtml('#events-list', html);

  // 撞到上界时主动说明，而不是悄悄少显示
  if (resCE.data && resCE.data.length >= EV_LIMIT_CE) {
    showAlert('项目数据已达单次读取上限（' + EV_LIMIT_CE + ' 条），显示可能不完整', 'warn');
  }
}

document.addEventListener('DOMContentLoaded', function () {
  renderStatusCard('#status-card-events');
  loadEventsPage();
});
