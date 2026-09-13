/**
 * 管理台 · 成绩录入与成绩审核（编辑员 / 审核员）
 *
 * 两个功能区放一个文件，因为它们围绕同一张表（attempts）的两端：
 * 一端往待审队列里放，一端从待审队列里取。写在一起，队列的状态机才是完整的：
 *
 *     /submit-attempt  编辑员、审核员 → pending        （管理员 → approved，直接生效）
 *     /review-attempt  审核员、管理员 → approved / rejected
 *
 * ⚠️ 这里所有「谁可以做什么」的判断都只是界面礼貌。真正的三条锁在服务端：
 *   ① **提交状态由服务端定**：前端传 status 也会被忽略（端点只从白名单里取字段），
 *      所以界面上绝不能出现「提交为已通过」这种选项——它不可能生效，只会骗人。
 *   ② **不能审核自己提交的**：/review-attempt 会查 submitted_by 比对，数据库还有
 *      触发器 trg_prevent_self_review 兜底。界面上对别人的成绩不给按钮，
 *      只是省掉一次必然失败的请求。
 *   ③ **并发审核用乐观锁**：PATCH 带 status=eq.pending，被别人先处理过就影响 0 行，
 *      服务端返回 409。界面必须把 409 当成「有人抢先了，刷新看看」而不是「出错了」。
 *
 * 另一件被界面说清楚的事：**驳回没有理由字段**。attempts 表没有存驳回理由的列，
 * 所以这里不做一个填了也不会被保存的输入框——那是更坏的做法。
 */

/* 读取上界：待审队列与已审记录都受 api.js「无分页」的限制，必须给上界 */
var CON_REVIEW_LIMIT = CON_LIMITS.attempts;
var CON_REVIEWED_LIMIT = 20;

/* ==========================================================================
   第一部分：成绩录入
   ========================================================================== */

var CON_ENTRY = {
  cfg: {},          // 当前所选赛事项目的合并配置（决定显示哪些记录项）
  ceId: '',
};

/** 录入页的字段与项目配置的对应关系。表在这里，是为了「关掉某个记录项」只有一处定义 */
var CON_ENTRY_RECORD_FIELDS = [
  { cfgKey: 'record_steps', fieldId: 'cin-wrap-moves' },
  { cfgKey: 'record_tps', fieldId: 'cin-wrap-tps' },
  { cfgKey: 'record_video', fieldId: 'cin-wrap-video' },
  { cfgKey: 'record_algorithm', fieldId: 'cin-wrap-steps' },
  { cfgKey: 'record_algorithm', fieldId: 'cin-wrap-stepcomments' },
];

function conEntryRender() {
  var host = document.getElementById('cin-body');
  if (!host) return;

  var baseErr = conBaseError();
  if (baseErr && !CON_BASE.loaded) {
    conRenderError('#cin-body', baseErr, '连不上后端时没法读比赛与项目。确认网络后重新进入本页。');
    return;
  }

  // 首次进入时基础数据还在路上，此时既没有错也没有数据——
  // 直接显示「还不能录入」是错的，会让人以为要去建数据
  if (!CON_BASE.loaded && !baseErr) {
    renderLoading('#cin-body', '正在读取比赛与项目…');
    return;
  }

  var ces = conEntryUsableCes();
  var parts = conEntryParticipants();

  // 前置数据缺了就直说缺什么、去哪里补——不要给一个空下拉框让人猜
  if (!ces.length || !parts.length) {
    setHtml('#cin-body',
      '<div class="state">' +
        '<p class="state-title">还不能录入成绩</p>' +
        '<p class="state-hint">' +
          (!ces.length
            ? '还没有可用的「赛事项目」——成绩录在赛事项目上，所以需要先有一场比赛、一个项目，再把两者连起来。'
            : '还没有「选手」——每条成绩都要归属到一名选手。') +
        '</p>' +
        '<div class="btn-row mt-5" style="justify-content:center">' +
          (ces.length ? '' :
            '<button type="button" class="btn btn-primary" ' +
            'onclick="conDataGoto(\'competition_events\')">去建赛事项目</button>') +
          (parts.length ? '' :
            '<button type="button" class="btn btn-primary" ' +
            'onclick="conDataGoto(\'participants\')">去建选手</button>') +
        '</div>' +
      '</div>');
    return;
  }

  host.innerHTML = conEntryFormHtml(ces, parts);
  conEntryBind();
  conEntryApplyConfig();
}

/** 可用赛事项目：比赛与项目都能查到才算可用（被删掉父项的记录不该出现在下拉框里） */
function conEntryUsableCes() {
  return (CON_BASE.ces || []).filter(function (ce) {
    return CON_BASE.compById[ce.competition_id] && CON_BASE.eventById[ce.event_id];
  });
}

function conEntryParticipants() {
  return CON_BASE.participants || [];
}

function conEntryFormHtml(ces, parts) {
  var ceItems = ces.map(function (ce) {
    var comp = CON_BASE.compById[ce.competition_id];
    var ev = CON_BASE.eventById[ce.event_id];
    return {
      value: ce.id,
      group: conCompLabel(comp),
      label: (ce.event_number == null ? '' : '#' + ce.event_number + ' ') +
        (ev.event_name || '未命名项目'),
    };
  });

  var partItems = parts.map(function (p) {
    return { value: p.id, label: p.name || '（未命名选手）' };
  });

  var html =
    '<div class="con-toolbar">' +
      '<div class="con-toolbar-main">' +
        '<span class="con-toolbar-label">共 ' + ces.length + ' 个赛事项目、' +
          parts.length + ' 名选手可选</span>' +
      '</div>' +
      '<div class="con-toolbar-spacer"></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="guard(this, conEntryReloadBase)">' +
        '重新读取</button>' +
    '</div>' +

    '<div class="card mt-4">' +
      '<form class="con-form-grid" id="cin-form" novalidate>' +

        conField('赛事项目',
          conSelect('cin-ce', ceItems, { placeholder: '选择比赛与项目', groups: true }),
          '成绩记在「某场比赛的某个项目」上。列表按比赛分组。',
          { span: 2, required: true, forId: 'cin-ce' }) +

        conField('选手', conSelect('cin-participant', partItems, { placeholder: '选择选手' }),
          '名单里没有这位选手？先去「基础数据 · 选手」新建。',
          { required: true, forId: 'cin-participant' }) +

        conField('第几次', '<input class="input" id="cin-attempt" type="text" value="1" ' +
          'inputmode="numeric" autocapitalize="off">',
          '同一名选手在同一项目里的第几条记录。',
          { required: true, id: 'cin-wrap-attempt', forId: 'cin-attempt' }) +

        conField('魔方类型', conSelect('cin-cube', [
          { value: 'non_smart', label: '普通魔方' },
          { value: 'smart', label: '智能魔方' },
        ], { selected: 'non_smart' }), '智能魔方指能自动记录成绩的魔方。',
          { forId: 'cin-cube' }) +

        conField('结果', conEntryKindRadios(),
          'DNF = 未完成，DNS = 未开始。两者都不需要填用时。', { span: 2 }) +

        conField('用时（秒）',
          '<input class="input" id="cin-time" type="number" step="0.001" min="0" ' +
          'placeholder="如 12.345">',
          '精确到毫秒。超过 60 秒也可以直接填秒数（如 75.2）。', { forId: 'cin-time' }) +

        conField('罚时',
          '<label class="con-check"><input type="checkbox" id="cin-plus2"> 加 2 秒（+2）</label>',
          '只对有效成绩有意义，DNF / DNS 会被忽略。') +

        conField('打乱', '<input class="input" id="cin-scramble" type="text" ' +
          'placeholder="如 R U R\' U\'" spellcheck="false" autocapitalize="off">',
          '照抄打乱公式即可；没有就留空。', { span: 2, forId: 'cin-scramble' }) +

        conField('步数', '<input class="input" id="cin-moves" type="number" min="0" ' +
          'inputmode="numeric" placeholder="如 58">', '',
          { id: 'cin-wrap-moves', forId: 'cin-moves' }) +

        conField('TPS',
          '<input class="input" id="cin-tps" type="number" step="0.001" min="0" ' +
          'placeholder="留空自动算">',
          '', { id: 'cin-wrap-tps', forId: 'cin-tps' }) +
        '<p class="con-live-hint" id="cin-tps-hint"></p>' +

        conField('解法', '<textarea class="textarea" id="cin-steps" rows="3" ' +
          'spellcheck="false" placeholder="如 CFOP / Roux / 桥式"></textarea>',
          '', { span: 2, id: 'cin-wrap-steps', forId: 'cin-steps' }) +

        conField('步骤说明', '<textarea class="textarea" id="cin-stepcomments" rows="2" ' +
          'placeholder="每一步的用时或备注"></textarea>', '',
          { span: 2, id: 'cin-wrap-stepcomments', forId: 'cin-stepcomments' }) +

        conField('录像链接', '<input class="input" id="cin-video" type="url" ' +
          'placeholder="https://…" autocapitalize="off" spellcheck="false">',
          '用于成绩核验的外链。', { span: 2, id: 'cin-wrap-video', forId: 'cin-video' }) +

        conField('备注', '<textarea class="textarea" id="cin-notes" rows="2"></textarea>',
          '', { span: 2, forId: 'cin-notes' }) +

      '</form>' +

      '<label class="con-check con-check-top mt-4">' +
        '<input type="checkbox" id="cin-all"> 显示全部字段（忽略项目配置）' +
      '</label>' +
      '<p class="hint mt-2" id="cin-cfg-note"></p>' +

      '<div class="form-error" id="cin-error" role="alert" hidden></div>' +

      '<div class="btn-row mt-5">' +
        // form="cin-form" 不能省：这个按钮在 <form> 外面（错误位与状态说明要留在表单
        // 之后），不写 form 属性它就跟表单没有任何关系，点下去**什么都不会发生**——
        // 没有报错、没有提示，只是安静地没反应。
        '<button type="submit" form="cin-form" class="btn btn-primary" id="cin-submit">' +
          '提交成绩</button>' +
        '<button type="button" class="btn btn-ghost" onclick="conEntryReset()">清空表单</button>' +
      '</div>' +
      '<p class="faint mt-4" id="cin-status-note"></p>' +
    '</div>';

  return html;
}

function conEntryKindRadios() {
  var opts = [
    { v: 'valid', label: '有效成绩' },
    { v: 'dnf', label: 'DNF（未完成）' },
    { v: 'dns', label: 'DNS（未开始）' },
  ];
  return '<div class="con-radio-row">' + opts.map(function (o, i) {
    return '<label class="con-radio"><input type="radio" name="cin-kind" value="' + o.v + '"' +
      (i === 0 ? ' checked' : '') + '> ' + escHtml(o.label) + '</label>';
  }).join('') + '</div>';
}

/** 当前选中的结果类型 */
function conEntryKind() {
  var el = document.querySelector('input[name="cin-kind"]:checked');
  return el ? el.value : 'valid';
}

/**
 * 按所选项目的配置决定显示哪些记录项。
 *
 * 规则只有一条，但必须守住：**配置只控制「显示」，不控制「必填」，也不限制可选项**。
 * 理由是配置是别人写的、可能过时；编辑员却实实在在面对着这一条成绩。
 * 少显示一个输入框会让人以为「这个字段不能填了」，而实际上只是项目没勾这一项。
 * 所以同样给了「显示全部字段」这个开关作为后门。
 */
function conEntryApplyConfig() {
  var ce = CON_BASE.ceById[CON_ENTRY.ceId];
  var ev = ce ? CON_BASE.eventById[ce.event_id] : null;
  var cfg = conEventConfig(ev);
  CON_ENTRY.cfg = cfg;

  var all = conChecked('cin-all');
  CON_ENTRY_RECORD_FIELDS.forEach(function (m) {
    var wrap = document.getElementById(m.fieldId);
    if (!wrap) return;
    // 没配置过这一项 → 显示（默认放行）；显式配成 false → 隐藏
    var on = all || conCfgBool(cfg, m.cfgKey, true);
    wrap.classList.toggle('con-off', !on);
  });

  var label = conCfgStr(cfg, 'attempt_id_label');
  var attemptLabel = document.querySelector('#cin-wrap-attempt .label');
  if (attemptLabel) {
    attemptLabel.textContent = label || '第几次';
  }

  var hintBits = [];
  if (!ev) {
    hintBits.push('所选赛事项目对应的项目已不存在，请重新选择。');
  } else if (!Object.keys(cfg).length) {
    hintBits.push('项目「' + (ev.event_name || '') + '」没有配置记录项，因此全部字段都显示。');
  } else {
    var hidden = CON_ENTRY_RECORD_FIELDS.filter(function (m) {
      return !all && !conCfgBool(cfg, m.cfgKey, true);
    }).length;
    hintBits.push('已按项目「' + (ev.event_name || '') + '」的配置' +
      (hidden ? '收起 ' + hidden + ' 个记录项' : '显示全部记录项') + '。');
  }
  var maxA = Number(conCfgStr(cfg, 'max_attempts'));
  if (maxA > 0) hintBits.push('该项目建议最多 ' + maxA + ' 次。');
  setText('#cin-cfg-note', hintBits.join(''));

  conEntryUpdateTpsHint();
}

function conEntryUpdateTpsHint() {
  var hint = document.getElementById('cin-tps-hint');
  if (!hint) return;
  var t = conNum('cin-time');
  var m = conNum('cin-moves');
  var typed = conNum('cin-tps');
  if (conEntryKind() !== 'valid' || t == null || m == null || t <= 0 || m < 0) {
    hint.textContent = '';
    return;
  }
  var auto = Math.round((m / t) * 1000) / 1000;
  hint.textContent = typed == null
    ? '步数 ÷ 用时 ≈ ' + auto + '，TPS 留空就按这个值提交。'
    : '步数 ÷ 用时 ≈ ' + auto + '（你填的是 ' + typed + '，以你填的为准）。';
}

function conEntryBind() {
  var form = document.getElementById('cin-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      guard(document.getElementById('cin-submit'), conEntrySubmit);
    });
  }
  var ceSel = document.getElementById('cin-ce');
  if (ceSel) {
    ceSel.addEventListener('change', function () {
      CON_ENTRY.ceId = ceSel.value;
      conEntryApplyConfig();
    });
  }
  ['cin-time', 'cin-moves', 'cin-tps'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', conEntryUpdateTpsHint);
  });
  document.querySelectorAll('input[name="cin-kind"]').forEach(function (el) {
    el.addEventListener('change', function () {
      conEntrySyncKind();
      conEntryUpdateTpsHint();
    });
  });
  var all = document.getElementById('cin-all');
  if (all) all.addEventListener('change', conEntryApplyConfig);
}

/** 结果类型决定用时输入框是否可用 */
function conEntrySyncKind() {
  var valid = conEntryKind() === 'valid';
  var time = document.getElementById('cin-time');
  var plus2 = document.getElementById('cin-plus2');
  if (time) { time.disabled = !valid; if (!valid) time.value = ''; }
  if (plus2) { plus2.disabled = !valid; if (!valid) plus2.checked = false; }
}

async function conEntryReloadBase(btn) {
  await conLoadBase(true);
  CON_ENTRY.ceId = '';
  conEntryRender();
  var msg = conBaseError();
  if (msg) showAlert(msg, 'error');
}

/**
 * 从别处（被驳回的记录）带一条数据过来重新录入。
 * 必须先 await 基础数据：调用它的路径是「切到录入标签 → 立刻预填」，
 * 而录入表单是在基础数据读完之后的回调里才渲染出来的。
 */
async function conEntryPrefill(row) {
  await conLoadBase();
  conEntryRender();
  if (!row) return;
  var setV = function (id, v) {
    var el = document.getElementById(id);
    if (el && v != null) el.value = v;
  };
  var ceSel = document.getElementById('cin-ce');
  if (ceSel && row.competition_event_id) {
    ceSel.value = row.competition_event_id;
    if (ceSel.value === row.competition_event_id) {
      CON_ENTRY.ceId = row.competition_event_id;
      conEntryApplyConfig();
    }
  }
  var pSel = document.getElementById('cin-participant');
  if (pSel && row.participant_id) pSel.value = row.participant_id;
  setV('cin-attempt', row.attempt_number);
  var cube = document.getElementById('cin-cube');
  if (cube && row.cube_type) cube.value = row.cube_type;
  setV('cin-scramble', row.scramble);
  setV('cin-moves', row.move_count);
  setV('cin-tps', row.tps);
  setV('cin-steps', row.solve_steps);
  setV('cin-stepcomments', row.step_comments);
  setV('cin-video', row.video_url);
  setV('cin-notes', row.notes);

  // 结果类型：DNF / DNS 各自回填，其余按有效处理
  var kind = row.is_dnf ? 'dnf' : (row.is_dns ? 'dns' : 'valid');
  var radio = document.querySelector('input[name="cin-kind"][value="' + kind + '"]');
  if (radio) radio.checked = true;
  if (kind === 'valid' && row.solve_time != null) setV('cin-time', row.solve_time);
  var plus2 = document.getElementById('cin-plus2');
  if (plus2) plus2.checked = !!row.is_plus_two;
  conEntrySyncKind();
  conEntryUpdateTpsHint();
  showAlert('已把那条成绩填进表单，改完再提交一次', 'info');
}

/**
 * 提交。字段收集规则与后端 SUBMIT_ALLOWED_FIELDS 对齐；
 * solve_time 用哨兵值表达 DNF(-1) / DNS(-2)，由服务端翻译成标志位。
 */
async function conEntrySubmit(btn) {
  conFormError('#cin-error', '');

  var ceId = conVal('cin-ce');
  var pid = conVal('cin-participant');
  var attempt = conVal('cin-attempt');
  var cube = conVal('cin-cube');
  var kind = conEntryKind();

  if (!ceId) { conFormError('#cin-error', '请选择赛事项目。'); return; }
  if (!pid) { conFormError('#cin-error', '请选择选手。'); return; }
  if (!attempt) { conFormError('#cin-error', '「第几次」不能为空。'); return; }
  if (!cube) { conFormError('#cin-error', '请选择魔方类型。'); return; }

  var payload = {
    competition_event_id: ceId,
    participant_id: pid,
    attempt_number: attempt,
    cube_type: cube,
  };

  if (kind === 'valid') {
    var t = conNum('cin-time');
    if (t == null) { conFormError('#cin-error', '有效成绩必须填用时。DNF / DNS 请改选结果类型。'); return; }
    if (!isFinite(t) || t < 0) { conFormError('#cin-error', '用时必须是非负数字。'); return; }
    payload.solve_time = t;
    payload.is_plus_two = conChecked('cin-plus2');
  } else {
    // 哨兵：-1 → DNF，-2 → DNS。服务端会把它翻成 is_dnf / is_dns 并把 solve_time 置空
    payload.solve_time = (kind === 'dnf') ? -1 : -2;
  }

  var moves = conNum('cin-moves');
  if (moves != null) {
    if (!isFinite(moves) || moves < 0) { conFormError('#cin-error', '步数必须是非负数。'); return; }
    payload.move_count = moves;
  }
  var tps = conNum('cin-tps');
  if (tps != null && isFinite(tps) && tps >= 0) {
    payload.tps = tps;
  } else if (moves != null && payload.solve_time > 0) {
    // 留空就按 步数 ÷ 用时 补上——界面上已经实时显示过这个值，不是暗箱操作
    payload.tps = Math.round((moves / payload.solve_time) * 1000) / 1000;
  }

  var textFields = [
    ['cin-scramble', 'scramble'],
    ['cin-steps', 'solve_steps'],
    ['cin-stepcomments', 'step_comments'],
    ['cin-video', 'video_url'],
    ['cin-notes', 'notes'],
  ];
  textFields.forEach(function (p) {
    var v = conVal(p[0]);
    if (v) payload[p[1]] = v;
  });

  var r = await conCall('/submit-attempt', payload);
  if (!r.ok) {
    conFormError('#cin-error', '提交失败：' + r.message);
    return;
  }

  var status = (r.data && r.data.status) || 'pending';
  setText('#cin-status-note', status === 'approved'
    ? '刚才那条已直接录入并生效（管理员录入不计入待审队列）。'
    : '刚才那条已进入待审队列，通过后才会出现在公开的成绩页上。');
  showAlert(status === 'approved' ? '已录入并生效' : '已提交，等待审核', 'success');

  conEntryAfterSubmit(attempt);
  if (typeof conMeReload === 'function') conMeReload();
}

/**
 * 提交后的表单状态：保留「是谁、比什么」，清掉这一条独有的数据，第几次自动 +1。
 * 连续录同一名选手的 5 次成绩是这里最常见的用法，每次都要重选一遍项目和人，
 * 十几条录下来会烦到出错。
 */
function conEntryAfterSubmit(attempt) {
  ['cin-time', 'cin-moves', 'cin-tps', 'cin-steps',
    'cin-stepcomments', 'cin-video', 'cin-notes'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var plus2 = document.getElementById('cin-plus2');
  if (plus2) plus2.checked = false;

  // 第几次：能当数字读就 +1，否则留空让人自己填（自定义编号的项目不该被瞎猜）
  var next = '';
  if (/^\d+$/.test(attempt)) next = String(Number(attempt) + 1);
  var attemptEl = document.getElementById('cin-attempt');
  if (attemptEl) attemptEl.value = next;

  var scramble = document.getElementById('cin-scramble');
  if (scramble) scramble.value = '';
  conEntryUpdateTpsHint();
  var focusEl = document.getElementById('cin-time') || document.getElementById('cin-attempt');
  if (focusEl) focusEl.focus();
}

function conEntryReset() {
  conEntryRender();
  conFormError('#cin-error', '');
  setText('#cin-status-note', '');
}

/* ==========================================================================
   第二部分：成绩审核
   ========================================================================== */

var CON_REVIEW = {
  pending: [],
  mine: [],          // 已审核过的最近若干条（reviewed_by = 我）
  profiles: {},      // id → profile，用于把 submitted_by 显示成人名
  loaded: false,
};

function conReviewRender() {
  var host = document.getElementById('crev-body');
  if (!host) return;
  host.innerHTML =
    '<div class="con-toolbar">' +
      '<div class="con-toolbar-main">' +
        '<span class="con-toolbar-label" id="crev-count"></span>' +
      '</div>' +
      '<div class="con-toolbar-spacer"></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="guard(this, conReviewReload)">' +
        '刷新队列</button>' +
    '</div>' +
    '<p class="con-note mt-4">' +
      '通过之后这条成绩会立刻对所有人公开。驳回不带理由字段——' +
      '数据库里没有存驳回理由的地方，所以本页不做一个填了也不会被保存的输入框；' +
      '需要说明请另行告知提交者。' +
    '</p>' +
    '<h3 class="con-h3 mt-6">待审核</h3>' +
    '<div id="crev-queue" class="mt-4"></div>' +
    '<h3 class="con-h3 mt-6">我审核过的</h3>' +
    '<div id="crev-mine" class="mt-4"></div>';
  conReviewRenderQueue();
  conReviewRenderMine();
}

/** 待审队列：读 pending + 把提交者 id 换成人名 */
async function conReviewLoad() {
  var res = await db('attempts')
    .select('id,competition_event_id,participant_id,attempt_number,solve_time,' +
            'is_dnf,is_plus_two,is_dns,cube_type,submitted_by,created_at,' +
            'scramble,move_count,tps,video_url,notes')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(CON_REVIEW_LIMIT);

  if (res.error) {
    conRenderError('#crev-queue', res.error.message, '刷新队列可以重试。');
    CON_REVIEW.pending = [];
    conSetTabCount('review', 0);
    return false;
  }

  CON_REVIEW.pending = res.data || [];
  conSetTabCount('review', CON_REVIEW.pending.length);

  // submitted_by 指向 auth.users 而不是 profiles，所以 PostgREST 没法直接嵌入联查；
  // 只能先取出这批 id，再单独查一次 profiles 建映射。这是「一次查询换一次映射」，
  // 比逐行查要少得多的请求。
  var ids = [];
  CON_REVIEW.pending.forEach(function (a) {
    if (a.submitted_by && ids.indexOf(a.submitted_by) === -1) ids.push(a.submitted_by);
  });
  var myId = currentUser ? currentUser.id : '';
  if (myId && ids.indexOf(myId) === -1) ids.push(myId);
  if (ids.length) {
    var pr = await db('profiles').select('id,user_code,username').in('id', ids);
    if (!pr.error) {
      CON_REVIEW.profiles = {};
      (pr.data || []).forEach(function (p) { CON_REVIEW.profiles[p.id] = p; });
    }
  }

  CON_REVIEW.mine = [];
  if (myId) {
    var mineRes = await db('attempts')
      .select('id,competition_event_id,participant_id,attempt_number,solve_time,' +
              'is_dnf,is_plus_two,is_dns,status,reviewed_at,submitted_by')
      .eq('reviewed_by', myId)
      .in('status', ['approved', 'rejected'])
      .order('reviewed_at', { ascending: false })
      .limit(CON_REVIEWED_LIMIT);
    CON_REVIEW.mine = mineRes.error ? [] : (mineRes.data || []);
  }

  CON_REVIEW.loaded = true;
  return true;
}

function conReviewPerson(id) {
  if (!id) return '—';
  if (currentUser && id === currentUser.id) return '你';
  var p = CON_REVIEW.profiles[id];
  if (!p) return '（账号已删除）';
  return (p.username || '') || p.user_code || id.slice(0, 8);
}

function conReviewRenderQueue() {
  var host = document.getElementById('crev-queue');
  if (!host) return;

  var rows = CON_REVIEW.pending;
  setText('#crev-count', rows.length
    ? '待审核 ' + rows.length + ' 条' + (conHitLimit(rows, CON_REVIEW_LIMIT) ? '（已达读取上限）' : '')
    : '待审核队列是空的');

  if (!rows.length) {
    renderEmpty('#crev-queue', '没有待审核的成绩',
      '编辑员提交的成绩会出现在这里。管理员录入的成绩直接生效，不经过队列。');
    return;
  }

  var head = ['提交人', '选手', '赛事项目', '第几次', '成绩', '判定', '提交时间', '操作']
    .map(function (c, i) { return '<th scope="col"' + (i >= 3 && i <= 5 ? ' class="num"' : '') + '>' + escHtml(c) + '</th>'; })
    .join('');

  var body = rows.map(function (a) {
    var mine = currentUser && a.submitted_by === currentUser.id;
    return '<tr>' +
      '<td>' + escHtml(conReviewPerson(a.submitted_by)) + '</td>' +
      '<td class="wrap-cell">' + escHtml(conReviewParticipantName(a)) + '</td>' +
      '<td class="wrap-cell">' + escHtml(conCeShort(CON_BASE.ceById[a.competition_event_id])) + '</td>' +
      '<td class="num">' + escHtml(a.attempt_number == null ? '—' : a.attempt_number) + '</td>' +
      '<td class="num">' + escHtml(formatAttemptTime(a)) + '</td>' +
      '<td>' + escHtml(conReviewJudge(a)) + '</td>' +
      '<td class="faint">' + escHtml(conDateTime(a.created_at)) + '</td>' +
      '<td>' + conReviewRowActions(a, mine) + '</td>' +
    '</tr>';
  }).join('');

  setHtml('#crev-queue', conTable(
    '共 ' + rows.length + ' 条待审，按提交时间正序（先提交的排前面）', head, body));
}

function conReviewParticipantName(a) {
  var p = CON_BASE.partById[a.participant_id];
  return p ? (p.name || '—') : '（选手已删除）';
}

/** 判定文字：+2 与 DNF/DNS 是三种不同的东西，不要混成一个「异常」 */
function conReviewJudge(a) {
  var bits = [];
  if (a.is_dnf) bits.push('DNF');
  if (a.is_dns) bits.push('DNS');
  if (a.is_plus_two) bits.push('+2');
  if (!bits.length) return '有效';
  return bits.join(' ');
}

function conReviewRowActions(a, mine) {
  if (mine) {
    // 服务端会拒（403 + 触发器兜底），界面就别给这个必然失败的按钮了
    return '<span class="faint">自己提交的，需他人审核</span>';
  }
  var attrs = ' data-attempt-id="' + escHtml(a.id) + '"';
  return conRowActions([
    conRowBtn('guard(this, conReviewApprove)', '通过', 'primary', attrs),
    conRowBtn('guard(this, conReviewReject)', '驳回', 'danger', attrs),
  ]);
}

function conReviewRenderMine() {
  var host = document.getElementById('crev-mine');
  if (!host) return;
  var rows = CON_REVIEW.mine || [];
  if (!rows.length) {
    renderEmpty('#crev-mine', '你还没有审核过成绩', '通过或驳回之后，记录会出现在这里，方便回头核对。');
    return;
  }
  var head = ['选手', '赛事项目', '第几次', '成绩', '结果', '审核时间']
    .map(function (c, i) { return '<th scope="col"' + (i === 2 || i === 3 ? ' class="num"' : '') + '>' + escHtml(c) + '</th>'; })
    .join('');
  var body = rows.map(function (a) {
    return '<tr>' +
      '<td>' + escHtml(conReviewParticipantName(a)) + '</td>' +
      '<td class="wrap-cell">' + escHtml(conCeShort(CON_BASE.ceById[a.competition_event_id])) + '</td>' +
      '<td class="num">' + escHtml(a.attempt_number == null ? '—' : a.attempt_number) + '</td>' +
      '<td class="num">' + escHtml(formatAttemptTime(a)) + '</td>' +
      '<td>' + conStatusTag(a.status) + '</td>' +
      '<td class="faint">' + escHtml(conDateTime(a.reviewed_at)) + '</td>' +
    '</tr>';
  }).join('');
  setHtml('#crev-mine', conTable(
    '最近 ' + rows.length + ' 条（最多读取 ' + CON_REVIEWED_LIMIT + ' 条）', head, body));
}

/* 通过/驳回共用一个执行体：两者的差别只有 action 与文案，其余（乐观锁、并发冲突、
   自审、状态已被处理）完全一样，分开写会写两遍一样的错误分支。 */
async function conReviewDecide(btn, action) {
  var id = btn && btn.dataset ? btn.dataset.attemptId : '';
  if (!id) return;
  var r = await conCall('/review-attempt', { attemptId: id, action: action });
  if (!r.ok) {
    showAlert((action === 'approve' ? '通过' : '驳回') + '失败：' + r.message, 'error');
    // 409 = 乐观锁没命中，说明队列是旧的；顺手刷新，别让人对着一条已被处理的记录反复点
    await conReviewReload();
    return;
  }
  showAlert(action === 'approve' ? '已通过，这条成绩现在公开可见' : '已驳回', 'success');
  await conReviewReload();
  if (typeof conMeReload === 'function') conMeReload();
}

/* ⚠️ 这两个函数被行内事件以 guard(this, conReviewApprove) 的形式调用。
   按钮上挂着 data-attempt-id，函数自己从按钮上取 id，而不是靠行内事件拼参数——
   在 onClick 里再拼一个 uuid，就多一层引号转义，多一层就多一处出错的地方。
   guard 会把按钮作为第一个实参传进来（见 ui.js），所以这里能直接读 btn.dataset。 */
async function conReviewApprove(btn) {
  await conReviewDecide(btn, 'approve');
}

async function conReviewReject(btn) {
  await conReviewDecide(btn, 'reject');
}

async function conReviewReload(btn) {
  var ok = await conReviewLoad();
  conReviewRender();
  if (!ok) showAlert('队列刷新失败，界面显示的可能不是最新状态', 'error');
}

function conReviewActivate() {
  return conReviewLoad().then(function () { conReviewRender(); });
}

/* ==========================================================================
   挂载
   ========================================================================== */

consoleRegister({
  id: 'entry',
  label: '成绩录入',
  minRole: 'editor',
  order: 20,
  desc: '提交一条成绩。编辑员与审核员提交后进入待审核，管理员提交直接生效——' +
    '这一点由服务端决定，界面不提供改状态的选项。',
  mount: function (host) {
    host.innerHTML =
      '<p class="con-intro" id="cin-intro"></p>' +
      '<div id="cin-body" class="mt-4"></div>';
    setText('#cin-intro', '成绩录在「赛事项目」上（某场比赛的某个项目）。' +
      '选好赛事项目后，表单会按该项目的配置显示对应的记录项。');
    conLoadBase().then(function () {
      conEntryRender();
      var msg = conBaseError();
      if (msg) showAlert(msg, 'error');
    });
  },
  onShow: function () {
    conLoadBase().then(function () { conEntryRender(); });
  },
});

consoleRegister({
  id: 'review',
  label: '成绩审核',
  minRole: 'reviewer',
  order: 30,
  desc: '通过或驳回待审成绩。不能审核自己提交的——服务端会拒绝，数据库触发器再兜一层。',
  mount: function (host) {
    host.innerHTML = '<div id="crev-body"></div>';
    conLoadBase().then(conReviewActivate);
  },
  onShow: function () {
    conLoadBase().then(conReviewActivate);
  },
});
