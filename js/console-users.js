/**
 * 管理台 · 用户管理（仅管理员）
 *
 * 能做的三件事：
 *   ① 新建账号       POST /admin-create-user   用 service_role 建 auth.users 再补 profile
 *   ② 改角色         POST /assign-role        只能授「低于管理员」的角色
 *   ③ 改昵称         PATCH /api/profiles      管理员可改非管理员用户的昵称
 *
 * 三条服务端已经写死的限制，界面必须**如实呈现**，而不是先给个按钮再让人撞墙：
 *
 *   1. **不能创建管理员**。CREATE_ALLOWED_ROLES 只有 user/editor/reviewer。
 *      首位管理员只能按部署手册在 Supabase 里手动提升——这是鸡生蛋问题的标准解法，
 *      不是缺陷，所以这里要把「为什么没有管理员这个选项」写在界面上。
 *   2. **不能改自己的角色**。/assign-role 明确拒绝（userId === uid）。
 *      自己那一行的角色控件直接禁用并说明原因。
 *   3. **不能改其他管理员的角色**。仅靠 RLS 的 USING 就能挡住，
 *      服务端还额外判了一次。所以管理员那一行同样是禁用的。
 *
 * 另有一条只影响体验的：**本页不含删除账号**。删除 auth.users 需要另一条高权限路径，
 * 后端没有提供，所以界面也不做——留一个删不掉的按钮比没有按钮更糟。
 */

var CU_LIMIT = CON_LIMITS.profiles;
var CU = {
  rows: [],
  loaded: false,
  pendingName: '',   // 正在改昵称的那一行
};

/* ---------------- 读取 ---------------- */

function conUsersRender() {
  var host = document.getElementById('cu-body');
  if (!host) return;
  host.innerHTML =
    '<div id="cu-form-wrap"></div>' +
    '<div class="con-list-head">' +
      '<h3 class="con-h3">账号列表</h3>' +
      '<div class="con-toolbar-spacer"></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="guard(this, conUsersReload)">' +
        '重新读取</button>' +
    '</div>' +
    '<p class="con-note mt-3" id="cu-role-note"></p>' +
    '<div id="cu-list" class="mt-4"></div>';
  conUsersRenderForm();
  conUsersRenderList();
}

function conUsersRenderForm() {
  var host = document.getElementById('cu-form-wrap');
  if (!host) return;
  host.innerHTML =
    '<div class="card">' +
      '<h3 class="card-title">新建账号</h3>' +
      '<p class="card-body">' +
        '本组织不开放自助注册，账号一律由管理员在这里创建。' +
        '创建时给出的初始密码请通过可靠渠道转达本人，并提醒其登录后自行修改。' +
      '</p>' +
      '<form class="con-form-grid mt-5" id="cu-form" novalidate>' +
        conField('用户ID',
          '<input class="input" id="cu-code" type="text" placeholder="如 u00000002" ' +
          'autocomplete="off" autocapitalize="off" spellcheck="false">',
          '这是登录用的凭证，登录时填的就是它（不是邮箱）。' +
          '只能包含字母、数字、下划线，最长 32 位。',
          { required: true, forId: 'cu-code' }) +
        conField('昵称',
          '<input class="input" id="cu-name" type="text" placeholder="留空则与用户ID相同">',
          '公开展示用的名字。按章程不收集真实姓名，所以这里填组织内部称呼即可。',
          { forId: 'cu-name' }) +
        conField('初始密码',
          '<input class="input" id="cu-pass" type="text" placeholder="至少 6 位" ' +
          'autocomplete="off" spellcheck="false">',
          '明文显示是为了能复制给你要交给的人；输错一位就会多一次沟通成本。',
          { required: true, forId: 'cu-pass' }) +
        conField('角色',
          conSelect('cu-role', [
            { value: 'user', label: '普通用户（只读）' },
            { value: 'editor', label: '编辑员（可维护基础数据、录入成绩）' },
            { value: 'reviewer', label: '审核员（+ 审核他人提交的成绩）' },
          ], { selected: 'user' }),
          '管理员不在选项里：后端不允许由他人创建管理员，首位管理员需按部署手册在数据库里提升。',
          { required: true, forId: 'cu-role' }) +
      '</form>' +
      '<div class="form-error" id="cu-error" role="alert" hidden></div>' +
      '<div class="btn-row mt-5">' +
        '<button type="submit" form="cu-form" class="btn btn-primary" id="cu-submit">' +
          '创建账号</button>' +
      '</div>' +
    '</div>';

  var form = document.getElementById('cu-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      guard(document.getElementById('cu-submit'), conUsersCreate);
    });
  }
}

async function conUsersLoad() {
  var res = await db('profiles')
    .select('id,user_code,username,role,created_at,updated_at')
    .order('user_code')
    .limit(CU_LIMIT);
  if (res.error) {
    CU.loaded = false;
    return res.error.message;
  }
  CU.rows = res.data || [];
  // profiles 对匿名不可读（策略是 TO authenticated），所以未登录时这里会是空数组而不是报错。
  // 空数组 + 已登录 = 真的一个账号都没有，这种情况只会出现在全新部署的库里。
  CU.loaded = true;
  return '';
}

function conUsersRenderList() {
  var host = document.getElementById('cu-list');
  if (!host) return;

  var rows = CU.rows;
  var note = document.getElementById('cu-role-note');
  if (note) {
    var counts = { user: 0, editor: 0, reviewer: 0, admin: 0 };
    rows.forEach(function (r) { if (counts[r.role] != null) counts[r.role]++; });
    note.textContent =
      '共 ' + rows.length + ' 个账号：普通用户 ' + counts.user + '、编辑员 ' + counts.editor +
      '、审核员 ' + counts.reviewer + '、管理员 ' + counts.admin +
      '。（最多读取 ' + CU_LIMIT + ' 条）';
  }

  if (!rows.length) {
    renderEmpty('#cu-list', '没有读到任何账号',
      '如果这是刚部署的库，说明还没有账号——首位管理员需要按部署手册在数据库里手动创建并提升。');
    return;
  }

  var head = ['用户ID', '昵称', '角色', '创建时间', '操作']
    .map(function (c) { return '<th scope="col">' + escHtml(c) + '</th>'; }).join('');

  var body = rows.map(function (r) {
    var isMe = currentUser && r.id === currentUser.id;
    var isAdminRow = r.role === 'admin';
    return '<tr>' +
      '<td class="mono">' + escHtml(r.user_code || '—') +
        (isMe ? ' <span class="tag tag-info">你自己</span>' : '') + '</td>' +
      '<td class="wrap-cell">' + conUsersNameCell(r) + '</td>' +
      '<td>' + conUsersRoleCell(r, isMe, isAdminRow) + '</td>' +
      '<td class="faint">' + escHtml(conDateTime(r.created_at)) + '</td>' +
      '<td>' + conUsersRowActions(r, isMe, isAdminRow) + '</td>' +
    '</tr>';
  }).join('');

  setHtml('#cu-list', conTable(
    conCountNote(rows.length, CU_LIMIT, '个账号'), head, body));
}

/**
 * 昵称单元格。编辑态返回的是**真的** <input>，所以本函数返回的是 HTML 片段——
 * 调用方不要再 escHtml 一次，否则输入框会被当成文字显示出来（字面上就是
 * 屏幕上出现 <input class="input input-inline" …> 这么一串）。
 * 转义只在这里做，只对普通文本分支做。
 */
function conUsersNameCell(r) {
  if (CU.pendingName === r.id) {
    return '<input class="input input-inline" id="cu-name-' + escHtml(r.id) + '" type="text" ' +
      'value="' + escHtml(r.username || '') + '" placeholder="昵称">';
  }
  return r.username ? escHtml(r.username) : '<span class="faint">（未设置）</span>';
}

function conUsersRoleCell(r, isMe, isAdminRow) {
  if (isAdminRow) {
    return '<span class="role-badge role-admin">管理员</span>';
  }
  if (isMe) {
    return '<span class="role-badge role-' + escHtml(r.role) + '">' +
      escHtml(ROLE_LABELS[r.role] || r.role) + '</span>';
  }
  var opts = ['user', 'editor', 'reviewer'].map(function (role) {
    return { value: role, label: ROLE_LABELS[role] };
  });
  return conSelect('cu-role-' + r.id, opts, { selected: r.role });
}

function conUsersRowActions(r, isMe, isAdminRow) {
  if (CU.pendingName === r.id) {
    return conRowActions([
      conRowBtn('guard(this, conUsersSaveName)', '保存昵称', 'primary',
        ' data-user-id="' + escHtml(r.id) + '"'),
      conRowBtn('conUsersCancelName()', '取消'),
    ]);
  }

  // 顺序有讲究：isMe 必须排在 isAdminRow 前面。
  // 管理员看自己那一行时两个条件同时成立，先判 isAdminRow 会渲染出
  // 「管理员账号不可由他人修改」——话没错，但答非所问：他点不下去的真正原因是
  // 「不能改自己」，而不是「不能改管理员」。
  if (isMe) {
    return '<span class="faint">改自己的角色请找另一位管理员</span>';
  }
  if (isAdminRow) {
    return '<span class="faint">管理员账号不可由他人修改</span>';
  }
  return conRowActions([
    conRowBtn('guard(this, conUsersApplyRole)', '应用角色', 'primary',
      ' data-user-id="' + escHtml(r.id) + '"'),
    conRowBtn('conUsersAskName(\'' + escHtml(r.id) + '\')', '改昵称'),
  ]);
}

/* ---------------- 写入 ---------------- */

async function conUsersCreate(btn) {
  conFormError('#cu-error', '');
  var code = conVal('cu-code');
  var name = conVal('cu-name');
  var pass = conVal('cu-pass');
  var role = conVal('cu-role');

  if (!code) { conFormError('#cu-error', '用户ID不能为空。'); return; }
  if (!/^[A-Za-z0-9_]{1,32}$/.test(code)) {
    // 这条规则服务端也有，但本地先拦一次能省一个来回，且提示更即时
    conFormError('#cu-error', '用户ID只能包含字母、数字、下划线，最长 32 位。');
    return;
  }
  if (!pass || pass.length < 6) { conFormError('#cu-error', '初始密码至少 6 位。'); return; }
  if (!role) { conFormError('#cu-error', '请选择角色。'); return; }

  var r = await conCall('/admin-create-user', {
    user_code: code,
    password: pass,
    role: role,
    nickname: name || code,
  });
  if (!r.ok) {
    conFormError('#cu-error', '创建失败：' + r.message);
    return;
  }

  ['cu-code', 'cu-name', 'cu-pass'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  await conUsersReload();
  showAlert('账号 ' + code + ' 已创建，角色为' + (ROLE_LABELS[role] || role), 'success');
}

async function conUsersApplyRole(btn) {
  var id = btn && btn.dataset ? btn.dataset.userId : '';
  if (!id) return;
  var sel = document.getElementById('cu-role-' + id);
  if (!sel) return;
  var role = sel.value;

  var r = await conCall('/assign-role', { userId: id, role: role });
  if (!r.ok) {
    showAlert('改角色失败：' + r.message, 'error');
    // 失败时列表可能与库里不一致（比如目标用户已被删除），重读一次再显示
    await conUsersReload();
    return;
  }
  await conUsersReload();
  showAlert('角色已改为' + (ROLE_LABELS[role] || role), 'success');
}

function conUsersAskName(id) {
  CU.pendingName = id;
  conUsersRenderList();
  var el = document.getElementById('cu-name-' + id);
  if (el) el.focus();
}

function conUsersCancelName() {
  CU.pendingName = '';
  conUsersRenderList();
}

async function conUsersSaveName(btn) {
  var id = btn && btn.dataset ? btn.dataset.userId : '';
  if (!id) return;
  var el = document.getElementById('cu-name-' + id);
  if (!el) return;
  var name = String(el.value || '').trim();

  // 昵称只改 username 一个字段。RLS 的 profiles admin update 策略检查的是
  // 「目标行的 role <> 'admin'」，所以带着 role 一起发是没必要的，反而增加风险：
  // 万一 role 写错，等于顺手改了别人的权限。
  var res = await db('profiles').update({
    username: name || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);

  if (res.error) {
    showAlert('改昵称失败：' + conDbFail(res), 'error');
    return;
  }
  CU.pendingName = '';
  await conUsersReload();
  showAlert('昵称已更新', 'success');
}

async function conUsersReload(btn) {
  var err = await conUsersLoad();
  conUsersRender();
  if (err) showAlert('读取账号列表失败：' + err, 'error');
}

/* ---------------- 挂载 ---------------- */

consoleRegister({
  id: 'users',
  label: '用户管理',
  minRole: 'admin',
  order: 50,
  desc: '创建账号、分配角色、修改昵称。管理员账号不可由他人创建或修改。',
  mount: function (host) {
    host.innerHTML = '<div id="cu-body"></div>';
    conUsersReload();
  },
  onShow: function () {
    conUsersReload();
  },
});
