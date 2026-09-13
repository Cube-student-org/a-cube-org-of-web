/**
 * 管理台公共层
 *
 * 管理台是**成员工具**，不是公开页面。它与官网的关系只有一条：
 * 同一套设计令牌、同一套约定（动态数据进 innerHTML 前过 escHtml、
 * 写操作按钮走 guard、反馈走 toast）。除此之外它有自己的组织方式。
 *
 * 这一层放三样东西，别的文件不许各写一份：
 *   1. **功能区注册表**。各模块自己 register，骨架（console.js）负责显隐、路由与挂载。
 *      好处是「加一个功能区」= 加一个 js 文件 + 在 console.html 里多一行 script，
 *      骨架与 HTML 都不用改。
 *   2. **只读基础数据的缓存**。比赛 / 项目 / 赛事项目 / 选手这四张表，
 *      录入、审核、基础数据三个功能区全都要用。分头去读会读成四份互相不一致的快照
 *      （比如刚建完项目，录入页的下拉框里还没有），所以只在这里读一次、集中失效。
 *   3. 与后端打交道的封装：限额、写操作、错误文案。
 *
 * ⚠️ 三条从 api.js 继承下来的硬约束（改这里的查询之前先读）
 *   · **取不到精确总数**：后端不转发 Prefer: count=exact → 一律「取回数组再 .length」。
 *   · **没有分页**：Range / Content-Range 同样不转发 → 每个查询都要显式 .limit()，
 *     并且把上界写进界面文案。撞到上界时给提示，不假装拿到的是全量。
 *   · **读失败不 throw 到顶层**：db() 返回 {data, error}，就地显示错误比让整页崩掉好。
 *
 * ⚠️ 权限：本层所有显隐判断都只是**界面礼貌**。真正的边界是数据库 RLS 与后端接口
 *    （提交状态由服务端定、防自审写在触发器里、角色只能授低于管理员的）。
 *    改 DOM 绕不过去。所以本层的责任不是「防住越权」，而是**让服务端拒绝时
 *    用户看到的是人话**，而不是一个静默失败或一句英文报错。
 */

/* ---------------- 读取上界 ----------------
 * 每个数字都直接出现在界面文案里（「最多读取 N 条」）。
 * 取值刻意都在四位以内：PostgREST 服务端默认单次返回上限通常是 1000，
 * 要得比它多不会报错，只会静默截断——那种「看起来成功了但少了数据」最难查。
 */
var CON_LIMITS = {
  competitions: 200,
  events: 200,
  competitionEvents: 500,
  participants: 1000,
  attempts: 200,
  profiles: 300,
};

/* ---------------- 功能区注册表 ---------------- */

/** 已注册的功能区，顺序即标签栏顺序（「我的」由骨架自己放最前） */
var CON_TABS = [];

/**
 * 注册一个功能区。由 console-data.js / console-attempts.js / console-users.js 调用，
 * 必须在 console.js 之前加载。
 *
 * @param {object} mod
 * @param {string} mod.id        锚 id，同时作为 ?tab= 的值
 * @param {string} mod.label     标签文字
 * @param {string} mod.minRole   可见所需的最低角色（anon/user/editor/reviewer/admin）
 * @param {string} [mod.desc]    面板顶部的一句话说明
 * @param {number} [mod.order]   标签栏里的位置（小的在前）。不写就排在最后。
 * @param {Function} mod.mount   首次进入时调用一次，参数是面板的 body 容器元素
 * @param {Function} [mod.onShow] 之后每次切回来时调用（可选，用于刷新列表）
 *
 * 位置为什么要显式写：标签栏原本按脚本加载顺序排，于是「基础数据」跑到了
 * 「成绩录入」前面——因为 console-data.js 先加载。但人的使用顺序是
 * 录入 → 审核 → 维护基础数据，加载顺序跟这个没有任何关系，
 * 让它决定界面顺序只会一改文件顺序就悄悄变样。
 */
function consoleRegister(mod) {
  if (!mod || !mod.id || typeof mod.mount !== 'function') return;
  CON_TABS.push(mod);
}

/* ---------------- 只读基础数据缓存 ---------------- */

var CON_BASE = {
  loaded: false,
  loading: null,   // 进行中的 Promise，避免两个功能区同时进来读两遍
  error: null,
  competitions: [],
  events: [],
  ces: [],
  participants: [],
  // id → 记录。列表不长，建索引是为了让「查一条」不必线性扫（渲染表格时会反复查）
  compById: {},
  eventById: {},
  ceById: {},
  partById: {},
};

/* ---------------- 标签角标 ----------------
 * 待审队列的条数显示在标签上：审核员打开管理台第一眼要知道「有没有活要干」，
 * 不该让他点进去才发现。
 * 值先记在 CON_TAB_COUNTS 里，这样即使标签栏还没建出来，计数也不会丢——
 * 审核队列的读取和标签栏的构建是两个异步流程，谁先到都不该丢信息。
 */
var CON_TAB_COUNTS = {};

function conSetTabCount(id, n) {
  CON_TAB_COUNTS[id] = n || 0;
  var el = document.getElementById('con-count-' + id);
  if (!el) return;
  var has = (n || 0) > 0;
  el.textContent = has ? String(n) : '';
  el.hidden = !has;
}

/** 记录是否撞到读取上界——撞到了就得在界面上说出来 */
function conHitLimit(rows, limit) {
  return Array.isArray(rows) && rows.length >= limit;
}

/**
 * 「共 N 条（最多读取 M 条）」这种口径说明，全站统一由这里生成。
 * noun 是带量词的完整词组（'场比赛' / '个账号' / '条'），直接接在数字后面——
 * 不要在这里再补一个「条」，否则会拼出「共 6 条个账号」。
 */
function conCountNote(n, limit, noun) {
  return '共 ' + n + (noun || '条') + '（最多读取 ' + limit + ' 条）';
}

/**
 * 读取并缓存四张基础表。四种数据一起读（Promise.all），因为它们之间要互相拼标签。
 * 读失败时不抛异常，只把错误记在 CON_BASE.error 上——调用方统一用 conBaseError() 判断。
 *
 * @param {boolean} [force] 强制重读（新增/删除基础数据后必须 force，否则界面还拿着旧快照）
 * @returns {Promise<object>} CON_BASE
 */
async function conLoadBase(force) {
  if (CON_BASE.loaded && !force) return CON_BASE;
  if (CON_BASE.loading) return CON_BASE.loading;

  CON_BASE.loading = (async function () {
    var jobs = [
      db('competitions')
        .select('id,competition_number,name,competition_date,location,notes')
        .order('competition_number', { ascending: false })
        .limit(CON_LIMITS.competitions),
      db('events')
        .select('id,event_code,event_name,description,parent_event_id,is_sub_event,' +
                'event_config,algorithm_config,sort_order')
        .order('sort_order')
        .limit(CON_LIMITS.events),
      db('competition_events')
        .select('id,competition_id,event_id,event_number')
        .limit(CON_LIMITS.competitionEvents),
      db('participants')
        .select('id,name,wca_id')
        .order('name')
        .limit(CON_LIMITS.participants),
    ];
    var out = await Promise.all(jobs);
    var names = ['比赛', '项目', '赛事项目', '选手'];
    for (var i = 0; i < out.length; i++) {
      if (out[i].error) throw new Error('读取' + names[i] + '失败：' + out[i].error.message);
    }
    return out;
  })();

  try {
    var res = await CON_BASE.loading;
    CON_BASE.competitions = res[0].data || [];
    CON_BASE.events = res[1].data || [];
    CON_BASE.ces = res[2].data || [];
    CON_BASE.participants = res[3].data || [];

    CON_BASE.compById = conIndex(CON_BASE.competitions);
    CON_BASE.eventById = conIndex(CON_BASE.events);
    CON_BASE.ceById = conIndex(CON_BASE.ces);
    CON_BASE.partById = conIndex(CON_BASE.participants);
    CON_BASE.loaded = true;
    CON_BASE.error = null;
  } catch (e) {
    CON_BASE.error = e && e.message ? e.message : '读取基础数据失败';
  } finally {
    CON_BASE.loading = null;
  }
  return CON_BASE;
}

/** 列表 → {id: 记录} */
function conIndex(rows) {
  var map = {};
  (rows || []).forEach(function (r) { if (r && r.id) map[r.id] = r; });
  return map;
}

/** 基础数据是否读失败；失败时返回给用户看的一句话，成功返回空串 */
function conBaseError() {
  return CON_BASE.error || '';
}

/* ---------------- 标签文案 ---------------- */

/** 比赛标签：「#3 校运会」；编号缺失时不留孤零零的井号 */
function conCompLabel(c) {
  if (!c) return '（比赛缺失）';
  var no = (c.competition_number == null) ? '' : '#' + c.competition_number + ' ';
  return no + (c.name || '未命名赛事');
}

/** 项目标签：只有名字，代码放括号里（代码是给内部用的，不是给人读的） */
function conEventLabel(e) {
  if (!e) return '（项目缺失）';
  return (e.event_name || '未命名项目') + (e.event_code ? '（' + e.event_code + '）' : '');
}

/**
 * 赛事项目（比赛 + 项目的组合）标签。这是管理与录入时最常选的东西，
 * 所以格式统一为「比赛 · 项目」，并且比赛带编号——同一个项目在校运会和期末赛里
 * 是两条不同的记录，不给编号会分不清。
 */
function conCeLabel(ce) {
  if (!ce) return '（赛事项目缺失）';
  var comp = CON_BASE.compById[ce.competition_id];
  var ev = CON_BASE.eventById[ce.event_id];
  return conCompLabel(comp) + ' · ' + (ev ? (ev.event_name || '未命名项目') : '（项目缺失）');
}

/** 赛事项目的短标签，用于表格里 */
function conCeShort(ce) {
  if (!ce) return '—';
  var comp = CON_BASE.compById[ce.competition_id];
  var ev = CON_BASE.eventById[ce.event_id];
  var compName = comp ? (comp.name || '未命名赛事') : '（比赛缺失）';
  var evName = ev ? (ev.event_name || '未命名项目') : '（项目缺失）';
  return compName + ' · ' + evName;
}

function conCubeTypeLabel(t) {
  if (t === 'smart') return '智能魔方';
  if (t === 'non_smart') return '普通魔方';
  return t || '—';
}

var CON_STATUS_LABEL = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
var CON_STATUS_CLASS = { pending: 'tag-warn', approved: 'tag-success', rejected: 'tag-danger' };

function conStatusTag(status) {
  return '<span class="tag ' + (CON_STATUS_CLASS[status] || 'tag-neutral') + '">' +
    escHtml(CON_STATUS_LABEL[status] || status || '—') + '</span>';
}

/** ISO 时间 → 本地「2026-09-13 21:04」，只用于管理台内部记录，不做自然语言化 */
function conDateTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------------- 项目配置（含父链合并） ---------------- */

/**
 * 取项目的完整配置：沿 parent_event_id 一路向上合并，子项目覆盖父项目同名键。
 *
 * 这件事数据库里有现成的函数 get_event_full_config()，但它是个 SQL 函数、
 * 只能通过 PostgREST 的 /rpc/ 调用，而本项目的后端代理只转发 /rest/v1/ 表接口
 * （见 worker.js 的 apiProxy）。所以这里在内存里做同一件事：
 * events 表本来就要整个读进来（基础数据维护要列表），合并只是顺手走一遍父链。
 *
 * 与数据库实现的两点差异，都是刻意的：
 *   1. 遇到环就停（最多走 20 层）。数据库那边靠触发器禁止成环，但界面不能假设
 *      线上数据一定是干净的——真成环了也只是配置不完整，不该让页面卡死。
 *   2. 子项目显式写了 inherit_from_parent: false 时，只用自己的配置。
 *
 * @param {object} ev events 表的一行
 * @returns {object} 合并后的配置对象（可能是空对象）
 */
function conEventConfig(ev) {
  if (!ev) return {};
  var own = conAsObject(ev.event_config);
  if (own.inherit_from_parent === false) return own;

  var chain = [];
  var cur = ev;
  var hops = 0;
  while (cur && hops < 20) {
    chain.unshift(cur);
    cur = cur.parent_event_id ? CON_BASE.eventById[cur.parent_event_id] : null;
    hops++;
  }

  var out = {};
  chain.forEach(function (e) {
    var cfg = conAsObject(e.event_config);
    Object.keys(cfg).forEach(function (k) {
      if (k === 'inherit_from_parent') return;
      out[k] = cfg[k];
    });
  });
  return out;
}

/** JSONB 字段理论上回来就是对象，但导入口手工填的字符串也认，免得整页报错 */
function conAsObject(v) {
  if (!v) return {};
  if (typeof v === 'string') {
    try { var o = JSON.parse(v); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  return (typeof v === 'object') ? v : {};
}

/** 配置项读布尔：没设过就返回 fallback（默认放行，即「没配置 = 全部显示」） */
function conCfgBool(cfg, key, fallback) {
  if (!cfg || cfg[key] === undefined || cfg[key] === null || cfg[key] === '') return fallback;
  var v = cfg[key];
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}

/** 配置项读字符串：没设过返回空串 */
function conCfgStr(cfg, key) {
  if (!cfg || cfg[key] === undefined || cfg[key] === null) return '';
  return String(cfg[key]);
}

/* ---------------- 表单小工具 ---------------- */

/** <option>；value 与 text 都转义 */
function conOption(value, text, selected) {
  return '<option value="' + escHtml(value) + '"' + (selected ? ' selected' : '') + '>' +
    escHtml(text) + '</option>';
}

/** 读取输入值（trim 过），控件不存在时返回空串 */
function conVal(id) {
  var el = document.getElementById(id);
  return el ? String(el.value == null ? '' : el.value).trim() : '';
}

/** 读取数字输入：空串 → null；非法 → NaN（调用方据此报错，别把 NaN 发出去） */
function conNum(id) {
  var s = conVal(id);
  if (s === '') return null;
  return Number(s);
}

function conChecked(id) {
  var el = document.getElementById(id);
  return !!(el && el.checked);
}

/**
 * 就地显示表单错误。管理台每个表单都有自己的错误位——校验信息要贴着它说明的
 * 那个表单，弹到页面顶部的 toast 反而会让人找不到是哪里填错了。
 * @param {string|Element} target 选择器或元素本身
 */
function conFormError(target, msg) {
  var el = (target && typeof target === 'string') ? $(target) : target;
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = msg;
  el.hidden = false;
}

/**
 * 一个字段的完整包装：标签 + 控件 + 提示。
 *
 * 用 <div> 包而不是 <label> 包，是因为有几个字段的「控件」本身就是一组
 * 单选框或复选框（各自带 <label>）。label 套 label 是非法结构，
 * 点一下里面的勾选框会连带触发外层，行为会变得莫名其妙。
 * 需要关联时由调用方给 forId，生成 <label for=...>，可访问性一样成立。
 *
 * @param {string} labelText
 * @param {string} controlHtml
 * @param {string} [hint]
 * @param {{span?:number, required?:boolean, hide?:boolean, id?:string, forId?:string}} [opts]
 */
function conField(labelText, controlHtml, hint, opts) {
  opts = opts || {};
  var labOpen = opts.forId
    ? '<label class="label" for="' + escHtml(opts.forId) + '">'
    : '<span class="label">';
  return '<div class="con-field' + (opts.span ? ' con-span-' + opts.span : '') +
      (opts.hide ? ' con-off' : '') + '"' + (opts.id ? ' id="' + escHtml(opts.id) + '"' : '') + '>' +
    labOpen + escHtml(labelText) +
      (opts.required ? '<span class="con-req" aria-hidden="true">必填</span>' : '') +
    (opts.forId ? '</label>' : '</span>') +
    controlHtml +
    (hint ? '<span class="hint">' + escHtml(hint) + '</span>' : '') +
  '</div>';
}

/**
 * 生成一个 <select>。items 是 [{value, label}]；带 group 的用 optgroup 分组
 * （选赛事项目时必须分组：比赛一多，平铺的下拉框就没法用）。
 * @param {string} id
 * @param {Array} items
 * @param {{placeholder?:string, selected?:string, groups?:boolean}} [opts]
 */
function conSelect(id, items, opts) {
  opts = opts || {};
  var inner = '';
  if (opts.placeholder) inner += conOption('', opts.placeholder, false);

  if (opts.groups) {
    var order = [];
    var byGroup = {};
    items.forEach(function (it) {
      var g = it.group || '';
      if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(it);
    });
    order.forEach(function (g) {
      var body = byGroup[g].map(function (it) {
        return conOption(it.value, it.label, it.value === opts.selected);
      }).join('');
      inner += g ? '<optgroup label="' + escHtml(g) + '">' + body + '</optgroup>' : body;
    });
  } else {
    inner += items.map(function (it) {
      return conOption(it.value, it.label, it.value === opts.selected);
    }).join('');
  }
  return '<select class="select" id="' + escHtml(id) + '">' + inner + '</select>';
}

/* ---------------- 写操作 ---------------- */

/**
 * 调用后端专用端点（/submit-attempt、/review-attempt、/assign-role、/admin-create-user）。
 * 统一成 {ok, message, data}：
 *   · ok=false 时 message 一定是能直接显示给人看的中文
 *   · 401/403 额外补一句该做什么（这两种最容易被误判成「网站坏了」）
 *
 * @param {string} path
 * @param {object} body
 * @returns {Promise<{ok:boolean, message:string, data:object|null}>}
 */
async function conCall(path, body) {
  var r = await callWorker(path, body);
  if (r.ok) return { ok: true, message: '', data: r.data || null };
  var msg = (r.error && r.error.message) || ('请求失败(' + r.status + ')');
  return { ok: false, message: conFailHint(r.status, msg), data: r.data || null };
}

/** 通用数据代理（db()）的写操作也走同一套文案 */
function conDbFail(res) {
  if (!res || !res.error) return '失败原因未知';
  return conFailHint(res.error.status, res.error.message);
}

function conFailHint(status, msg) {
  if (status === 401) return '登录状态已失效，请重新登录后重试。';
  if (status === 403) {
    return msg + '（若你的角色刚被调整，刷新页面即可读到新角色）';
  }
  if (status === 409) return msg;
  return msg;
}

/** 写操作成功/失败统一反馈。成功用 toast，失败也用 toast，但把服务端原话带上 */
function conDone(ok, okMsg, failMsg) {
  if (ok) showAlert(okMsg, 'success');
  else showAlert(failMsg, 'error');
}

/* ---------------- 读取表格的通用渲染 ---------------- */

/**
 * 包一层表格外壳。管理台的表格都要能横向滚动（列多），
 * 所以统一用 .table-wrap，并给一个 caption 说明条数与口径。
 */
function conTable(caption, headHtml, bodyHtml) {
  return '<div class="table-wrap"><table class="table">' +
    (caption ? '<caption>' + caption + '</caption>' : '') +
    '<thead><tr>' + headHtml + '</tr></thead>' +
    '<tbody>' + bodyHtml + '</tbody>' +
  '</table></div>';
}

/** 表格里的行内操作按钮。
 * @param {string} onclick 行内事件（会被转义，属性里用 &#39; 表示单引号）
 * @param {string} label
 * @param {string} [kind] 'danger' | 'primary' | 省略 = ghost
 * @param {string} [attrs] 附加属性，如 ' data-attempt-id="…"'。
 *   行内事件里再拼一个 uuid 参数要多一层引号转义，多一层就多一处出错的地方；
 *   把值挂在 data-* 上、函数自己从按钮上取，是更稳的写法。
 */
function conRowBtn(onclick, label, kind, attrs) {
  return '<button type="button" class="btn btn-sm ' +
    (kind === 'danger' ? 'btn-danger-quiet' : (kind === 'primary' ? 'btn-primary' : 'btn-ghost')) +
    '"' + (attrs || '') + ' onclick="' + escHtml(onclick) + '">' + escHtml(label) + '</button>';
}

function conRowActions(btns) {
  return '<div class="con-row-actions">' + btns.join('') + '</div>';
}

/**
 * 渲染一个功能区的读取失败。集中在这里是为了保证「失败」永远包含三件事：
 * 人话、原因、下一步。少任何一件，用户都会以为是自己点错了。
 */
function conRenderError(sel, msg, nextStep) {
  setHtml(sel, '<div class="state state-error" role="alert">' +
    '<p class="state-title">数据没有读出来</p>' +
    '<p class="state-hint">' + escHtml(msg) + '</p>' +
    (nextStep ? '<p class="state-hint">' + escHtml(nextStep) + '</p>' : '') +
  '</div>');
}
