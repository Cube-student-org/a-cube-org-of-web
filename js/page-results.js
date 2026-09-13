/**
 * 赛事成绩（公开查询）
 *
 * 匿名可读——已通过审核的成绩对所有访客公开，不需要登录。
 * RLS 会在库层保证 pending / rejected 的成绩不会漏到这里；
 * 前端不需要、也不应该再自己做一遍"能不能看"的判断。
 *
 * ⚠️ 与 api.js 顶部注释同一件事：数据代理不支持分页与精确总数，
 *    所以所有查询都显式设上界。本页会把"是否撞到上界"作为提示暴露出来，
 *    而不是让用户以为看到的是全部。
 */

var RES_LIMIT_CE = 1000;
var RES_LIMIT_ATTEMPTS = 5000;
var RECENT_SHOW = 20;

var resState = {
  competitions: [],
  ces: [],
  attempts: [],
  competitionId: '',
  ceId: '',
};

/* ---------------- 成绩计算 ---------------- */

/**
 * 有效用时（秒）。+2 罚时加 2 秒；DNF / DNS / 无值返回 null。
 * 这是 WCA 口径下"这一次算多少秒"的标准算法。
 */
function effectiveSeconds(a) {
  if (!a || a.is_dnf || a.is_dns) return null;
  if (a.solve_time == null) return null;
  var t = Number(a.solve_time);
  if (isNaN(t)) return null;
  return t + (a.is_plus_two ? 2 : 0);
}

/** 一次成绩的判定标签 */
function attemptTags(a) {
  var tags = [];
  if (a.is_dnf) tags.push('<span class="tag tag-neutral">DNF</span>');
  if (a.is_dns) tags.push('<span class="tag tag-neutral">DNS</span>');
  if (a.is_plus_two) tags.push('<span class="tag tag-warn">+2</span>');
  return tags.length ? tags.join(' ') : '<span class="faint">有效</span>';
}

function cubeTypeLabel(t) {
  if (t === 'smart') return '智能魔方';
  if (t === 'non_smart') return '普通魔方';
  return t || '—';
}

/** 把明细行按选手聚合成排行（按最好单次升序） */
function buildRanking(attempts) {
  var byParticipant = {};
  attempts.forEach(function (a) {
    var pid = a.participant_id || 'unknown';
    if (!byParticipant[pid]) {
      byParticipant[pid] = {
        pid: pid,
        name: (a.participants && a.participants.name) || '（选手信息缺失）',
        best: null,
        valid: 0,
        total: 0,
      };
    }
    var g = byParticipant[pid];
    g.total++;
    var sec = effectiveSeconds(a);
    if (sec != null) {
      g.valid++;
      if (g.best == null || sec < g.best) g.best = sec;
    }
  });

  return Object.keys(byParticipant).map(function (k) { return byParticipant[k]; })
    .sort(function (x, y) {
      // 有成绩的排在没成绩的前面；都有则按最好成绩升序
      if (x.best == null && y.best == null) return 0;
      if (x.best == null) return 1;
      if (y.best == null) return -1;
      return x.best - y.best;
    });
}

/* ---------------- 渲染 ---------------- */

function rankingTable(rows) {
  if (!rows.length) return '';
  return '<div class="table-wrap"><table class="table">' +
    '<caption>选手排行（按最好单次升序）</caption>' +
    '<thead><tr>' +
      '<th scope="col" class="num">名次</th>' +
      '<th scope="col">选手</th>' +
      '<th scope="col" class="num">最好单次</th>' +
      '<th scope="col" class="num">有效次数</th>' +
      '<th scope="col" class="num">提交次数</th>' +
    '</tr></thead><tbody>' +
    rows.map(function (r, i) {
      return '<tr>' +
        '<td class="num' + (i === 0 && r.best != null ? ' rank-1' : '') + '">' +
          (r.best == null ? '—' : (i + 1)) + '</td>' +
        '<td>' + escHtml(r.name) + '</td>' +
        '<td class="num' + (i === 0 && r.best != null ? ' rank-1' : '') + '">' +
          escHtml(formatSeconds(r.best)) + '</td>' +
        '<td class="num">' + r.valid + '</td>' +
        '<td class="num faint">' + r.total + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

function detailsTable(attempts, caption) {
  if (!attempts.length) return '';
  return '<div class="table-wrap mt-5"><table class="table">' +
    '<caption>' + escHtml(caption) + '</caption>' +
    '<thead><tr>' +
      '<th scope="col">选手</th>' +
      '<th scope="col">第几次</th>' +
      '<th scope="col" class="num">成绩</th>' +
      '<th scope="col">判定</th>' +
      '<th scope="col">魔方</th>' +
      '<th scope="col">录像</th>' +
    '</tr></thead><tbody>' +
    attempts.map(function (a) {
      return '<tr>' +
        '<td>' + escHtml((a.participants && a.participants.name) || '—') + '</td>' +
        '<td class="faint">' + escHtml(a.attempt_number == null ? '—' : a.attempt_number) + '</td>' +
        '<td class="num">' + escHtml(formatAttemptTime(a)) + '</td>' +
        '<td>' + attemptTags(a) + '</td>' +
        '<td class="faint">' + escHtml(cubeTypeLabel(a.cube_type)) + '</td>' +
        '<td>' + (a.video_url
          ? '<a href="' + escHtml(a.video_url) + '" target="_blank" rel="noopener noreferrer">查看 ↗</a>'
          : '<span class="faint">—</span>') + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

/* ---------------- 视图切换 ---------------- */

function attemptsForCE(ceId) {
  return resState.attempts.filter(function (a) { return a.competition_event_id === ceId; });
}

function attemptsForCompetition(competitionId) {
  var ceIds = resState.ces
    .filter(function (ce) { return ce.competition_id === competitionId; })
    .map(function (ce) { return ce.id; });
  var set = {};
  ceIds.forEach(function (id) { set[id] = true; });
  return resState.attempts.filter(function (a) { return set[a.competition_event_id]; });
}

function renderResults() {
  var body = $('#results-body');
  var head = $('#results-head');
  if (!body) return;

  var comp = resState.competitionId;
  var ce = resState.ceId;

  // 视图一：未选比赛 —— 最近通过审核的成绩
  if (!comp) {
    if (head) {
      setHtml('#results-head',
        '<h2 class="section-title">最近通过审核的成绩</h2>' +
        '<p class="section-desc">按提交时间倒序，显示最近 ' + RECENT_SHOW + ' 条。</p>');
    }
    if (!resState.attempts.length) {
      renderEmpty('#results-body', '还没有任何已通过审核的成绩',
        '成绩由编辑员以上权限的成员提交，经审核员通过后才会出现在这里。');
      return;
    }
    setHtml('#results-body',
      detailsTable(resState.attempts.slice(0, RECENT_SHOW), '最近 ' + RECENT_SHOW + ' 条成绩'));
    return;
  }

  // 视图二：选了比赛但没选项目
  if (!ce) {
    var compAttempts = attemptsForCompetition(comp);
    if (head) {
      setHtml('#results-head',
        '<h2 class="section-title">该场比赛的全部成绩</h2>' +
        '<p class="section-desc">共 ' + compAttempts.length + ' 条。' +
        '跨项目比较用时没有意义，选择具体项目可以看到选手排行。</p>');
    }
    if (!compAttempts.length) {
      renderEmpty('#results-body', '这场比赛还没有已通过审核的成绩', '可以换一场比赛看看。');
      return;
    }
    setHtml('#results-body', detailsTable(compAttempts.slice(0, 500), '成绩明细'));
    return;
  }

  // 视图三：比赛 + 项目 —— 排行 + 明细
  var rows = attemptsForCE(ce);
  var ceMeta = resState.ces.filter(function (x) { return x.id === ce; })[0] || {};
  var evName = (ceMeta.events && ceMeta.events.event_name) || '该项目';

  if (head) {
    setHtml('#results-head',
      '<h2 class="section-title">' + escHtml(evName) + ' · 选手排行</h2>' +
      '<p class="section-desc">共 ' + rows.length + ' 条已通过审核的成绩。</p>');
  }

  if (!rows.length) {
    renderEmpty('#results-body', '该项目还没有已通过审核的成绩', '换一个项目看看。');
    return;
  }

  setHtml('#results-body',
    rankingTable(buildRanking(rows)) +
    detailsTable(rows, '成绩明细（共 ' + rows.length + ' 条）'));
}

/* ---------------- 筛选控件 ---------------- */

function fillCompetitionSelect() {
  var sel = $('#filter-competition');
  if (!sel) return;
  sel.innerHTML = '<option value="">全部比赛</option>' +
    resState.competitions.map(function (c) {
      return '<option value="' + escHtml(c.id) + '">' +
        '#' + escHtml(c.competition_number == null ? '—' : c.competition_number) +
        '　' + escHtml(c.name || '未命名赛事') +
        (c.competition_date ? '（' + escHtml(formatDate(c.competition_date)) + '）' : '') +
      '</option>';
    }).join('');
}

function fillEventSelect() {
  var sel = $('#filter-event');
  if (!sel) return;
  var comp = resState.competitionId;

  if (!comp) {
    sel.disabled = true;
    sel.innerHTML = '<option value="">请先选择比赛</option>';
    return;
  }

  var ces = resState.ces.filter(function (ce) { return ce.competition_id === comp; });
  if (!ces.length) {
    sel.disabled = true;
    sel.innerHTML = '<option value="">该场比赛暂无项目</option>';
    return;
  }

  sel.disabled = false;
  sel.innerHTML = '<option value="">全部项目</option>' +
    ces.sort(function (x, y) {
      return (x.event_number == null ? 0 : x.event_number) - (y.event_number == null ? 0 : y.event_number);
    }).map(function (ce) {
      var ev = ce.events || {};
      return '<option value="' + escHtml(ce.id) + '">' +
        escHtml(ce.event_number == null ? '' : '#' + ce.event_number + '　') +
        escHtml(ev.event_name || '未命名项目') +
      '</option>';
    }).join('');
}

function bindFilters() {
  var compSel = $('#filter-competition');
  var evSel = $('#filter-event');
  var reset = $('#filter-reset');

  if (compSel) {
    compSel.addEventListener('change', function () {
      resState.competitionId = compSel.value;
      resState.ceId = '';       // 换比赛后项目选择失效
      fillEventSelect();
      renderResults();
    });
  }
  if (evSel) {
    evSel.addEventListener('change', function () {
      resState.ceId = evSel.value;
      renderResults();
    });
  }
  if (reset) {
    reset.addEventListener('click', function () {
      resState.competitionId = '';
      resState.ceId = '';
      if (compSel) compSel.value = '';
      fillEventSelect();
      renderResults();
    });
  }
}

/* ---------------- 入口 ---------------- */

document.addEventListener('DOMContentLoaded', async function () {
  renderLoading('#results-body', '正在读取成绩数据…');

  var resC = await db('competitions')
    .select('id,competition_number,name,competition_date')
    .order('competition_number', { ascending: false })
    .limit(200);
  if (resC.error) { renderError('#results-body', resC.error.message); return; }
  resState.competitions = resC.data || [];

  var resCE = await db('competition_events')
    .select('id,competition_id,event_number,events(event_name,event_code)')
    .limit(RES_LIMIT_CE);
  resState.ces = resCE.error ? [] : (resCE.data || []);

  var resA = await db('attempts')
    .select('id,competition_event_id,participant_id,attempt_number,solve_time,' +
            'is_dnf,is_plus_two,is_dns,cube_type,video_url,created_at,participants(name)')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(RES_LIMIT_ATTEMPTS);
  if (resA.error) { renderError('#results-body', resA.error.message); return; }
  resState.attempts = resA.data || [];

  fillCompetitionSelect();
  fillEventSelect();
  bindFilters();
  renderResults();

  // 从赛事页跳过来时可带 ?competition=<id> 直接筛到那场比赛
  var pre = qsParam('competition');
  if (pre) {
    var sel = $('#filter-competition');
    if (sel) {
      sel.value = pre;
      if (sel.value === pre) {
        resState.competitionId = pre;
        fillEventSelect();
        renderResults();
      }
    }
  }

  if (resA.data && resA.data.length >= RES_LIMIT_ATTEMPTS) {
    showAlert('成绩数量已达单次读取上限（' + RES_LIMIT_ATTEMPTS + ' 条），显示可能不完整', 'warn');
  }
});
