/**
 * 管理台 · 基础数据维护（编辑员及以上）
 *
 * 四类对象：比赛 / 项目 / 赛事项目 / 选手。它们的关系是
 *
 *     比赛 ──< 赛事项目 >── 项目
 *                    │
 *                 成绩(attempts) ── 选手
 *
 * 也就是：**成绩录在「赛事项目」上**，而不是直接挂比赛或项目。
 * 这一点决定了本页的操作顺序——先把比赛和项目都建好，再建「赛事项目」把两者连起来，
 * 最后才能录成绩。所以「赛事项目」这一档的解释文字写得最细。
 *
 * 三个设计取舍：
 *
 * ① **一套规格驱动四个表格**。四个对象的差别只有「字段」「列」「表格名」，
 *    剩下的（表单渲染、校验、收集、列表、编辑、删除确认）完全一样。
 *    所以下面用 CON_DATA_KINDS 声明差异，逻辑只写一遍。加第五类对象 = 加一段声明。
 *
 * ② **数据源就是 CON_BASE 缓存，不另开查询**。理由不只是省一次请求：
 *    如果这里单独读一份「比赛」，「成绩录入」页从缓存里读另一份，
 *    刚建的比赛在录入页的下拉框里就会缺席——那种不一致比多一次请求难查得多。
 *    所有写操作结束后都调 conLoadBase(true) 强制失效，四个功能区一起看到新数据。
 *
 * ③ **删除用行内二次确认，不用浏览器弹窗**。删除比赛会连带删掉它名下的
 *    赛事项目与这些项目下的成绩（数据库外键 ON DELETE CASCADE），这种动作
 *    值得让人停一下，但值不值得为它写一个模态框？不值得——所以做成
 *    「点删除 → 该行原地变成确认条 → 再点确认」。没有新组件，
 *    键盘可达，也能被自动化测试驱动（window.confirm 不行）。
 */

/* ---------------- 规格声明 ---------------- */

/**
 * 字段类型：
 *   text / number / date / textarea  普通控件
 *   select    选项由 options() 动态给（依赖 CON_BASE，所以是函数）
 *   config    项目配置（开关 + JSON 高级编辑），只有「项目」用
 */
var CON_DATA_KINDS = [
  {
    key: 'competitions',
    label: '比赛',
    table: 'competitions',
    limit: CON_LIMITS.competitions,
    noun: '场比赛',
    intro: '一次比赛就是一条记录。成绩挂在「赛事项目」上，所以先把比赛建好。',
    emptyHint: '还没有比赛。先在上面的表单里建一场，再去「赛事项目」把项目挂上去。',
    cascadeNote: '删除比赛会连带删除它名下的赛事项目，以及这些项目下的全部成绩。',
    fields: [
      { key: 'competition_number', label: '比赛编号', type: 'number',
        hint: '整数，用于排序与显示（如 3 显示为 #3）。同一编号可以重复，但建议唯一。' },
      { key: 'name', label: '赛事名称', type: 'text', required: true,
        placeholder: '如：2026 秋季校内赛' },
      { key: 'competition_date', label: '比赛日期', type: 'date' },
      { key: 'location', label: '地点', type: 'text', placeholder: '如：实验楼 302' },
      { key: 'notes', label: '备注', type: 'textarea', span: 2 },
    ],
    columns: [
      { label: '编号', num: true }, { label: '赛事名称' }, { label: '日期' }, { label: '地点' },
    ],
    rowCells: function (r) {
      return [
        { html: r.competition_number == null ? '—' : '#' + escHtml(r.competition_number), cls: 'num' },
        { html: escHtml(r.name || '未命名赛事') },
        { html: escHtml(formatDate(r.competition_date, '—')) },
        { html: escHtml(r.location || '—') },
      ];
    },
  },

  {
    key: 'events',
    label: '项目',
    table: 'events',
    limit: CON_LIMITS.events,
    noun: '个项目',
    intro: '项目是「比什么」（三阶速拧、二阶、金字塔…）。项目可以挂在另一个项目下做成父子层级，' +
      '子项目会继承父项目的配置，同名配置项以子项目为准。',
    emptyHint: '还没有项目。先建一个，再去「赛事项目」把它挂到某场比赛上。',
    cascadeNote: '删除项目会连带删除引用它的赛事项目，以及这些项目下的全部成绩。',
    fields: [
      { key: 'event_name', label: '项目名称', type: 'text', required: true,
        placeholder: '如：三阶速拧' },
      { key: 'event_code', label: '项目代码', type: 'text',
        placeholder: '如：333', hint: '内部简称，用于对上 WCA 项目代码；留空也行。' },
      { key: 'parent_event_id', label: '父项目', type: 'select',
        hint: '留空即顶层项目。选了父项目，本项目就成为它的子项目并继承其配置。',
        options: function (self) {
          return CON_BASE.events
            .filter(function (e) { return e.id !== self; })
            .map(function (e) { return { value: e.id, label: conEventLabel(e) }; });
        } },
      { key: 'sort_order', label: '排序', type: 'number',
        hint: '数字越小越靠前。首页与下拉框都按它排。' },
      { key: 'description', label: '项目简介', type: 'textarea', span: 2 },
      { key: 'event_config', label: '项目配置', type: 'config', span: 2,
        hint: '配置决定「成绩录入」页显示哪些记录项。不配置 = 全部显示，' +
          '所以新项目不配也能录成绩。' },
    ],
    columns: [
      { label: '项目' }, { label: '代码' }, { label: '父项目' },
      { label: '排序', num: true }, { label: '配置' },
    ],
    rowCells: function (r) {
      var cfg = conAsObject(r.event_config);
      var on = [];
      if (conCfgBool(cfg, 'record_steps', false)) on.push('步数');
      if (conCfgBool(cfg, 'record_tps', false)) on.push('TPS');
      if (conCfgBool(cfg, 'record_video', false)) on.push('录像');
      if (conCfgBool(cfg, 'record_algorithm', false)) on.push('解法');
      var parent = r.parent_event_id ? CON_BASE.eventById[r.parent_event_id] : null;
      return [
        { html: escHtml(r.event_name || '未命名项目') },
        { html: r.event_code ? '<span class="mono">' + escHtml(r.event_code) + '</span>' : '<span class="faint">—</span>' },
        { html: parent ? escHtml(parent.event_name || '—') : '<span class="faint">顶层</span>' },
        { html: r.sort_order == null ? '<span class="faint">0</span>' : escHtml(r.sort_order), cls: 'num' },
        { html: on.length ? escHtml(on.join(' / ')) : '<span class="faint">全部显示</span>' },
      ];
    },
  },

  {
    key: 'competition_events',
    label: '赛事项目',
    table: 'competition_events',
    limit: CON_LIMITS.competitionEvents,
    noun: '条',
    intro: '「某场比赛里的某个项目」——成绩就录在这上面。做这一层是因为同一个项目' +
      '会在很多场比赛里各比一次，两边都必须能独立统计。',
    emptyHint: '还没有赛事项目。这样「成绩录入」里选不到任何项目——先在这里把比赛和项目连起来。',
    cascadeNote: '删除赛事项目会连带删除它名下的全部成绩。',
    fields: [
      { key: 'competition_id', label: '比赛', type: 'select', required: true,
        placeholder: '选择比赛',
        hint: '没有想要的比赛？先去「比赛」档建一场。',
        options: function () {
          return CON_BASE.competitions.map(function (c) {
            return { value: c.id, label: conCompLabel(c) };
          });
        } },
      { key: 'event_id', label: '项目', type: 'select', required: true,
        placeholder: '选择项目',
        hint: '没有想要的项目？先去「项目」档建一个。',
        options: function () {
          return CON_BASE.events.map(function (e) {
            return { value: e.id, label: conEventLabel(e) };
          });
        } },
      { key: 'event_number', label: '场次号', type: 'number',
        hint: '同一场比赛里同一项目只办一次就留空；办了多场（如初赛/复赛）才需要编号。' },
    ],
    columns: [{ label: '比赛' }, { label: '项目' }, { label: '场次', num: true }],
    rowCells: function (r) {
      var comp = CON_BASE.compById[r.competition_id];
      var ev = CON_BASE.eventById[r.event_id];
      return [
        { html: escHtml(conCompLabel(comp)) },
        { html: escHtml(ev ? (ev.event_name || '未命名项目') : '（项目已删除）') },
        { html: r.event_number == null ? '<span class="faint">—</span>' : '#' + escHtml(r.event_number), cls: 'num' },
      ];
    },
    /** 完全重复的（比赛 + 项目 + 场次）会让录入时出现两个一模一样的选择项，提前拦下 */
    precheck: function (body, editingId) {
      var dup = CON_BASE.ces.filter(function (ce) {
        return ce.id !== editingId &&
          ce.competition_id === body.competition_id &&
          ce.event_id === body.event_id &&
          (ce.event_number == null ? null : Number(ce.event_number)) ===
            (body.event_number == null ? null : Number(body.event_number));
      });
      if (dup.length) {
        return '这条赛事项目已经存在（同一场比赛 + 同一项目 + 同一个场次号）。' +
          '如果确实要再建一条同名记录，请给它们不同的场次号。';
      }
      return '';
    },
  },

  {
    key: 'participants',
    label: '选手',
    table: 'participants',
    limit: CON_LIMITS.participants,
    noun: '名选手',
    intro: '选手是成绩的归属者。这里只存姓名与 WCA ID——' +
      '按章程，本组织不收集成员的真实姓名，所以填昵称或组织内部称呼即可。',
    emptyHint: '还没有选手。',
    cascadeNote: '删除选手会连带删除他名下的全部成绩。',
    fields: [
      { key: 'name', label: '姓名 / 昵称', type: 'text', required: true,
        hint: '公开可见，会出现在成绩页上。不要填真实姓名。' },
      { key: 'wca_id', label: 'WCA ID', type: 'text',
        placeholder: '如：2023ABCD01',
        hint: '有 WCA 官方 ID 才填，用于对上外部成绩记录。' },
    ],
    columns: [{ label: '姓名' }, { label: 'WCA ID' }],
    rowCells: function (r) {
      return [
        { html: escHtml(r.name || '—') },
        { html: r.wca_id ? '<span class="mono">' + escHtml(r.wca_id) + '</span>' : '<span class="faint">—</span>' },
      ];
    },
  },
];

/* ---------------- 状态 ---------------- */

var CON_DATA = {
  kind: 'competitions',
  editingId: null,      // 非空 = 表单处于编辑模式
  pendingDelete: null,  // 非空 = 这一行正在等二次确认
  cfgDraft: {},         // 项目配置的内存稿（开关改的是它，提交时以 JSON 文本区为准）
};

function conDataSpec(key) {
  var k = key || CON_DATA.kind;
  for (var i = 0; i < CON_DATA_KINDS.length; i++) {
    if (CON_DATA_KINDS[i].key === k) return CON_DATA_KINDS[i];
  }
  return CON_DATA_KINDS[0];
}

/* ---------------- 渲染 ---------------- */

function conDataRender() {
  var host = document.getElementById('cd-body');
  if (!host) return;

  conDataRenderSwitch();
  host.innerHTML =
    '<p class="con-intro" id="cd-intro"></p>' +
    '<div id="cd-form-wrap"></div>' +
    '<div class="con-list-head"><h3 class="con-h3" id="cd-list-title"></h3>' +
      '<div class="con-toolbar-spacer"></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="guard(this, conDataReload)">重新读取</button>' +
    '</div>' +
    '<div id="cd-list"></div>';

  var spec = conDataSpec();
  setText('#cd-intro', spec.intro);
  setText('#cd-list-title', spec.label + '列表');
  conDataRenderForm();
  conDataRenderList();
}

function conDataRenderSwitch() {
  var host = document.getElementById('cd-switch');
  if (!host) return;
  host.innerHTML = CON_DATA_KINDS.map(function (k) {
    var blocked = conBaseError() && !CON_BASE.loaded;
    return '<button type="button" class="con-switch-btn' +
      (k.key === CON_DATA.kind ? ' is-on' : '') + '"' +
      (blocked ? ' disabled' : '') +
      ' aria-pressed="' + (k.key === CON_DATA.kind ? 'true' : 'false') + '"' +
      ' onclick="conDataSwitch(\'' + escHtml(k.key) + '\')">' + escHtml(k.label) + '</button>';
  }).join('');
}

function conDataSwitch(key) {
  if (key === CON_DATA.kind) return;
  CON_DATA.kind = key;
  CON_DATA.editingId = null;
  CON_DATA.pendingDelete = null;
  CON_DATA.cfgDraft = {};
  conDataRender();
}

/** 切到某一档并按 id 定位到某条记录（从别处跳过来的入口，如录入页的「去补一场比赛」） */
function conDataGoto(key, id) {
  CON_DATA.kind = key;
  CON_DATA.editingId = null;
  CON_DATA.pendingDelete = null;
  conDataRender();
  if (id) conDataEdit(key, id);
}

/* ---------------- 表单 ---------------- */

function conDataRenderForm() {
  var host = document.getElementById('cd-form-wrap');
  if (!host) return;
  var spec = conDataSpec();
  var row = CON_DATA.editingId ? conDataFindRow(spec, CON_DATA.editingId) : null;

  // 编辑到一半记录被删掉了（别处删的）→ 退回新增模式，别让表单指向一个不存在的东西
  if (CON_DATA.editingId && !row) CON_DATA.editingId = null;

  var editing = !!CON_DATA.editingId;
  var body = spec.fields.map(function (f) {
    return conDataFieldHtml(f, row);
  }).join('');

  host.innerHTML =
    '<div class="card">' +
      '<div class="con-card-head">' +
        '<h3 class="card-title">' + (editing ? '修改' + escHtml(spec.label) : '新增' + escHtml(spec.label)) + '</h3>' +
        (editing
          ? '<button type="button" class="link-btn" onclick="conDataCancelEdit()">取消修改</button>'
          : '') +
      '</div>' +
      '<form class="con-form-grid" id="cd-form" novalidate>' + body + '</form>' +
      '<div class="form-error" id="cd-error" role="alert" hidden></div>' +
      '<div class="btn-row mt-5">' +
        // 同 cin-submit：按钮在 <form> 外，必须用 form 属性指回去，否则点击无任何反应
        '<button type="submit" form="cd-form" class="btn btn-primary" id="cd-submit">' +
          (editing ? '保存修改' : '新增') + '</button>' +
        (editing ? '<button type="button" class="btn btn-ghost" onclick="conDataResetForm()">放弃</button>' : '') +
      '</div>' +
      (spec.key === 'events'
        ? '<p class="faint mt-4">子项目继承父项目配置的规则：同名配置项以子项目为准；' +
          '子项目配置里显式写 <span class="mono">inherit_from_parent: false</span> 时完全不用父配置。</p>'
        : '') +
    '</div>';

  var form = document.getElementById('cd-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      guard(document.getElementById('cd-submit'), conDataSave);
    });
  }
  if (spec.key === 'events') conDataBindConfig();
}

/** 单个字段的控件。row 为空即新增模式 */
function conDataFieldHtml(f, row) {
  var id = 'cd-f-' + f.key;
  var v = (row && row[f.key] != null) ? row[f.key] : '';
  var html = '';

  if (f.type === 'textarea') {
    html = '<textarea class="textarea" id="' + id + '" rows="3">' + escHtml(v) + '</textarea>';
  } else if (f.type === 'select') {
    var opts = f.options ? f.options(row ? row.id : null) : [];
    html = conSelect(id, opts, { placeholder: f.placeholder || '（不选）', selected: v === '' ? '' : String(v) });
  } else if (f.type === 'config') {
    return conDataConfigField(f, row);
    // eslint 的等价物：config 字段的控件是一组勾选框+文本区，没有单一的 label 目标
  } else {
    var type = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
    html = '<input class="input" id="' + id + '" type="' + type + '" value="' + escHtml(v) + '"' +
      (f.placeholder ? ' placeholder="' + escHtml(f.placeholder) + '"' : '') + '>';
  }
  return conField(f.label, html, f.hint,
    { span: f.span, required: f.required, forId: id });
}

/**
 * 项目配置字段：一排开关 + 一段 JSON。
 *
 * 两者的主从关系必须说清楚，否则是个必踩的坑：
 *   · **JSON 文本区是最终事实**（提交时解析的是它）
 *   · 开关改动会**重写**这段 JSON——所以改开关等于改 JSON
 *   · 手改 JSON 后（离开文本区时）开关会跟着同步过来，两边不会各说各话
 * 空 JSON = 该项目不设配置 = 继承父项目（若有）。
 */
function conDataConfigField(f, row) {
  var cfg = row ? conAsObject(row.event_config) : {};
  CON_DATA.cfgDraft = conAsObject(cfg);

  var flags = [
    { key: 'supports_smart_cube', label: '支持智能魔方' },
    { key: 'record_steps', label: '记录步数' },
    { key: 'record_tps', label: '记录 TPS' },
    { key: 'record_video', label: '记录录像' },
    { key: 'record_algorithm', label: '记录解法' },
  ];
  var flagHtml = flags.map(function (fl) {
    return '<label class="con-check"><input type="checkbox" id="cd-cfg-' + fl.key + '"' +
      (conCfgBool(cfg, fl.key, false) ? ' checked' : '') + '> ' + escHtml(fl.label) + '</label>';
  }).join('');

  var html =
    '<div class="con-cfg">' +
      '<div class="con-check-row">' + flagHtml + '</div>' +
      '<div class="con-form-grid mt-4">' +
        conField('尝试编号标签',
          '<input class="input" id="cd-cfg-attempt_id_label" type="text" value="' +
            escHtml(conCfgStr(cfg, 'attempt_id_label')) + '" placeholder="尝试编号">',
          '录入页里「第几次」那个字段的显示名，可改成「轮次」「局」等。') +
        conField('最大尝试次数',
          '<input class="input" id="cd-cfg-max_attempts" type="number" min="1" value="' +
            escHtml(conCfgStr(cfg, 'max_attempts')) + '" placeholder="如 5">',
          '只用于在录入页给出提示，不会被强制拦截。') +
      '</div>' +
      '<details class="con-adv">' +
        '<summary>高级：完整 JSON 配置</summary>' +
        '<textarea class="textarea con-code" id="cd-cfg-json" rows="9" spellcheck="false">' +
          escHtml(conDataCfgToText(CON_DATA.cfgDraft)) + '</textarea>' +
        '<p class="hint" id="cd-cfg-note">改上面的开关会重写这段 JSON；反过来手改 JSON 后，' +
          '开关也会跟着变。留空表示该项目不设配置。</p>' +
      '</details>' +
    '</div>';
  return conField(f.label, html, f.hint, { span: f.span });
}

function conDataCfgToText(cfg) {
  var keys = Object.keys(cfg || {});
  if (!keys.length) return '';
  return JSON.stringify(cfg, null, 2);
}

/** 开关层的事件绑定：开关 → 改写 JSON；JSON → 同步回开关 */
function conDataBindConfig() {
  var flagKeys = ['supports_smart_cube', 'record_steps', 'record_tps', 'record_video',
    'record_algorithm'];
  var ta = document.getElementById('cd-cfg-json');
  var note = document.getElementById('cd-cfg-note');

  flagKeys.forEach(function (k) {
    var el = document.getElementById('cd-cfg-' + k);
    if (!el) return;
    el.addEventListener('change', function () {
      CON_DATA.cfgDraft[k] = el.checked;
      if (!el.checked) delete CON_DATA.cfgDraft[k];
      conDataCfgWriteText();
    });
  });

  function collectTextFields() {
    var label = conVal('cd-cfg-attempt_id_label');
    if (label) CON_DATA.cfgDraft.attempt_id_label = label;
    else delete CON_DATA.cfgDraft.attempt_id_label;

    var maxA = conVal('cd-cfg-max_attempts');
    if (maxA !== '' && !isNaN(Number(maxA))) CON_DATA.cfgDraft.max_attempts = Number(maxA);
    else delete CON_DATA.cfgDraft.max_attempts;
  }

  ['cd-cfg-attempt_id_label', 'cd-cfg-max_attempts'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function () {
      collectTextFields();
      conDataCfgWriteText();
    });
  });

  if (ta) {
    ta.addEventListener('change', function () {
      var raw = ta.value.trim();
      if (!raw) {
        CON_DATA.cfgDraft = {};
        conDataCfgSyncFlags({});
        if (note) note.textContent = '留空表示该项目不设配置（继承父项目）。';
        return;
      }
      try {
        var parsed = JSON.parse(raw);
        CON_DATA.cfgDraft = (parsed && typeof parsed === 'object') ? parsed : {};
        conDataCfgSyncFlags(CON_DATA.cfgDraft);
        if (note) note.textContent = 'JSON 已读取，开关已同步。';
      } catch (e) {
        if (note) note.textContent = 'JSON 语法有误，暂未生效：' + e.message;
      }
    });
  }
}

function conDataCfgWriteText() {
  var ta = document.getElementById('cd-cfg-json');
  if (ta) ta.value = conDataCfgToText(CON_DATA.cfgDraft);
  var note = document.getElementById('cd-cfg-note');
  if (note) note.textContent = '开关已写进 JSON。留空表示该项目不设配置。';
}

function conDataCfgSyncFlags(cfg) {
  ['supports_smart_cube', 'record_steps', 'record_tps', 'record_video', 'record_algorithm']
    .forEach(function (k) {
      var el = document.getElementById('cd-cfg-' + k);
      if (el) el.checked = conCfgBool(cfg, k, false);
    });
  var label = document.getElementById('cd-cfg-attempt_id_label');
  if (label) label.value = conCfgStr(cfg, 'attempt_id_label');
  var maxA = document.getElementById('cd-cfg-max_attempts');
  if (maxA) maxA.value = conCfgStr(cfg, 'max_attempts');
}

function conDataFindRow(spec, id) {
  var list = CON_BASE[spec.key] || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/* ---------------- 收集与校验 ---------------- */

/**
 * 把表单读成一个待写入对象。
 * @returns {{body:object|null, err:string}}
 */
function conDataCollect(spec) {
  var body = {};
  for (var i = 0; i < spec.fields.length; i++) {
    var f = spec.fields[i];

    if (f.type === 'config') {
      var cfg = conDataReadConfig();
      if (cfg.err) return { body: null, err: cfg.err };
      // 空配置不写字段：让「没配置」和「配置成空对象」在库里是同一种状态
      if (Object.keys(cfg.value).length) body.event_config = cfg.value;
      else if (CON_DATA.editingId) body.event_config = {};
      continue;
    }

    var raw = conVal('cd-f-' + f.key);
    if (f.required && raw === '') {
      return { body: null, err: '「' + f.label + '」不能为空。' };
    }
    if (raw === '') {
      // 空值一律写 null 而不是空串：PostgREST 的空串会让「没填」和「填了空」分不开
      body[f.key] = null;
      continue;
    }
    if (f.type === 'number') {
      var n = Number(raw);
      if (!isFinite(n)) return { body: null, err: '「' + f.label + '」必须是数字。' };
      body[f.key] = n;
    } else {
      body[f.key] = raw;
    }
  }

  // is_sub_event 不让人手填：它完全由「有没有父项目」决定，
  // 同时暴露两者就会出现「设了父项目但标记为不是子项目」这种自相矛盾的数据
  if (spec.key === 'events') {
    body.is_sub_event = !!body.parent_event_id;
  }
  return { body: body, err: '' };
}

function conDataReadConfig() {
  var ta = document.getElementById('cd-cfg-json');
  var raw = ta ? ta.value.trim() : '';
  if (!raw) return { value: {}, err: '' };
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { value: null, err: '项目配置的 JSON 语法有误：' + e.message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, err: '项目配置必须是一个 JSON 对象（{ ... }）。' };
  }
  if (typeof EventConfig !== 'undefined' && EventConfig.validateConfig) {
    var v = EventConfig.validateConfig(parsed, 'event');
    if (!v.valid && v.errors.length) {
      return { value: null, err: '项目配置有问题：' + v.errors.join('；') };
    }
  }
  return { value: parsed, err: '' };
}

/* ---------------- 写入 ---------------- */

async function conDataSave(btn) {
  var spec = conDataSpec();
  conFormError('#cd-error', '');

  var c = conDataCollect(spec);
  if (c.err) { conFormError('#cd-error', c.err); return; }

  if (spec.precheck) {
    var dupMsg = spec.precheck(c.body, CON_DATA.editingId);
    if (dupMsg) { conFormError('#cd-error', dupMsg); return; }
  }

  var editing = !!CON_DATA.editingId;
  var res;
  if (editing) {
    res = await db(spec.table).update(c.body).eq('id', CON_DATA.editingId);
  } else {
    res = await db(spec.table).insert(c.body);
  }

  if (res.error) {
    conFormError('#cd-error', '保存失败：' + conDbFail(res));
    return;
  }

  await conLoadBase(true);
  CON_DATA.editingId = null;
  CON_DATA.cfgDraft = {};
  conDataRender();
  showAlert(editing ? (spec.label + '已保存') : (spec.label + '已新增'), 'success');
}

/** 重新读取（手动刷新按钮）。基础数据被别处改过时用得上 */
async function conDataReload() {
  await conLoadBase(true);
  conDataRender();
  var msg = conBaseError();
  if (msg) showAlert(msg, 'error');
}

function conDataEdit(key, id) {
  if (key && key !== CON_DATA.kind) CON_DATA.kind = key;
  CON_DATA.editingId = id;
  CON_DATA.pendingDelete = null;
  conDataRenderForm();
  conDataRenderList();
  var wrap = document.getElementById('cd-form-wrap');
  if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ block: 'nearest' });
  var first = document.querySelector('#cd-form input, #cd-form select, #cd-form textarea');
  if (first) first.focus();
}

function conDataCancelEdit() {
  CON_DATA.editingId = null;
  CON_DATA.cfgDraft = {};
  conDataRenderForm();
  conDataRenderList();
}

function conDataResetForm() {
  CON_DATA.editingId = null;
  CON_DATA.cfgDraft = {};
  conDataRender();
}

/* ---------------- 列表 ---------------- */

function conDataRenderList() {
  var spec = conDataSpec();
  var host = document.getElementById('cd-list');
  if (!host) return;

  var baseErr = conBaseError();
  if (baseErr && !CON_BASE.loaded) {
    conRenderError('#cd-list', baseErr, '连不上后端时这里不会有数据。确认网络后点右上角「重新读取」。');
    return;
  }
  if (!CON_BASE.loaded) {
    renderLoading('#cd-list', '正在读取基础数据…');
    return;
  }

  var rows = CON_BASE[spec.key] || [];
  if (!rows.length) {
    renderEmpty('#cd-list', '还没有' + spec.label, spec.emptyHint);
    return;
  }

  // 记录数撞到上界时必须说出来：不然「列表里找不到刚建的那条」会被当成 bug 排查很久
  var caption = conCountNote(rows.length, spec.limit, spec.noun) +
    (conHitLimit(rows, spec.limit) ? '，已达到读取上限，更早的记录没有显示' : '');

  var head = spec.columns.map(function (c) {
    return '<th scope="col"' + (c.num ? ' class="num"' : '') + '>' + escHtml(c.label) + '</th>';
  }).join('') + '<th scope="col">操作</th>';

  var body = rows.map(function (r) {
    var cells = spec.rowCells(r).map(function (c) {
      return '<td class="wrap-cell' + (c.cls ? ' ' + c.cls : '') + '">' + c.html + '</td>';
    }).join('');
    return '<tr>' + cells + '<td>' + conDataRowActions(spec, r) + '</td></tr>';
  }).join('');

  setHtml('#cd-list', conTable(caption, head, body));
}

function conDataRowActions(spec, r) {
  if (CON_DATA.pendingDelete === r.id) {
    return '<div class="con-confirm" role="alert">' +
      '<p class="con-confirm-text">确认删除？' + escHtml(spec.cascadeNote) + '此操作不可撤销。</p>' +
      '<div class="con-row-actions">' +
        conRowBtn('guard(this, conDataConfirmDelete)', '确认删除', 'danger') +
        conRowBtn('conDataCancelDelete()', '取消') +
      '</div>' +
    '</div>';
  }
  return conRowActions([
    conRowBtn('conDataEdit(\'' + escHtml(spec.key) + '\', \'' + escHtml(r.id) + '\')', '修改'),
    conRowBtn('conDataAskDelete(\'' + escHtml(r.id) + '\')', '删除', 'danger'),
  ]);
}

function conDataAskDelete(id) {
  CON_DATA.pendingDelete = id;
  conDataRenderList();
}

function conDataCancelDelete() {
  CON_DATA.pendingDelete = null;
  conDataRenderList();
}

async function conDataConfirmDelete(btn) {
  var id = CON_DATA.pendingDelete;
  if (!id) return;
  var spec = conDataSpec();
  var res = await db(spec.table).delete().eq('id', id);
  if (res.error) {
    // 删除受外键与 RLS 双重约束，失败原因值得原样带出来
    showAlert('删除失败：' + conDbFail(res), 'error');
    CON_DATA.pendingDelete = null;
    conDataRenderList();
    return;
  }
  CON_DATA.pendingDelete = null;
  if (CON_DATA.editingId === id) CON_DATA.editingId = null;
  await conLoadBase(true);
  conDataRender();
  showAlert(spec.label + '已删除', 'success');
}

/* ---------------- 挂载 ---------------- */

consoleRegister({
  id: 'data',
  label: '基础数据',
  minRole: 'editor',
  order: 40,
  desc: '比赛、项目、赛事项目、选手的增删改。成绩录在「赛事项目」上，所以这里是一切的前置。',
  mount: function (host) {
    host.innerHTML =
      '<div class="con-switch" id="cd-switch" role="group" aria-label="选择要维护的对象"></div>' +
      '<div id="cd-body" class="mt-5"></div>';
    conDataRender();
    // 首次进来时缓存可能还没读（比如直接深链到 ?tab=data）
    conLoadBase().then(function () {
      conDataRender();
      var msg = conBaseError();
      if (msg) showAlert(msg, 'error');
    });
  },
  onShow: function () {
    // 从录入/审核切回来时，表里可能已经被别处改过，重读一次再渲染
    conLoadBase(true).then(function () { conDataRender(); });
  },
});
