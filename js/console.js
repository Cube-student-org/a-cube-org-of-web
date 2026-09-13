/**
 * 管理台骨架：标签路由 + 身份条 + 「我的」
 *
 * 管理台是**单页多面板**的形态，和官网站（7 个独立 HTML）刻意不同，原因也刻意不同：
 * 官网站做多页是为了让章程能被收录、被分享、被打印；管理台不需要这些，
 * 它需要的是「登录后所有工作都在一屏之内，不用来回跳页」。所以这里用标签，
 * 但把当前标签写进 URL（?tab=review），刷新和发链接都还能定位。
 *
 * 加载顺序（见 console.html 底部的 script 列表）：
 *   … auth.js → site.js → console-core.js → console-data.js →
 *   console-attempts.js → console-users.js → console.js
 * console.js 必须最后：它读 CON_TABS（各模块注册进来的），并负责启动。
 *
 * 权限：本文件里每一处显隐都只是界面礼貌。真正的锁在数据库 RLS 与后端接口，
 * 改 DOM 绕不过去——所以本页的职责是「不让没有权限的人看到没用的入口」，
 * 而不是「靠隐藏来保护数据」。
 */

/** 「我的」面板的定义。它必须排在最前，所以没有走进注册表，而是由骨架自己接上 */
var CONSOLE_ME_TAB = {
  id: 'me',
  label: '我的',
  minRole: 'user',
  order: 10,
  desc: '你的身份、你提交过的成绩，以及昵称与密码。',
  mount: conMeMount,
  onShow: function () { conMeReload(); },
};

var CONSOLE_STATE = {
  current: '',        // 当前标签 id
  permKey: '',        // 当前角色可见的标签集合的指纹；变了就重建标签栏
  built: false,
};

/* ---------------- 标签集合 ---------------- */

/**
 * 标签按 order 排，不按注册顺序。
 * 注册顺序其实是脚本加载顺序（见 console.html 底部的 script 标签），
 * 那是「文件怎么引」的问题，不该决定用户看到的先后。
 */
function consoleAllTabs() {
  return [CONSOLE_ME_TAB].concat(CON_TABS).sort(function (a, b) {
    return (a.order == null ? 999 : a.order) - (b.order == null ? 999 : b.order);
  });
}

function consoleFindTab(id) {
  var all = consoleAllTabs();
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === id) return all[i];
  }
  return null;
}

function consolePermittedTabs() {
  return consoleAllTabs().filter(function (t) { return roleAtLeast(t.minRole); });
}

/* ---------------- 身份条 ---------------- */

/**
 * 身份条永远显示在标签栏之上：不管你在哪个功能区，都得能一眼看到
 * 「我现在是谁、什么角色」。角色被管理员改过之后这里会跟着变
 * （auth.js 在窗口获得焦点时从数据库重读角色）。
 */
function conRenderIdentity() {
  var host = document.getElementById('con-identity');
  if (!host) return;

  var p = currentProfile || {};
  var name = p.username || p.user_code || (currentUser ? currentUser.id.slice(0, 8) : '');
  var roleLabel = ROLE_LABELS[currentRole] || currentRole;

  host.innerHTML =
    '<div class="con-identity">' +
      '<div class="con-id-main">' +
        '<span class="con-id-name">' + escHtml(name) + '</span>' +
        '<span class="role-badge role-' + escHtml(currentRole) + '">' + escHtml(roleLabel) + '</span>' +
      '</div>' +
      '<p class="con-id-meta">' +
        '<span class="mono">' + escHtml(p.user_code || '（未读到用户ID）') + '</span>' +
        '<span class="con-id-sep">·</span>' + escHtml(ROLE_CAPS[currentRole] || '') +
      '</p>' +
      '<div class="con-id-actions">' +
        '<button type="button" class="link-btn" onclick="guard(this, conRefreshRole)">' +
          '重新读取角色</button>' +
      '</div>' +
    '</div>';
}

async function conRefreshRole(btn) {
  await refreshMyProfile();
  conRenderIdentity();
  showAlert('已从数据库重新读取：当前角色为' + (ROLE_LABELS[currentRole] || currentRole), 'info');
}

/* ---------------- 标签栏与面板 ---------------- */

function conBuildTabs() {
  var bar = document.getElementById('con-tabs');
  var panels = document.getElementById('con-panels');
  if (!bar || !panels) return;

  var list = consolePermittedTabs();
  var permKey = list.map(function (t) { return t.id; }).join(',');

  // 可见集合没变就什么都不做——applyRoleUI 会在每次角色同步时回调本页，
  // 每次都重建标签栏会把各面板里填到一半的表单清掉。
  if (CONSOLE_STATE.built && CONSOLE_STATE.permKey === permKey) {
    conSyncTabCounts();
    return;
  }
  CONSOLE_STATE.permKey = permKey;
  CONSOLE_STATE.current = '';
  CONSOLE_STATE.built = true;

  bar.innerHTML = list.map(function (t) {
    return '<button type="button" class="con-tab" id="con-tab-' + escHtml(t.id) + '"' +
      ' role="tab" aria-selected="false" data-tab="' + escHtml(t.id) + '"' +
      ' onclick="conShowTab(\'' + escHtml(t.id) + '\')">' +
      escHtml(t.label) +
      '<span class="con-count" id="con-count-' + escHtml(t.id) + '" hidden></span>' +
    '</button>';
  }).join('');

  panels.innerHTML = list.map(function (t) {
    return '<section class="con-panel" id="con-panel-' + escHtml(t.id) + '" ' +
      'role="tabpanel" aria-labelledby="con-tab-' + escHtml(t.id) + '" hidden>' +
      '<div class="con-panel-head">' +
        '<h2 class="con-panel-title">' + escHtml(t.label) + '</h2>' +
        (t.desc ? '<p class="con-panel-desc">' + escHtml(t.desc) + '</p>' : '') +
      '</div>' +
      '<div id="con-panel-body-' + escHtml(t.id) + '"></div>' +
    '</section>';
  }).join('');

  conSyncTabCounts();
}

/** 角标值可能先于标签栏到达（队列读取与标签构建是两个异步流程），所以每次构建后都补写一遍 */
function conSyncTabCounts() {
  Object.keys(CON_TAB_COUNTS).forEach(function (id) {
    conSetTabCount(id, CON_TAB_COUNTS[id]);
  });
}

/**
 * 切到某个标签。没有权限或标签不存在时返回 false，由调用方决定怎么办。
 * @param {string} id
 * @param {boolean} [skipUrl] 内部回退时用，避免把回退结果写进 URL
 */
function conShowTab(id, skipUrl) {
  var tab = consoleFindTab(id);
  if (!tab || !roleAtLeast(tab.minRole)) return false;

  CONSOLE_STATE.current = id;

  $$('#con-tabs .con-tab').forEach(function (b) {
    var on = b.getAttribute('data-tab') === id;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('#con-panels .con-panel').forEach(function (p) {
    p.hidden = (p.id !== 'con-panel-' + id);
  });

  var panel = document.getElementById('con-panel-' + id);
  if (!panel) return false;
  var body = document.getElementById('con-panel-body-' + id);
  if (!body) return false;

  if (!panel.dataset.mounted) {
    // 首次进入才挂载：一个角色可能看得到四个功能区，但一次只会用其中一个，
    // 没必要一进管理台就把四份数据都读一遍
    panel.dataset.mounted = '1';
    tab.mount(body);
  } else if (typeof tab.onShow === 'function') {
    tab.onShow();
  }

  if (!skipUrl) conSyncUrl(id);
  return true;
}

/** 把当前标签写进 URL。用 replaceState：切标签不该污染浏览器历史，否则后退键会退得很累 */
function conSyncUrl(id) {
  try {
    var url = new URL(location.href);
    url.searchParams.set('tab', id);
    history.replaceState(null, '', url.pathname + url.search);
  } catch (e) {
    // file:// 或老浏览器下 replaceState 可能不可用；切标签照常，只是 URL 不同步
  }
}

/** 当前标签不可见时（被降权）退到第一个可见标签，不让人干瞪一个空面板 */
function conEnsureVisibleTab() {
  var list = consolePermittedTabs();
  if (!list.length) return;
  var cur = consoleFindTab(CONSOLE_STATE.current);
  if (cur && roleAtLeast(cur.minRole)) return;

  // 优先保住 URL 里点名要看的那个（比如被降权后重新打开带 ?tab=review 的链接）
  var want = qsParam('tab');
  var target = null;
  if (want) {
    var wt = consoleFindTab(want);
    if (wt && roleAtLeast(wt.minRole)) target = wt;
  }
  if (!target) target = list[0];
  conShowTab(target.id, true);
}

/* ==========================================================================
   「我的」
   ========================================================================== */

var CON_ME = {
  attempts: [],
  limit: 50,
  loaded: false,
};

function conMeMount(host) {
  host.innerHTML =
    '<div class="con-two-col">' +
      '<div>' +
        '<h3 class="con-h3">我提交的成绩</h3>' +
        '<p class="con-note mt-3">' +
          '包含仍在待审核与已被驳回的。公开的成绩页只显示通过审核的部分，' +
          '所以这里通常比那边多。' +
        '</p>' +
        '<div id="cme-attempts" class="mt-4"></div>' +
      '</div>' +
      '<div>' +
        '<h3 class="con-h3">我的档案</h3>' +
        '<div class="card mt-4">' +
          '<form id="cme-nick-form" novalidate>' +
            conField('昵称',
              '<input class="input" id="cme-nick" type="text" ' +
              'placeholder="组织内部称呼或昵称" autocomplete="off">',
              '会公开显示在成绩页上。请勿填写真实姓名——按章程本组织不收集真实姓名。',
              { forId: 'cme-nick' }) +
          '</form>' +
          '<div class="form-error" id="cme-nick-error" role="alert" hidden></div>' +
          '<div class="btn-row mt-4">' +
            '<button type="submit" form="cme-nick-form" class="btn btn-primary btn-sm" ' +
              'id="cme-nick-submit">保存昵称</button>' +
          '</div>' +
        '</div>' +

        '<div class="card mt-4">' +
          '<h4 class="con-h4">修改密码</h4>' +
          '<form id="cme-pwd-form" novalidate>' +
            conField('新密码',
              '<input class="input" id="cme-pwd" type="password" ' +
              'autocomplete="new-password" placeholder="至少 6 位">', '',
              { forId: 'cme-pwd' }) +
            conField('再输一次',
              '<input class="input" id="cme-pwd2" type="password" ' +
              'autocomplete="new-password">', '',
              { forId: 'cme-pwd2' }) +
          '</form>' +
          '<div class="form-error" id="cme-pwd-error" role="alert" hidden></div>' +
          '<div class="btn-row mt-4">' +
            '<button type="submit" form="cme-pwd-form" class="btn btn-primary btn-sm" ' +
              'id="cme-pwd-submit">修改密码</button>' +
          '</div>' +
          '<p class="faint mt-3">' +
            '改完之后当前这台设备不用重新登录。如果怀疑账号被他人使用，' +
            '请同时在其他设备上退出登录。' +
          '</p>' +
        '</div>' +

        '<p class="faint mt-4">' +
          '用户ID与角色不能自行修改：前者是登录凭证，后者只有管理员能调整。' +
        '</p>' +
      '</div>' +
    '</div>';

  var nickForm = document.getElementById('cme-nick-form');
  if (nickForm) {
    nickForm.addEventListener('submit', function (e) {
      e.preventDefault();
      guard(document.getElementById('cme-nick-submit'), conMeSaveNickname);
    });
  }
  var pwdForm = document.getElementById('cme-pwd-form');
  if (pwdForm) {
    pwdForm.addEventListener('submit', function (e) {
      e.preventDefault();
      guard(document.getElementById('cme-pwd-submit'), conMeSavePassword);
    });
  }

  var nick = document.getElementById('cme-nick');
  if (nick) nick.value = (currentProfile && currentProfile.username) || '';

  // 先等基础数据到位再渲染列表：成绩行要显示「哪场比赛的哪个项目」，
  // 没有 CON_BASE 就只能显示「（比赛缺失）」，先渲染再刷新会闪一下假信息
  conLoadBase().then(conMeReload);
}

/** 重新读「我提交的成绩」。录入页提交成功、审核页处理完之后都会调它 */
async function conMeReload() {
  if (!currentUser) return;
  var host = document.getElementById('cme-attempts');
  if (!host) return;

  renderLoading('#cme-attempts', '读取中…');

  // RLS 允许提交者本人看到自己的 pending / rejected（attempts read 策略），
  // 所以这里不需要额外判断，也不需要"只查自己的已通过"这种绕法。
  var res = await db('attempts')
    .select('id,competition_event_id,participant_id,attempt_number,solve_time,' +
            'is_dnf,is_plus_two,is_dns,cube_type,status,created_at,reviewed_at,' +
            'scramble,move_count,tps,solve_steps,step_comments,video_url,notes')
    .eq('submitted_by', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(CON_ME.limit);

  if (res.error) {
    conRenderError('#cme-attempts', res.error.message, '点「我的」标签可以重试。');
    return;
  }

  CON_ME.attempts = res.data || [];
  CON_ME.loaded = true;

  if (!CON_ME.attempts.length) {
    renderEmpty('#cme-attempts', '你还没有提交过成绩',
      roleAtLeast('editor')
        ? '去「成绩录入」标签提交第一条。'
        : '你的角色是只读的，暂时没有提交成绩的权限。');
    return;
  }

  var head = ['赛事项目', '第几次', '成绩', '状态', '提交时间', '操作']
    .map(function (c) { return '<th scope="col">' + escHtml(c) + '</th>'; }).join('');

  var body = CON_ME.attempts.map(function (a) {
    var rejected = a.status === 'rejected';
    var action = '—';
    if (rejected && roleAtLeast('editor')) {
      // 被驳回的成绩在 RLS 下改不了（update 策略只放行 pending 或已通过的），
      // 所以这里的"改正"只能是重新提交一条。与其让人对着改不动的记录发呆，
      // 不如把那一条的数据搬进录入表单——重新录一遍最省事。
      action = conRowBtn('conMeReuse(\'' + escHtml(a.id) + '\')', '按它重新录入');
    } else if (rejected) {
      action = '<span class="faint">无权限重录</span>';
    } else if (a.status === 'pending') {
      action = '<span class="faint">等待审核</span>';
    } else {
      action = '<span class="faint">已公开</span>';
    }
    return '<tr>' +
      '<td class="wrap-cell">' + escHtml(conCeShort(CON_BASE.ceById[a.competition_event_id])) + '</td>' +
      '<td class="num">' + escHtml(a.attempt_number == null ? '—' : a.attempt_number) + '</td>' +
      '<td class="num">' + escHtml(formatAttemptTime(a)) + '</td>' +
      '<td>' + conStatusTag(a.status) + '</td>' +
      '<td class="faint">' + escHtml(conDateTime(a.created_at)) + '</td>' +
      '<td>' + action + '</td>' +
    '</tr>';
  }).join('');

  setHtml('#cme-attempts', conTable(
    '最近 ' + CON_ME.attempts.length + ' 条（最多读取 ' + CON_ME.limit + ' 条，按提交时间倒序）',
    head, body));
}

/** 把一条被驳回的成绩搬进录入表单，并切到录入标签 */
async function conMeReuse(id) {
  var row = null;
  CON_ME.attempts.forEach(function (a) { if (a.id === id) row = a; });
  if (!row) return;
  if (!conShowTab('entry')) {
    showAlert('你的角色没有成绩录入权限', 'error');
    return;
  }
  await conEntryPrefill(row);
}

async function conMeSaveNickname(btn) {
  conFormError('#cme-nick-error', '');
  var el = document.getElementById('cme-nick');
  var name = el ? String(el.value || '').trim() : '';
  if (!name) { conFormError('#cme-nick-error', '昵称不能为空。'); return; }

  // 只改 username。角色不在这个请求里——RLS 的 self update 策略虽然允许
  // 「角色不变」的自我更新，但把不需要的字段一起发过去只是徒增风险。
  var res = await db('profiles').update({
    username: name,
    updated_at: new Date().toISOString(),
  }).eq('id', currentUser.id);

  if (res.error) {
    conFormError('#cme-nick-error', '保存失败：' + conDbFail(res));
    return;
  }
  await refreshMyProfile();     // 让导航右侧与身份条一起换成新昵称
  conRenderIdentity();
  showAlert('昵称已更新', 'success');
}

async function conMeSavePassword(btn) {
  conFormError('#cme-pwd-error', '');
  var p1 = conVal('cme-pwd');
  var p2 = conVal('cme-pwd2');

  if (!p1 || p1.length < 6) { conFormError('#cme-pwd-error', '新密码至少 6 位。'); return; }
  if (p1 !== p2) { conFormError('#cme-pwd-error', '两次输入不一致。'); return; }

  var r = await callWorkerAuth('password', { new_password: p1 });
  if (!r.ok) {
    conFormError('#cme-pwd-error', '修改失败：' + ((r.error && r.error.message) || '请稍后重试'));
    return;
  }
  ['cme-pwd', 'cme-pwd2'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  showAlert('密码已修改', 'success');
}

/* ==========================================================================
   启动
   ========================================================================== */

/**
 * 由 auth.js 的 applyRoleUI() 在「会话确定后」以及「每次角色变化后」调用。
 * 必须是幂等的：它会被调用很多次，而每一次重建标签栏都会清掉用户填了一半的表单。
 */
function onRoleReady() {
  var loading = document.getElementById('console-loading');
  if (loading) loading.hidden = true;

  if (!currentUser) {
    var box = document.getElementById('console-loading-box');
    if (box) box.innerHTML = '';
    return;   // 未登录：门禁由 applyRoleUI 负责显示
  }

  conRenderIdentity();
  conBuildTabs();
  conEnsureVisibleTab();
}

document.addEventListener('DOMContentLoaded', function () {
  renderLoading('#console-loading-box', '正在确认会话…');
});
