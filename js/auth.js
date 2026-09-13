/**
 * 认证与角色
 *
 * 五级线性角色（rank 越大权限越高）：匿名 0 → 普通用户 1 → 编辑员 2 → 审核员 3 → 管理员 4
 *
 * 这里做的角色判断只是「界面礼貌」——决定菜单显不显示。
 * 真正的权限边界在数据库 RLS 与云函数，改 DOM 绕不过（C2）。
 *
 * 账号信息完全信任数据库：角色被管理员改了，用户切回页面即生效，不需要重新登录。
 */

var ROLE_RANK = { anon: 0, user: 1, editor: 2, reviewer: 3, admin: 4 };
var ROLE_LABELS = {
  anon: '匿名用户',
  user: '普通用户',
  editor: '编辑员',
  reviewer: '审核员',
  admin: '管理员',
};
/** 每个角色「能做什么」的一句话说明，用于管理台的身份卡 */
var ROLE_CAPS = {
  anon: '只读：可以查看所有已通过审核的成绩。',
  user: '只读：可以查看所有已通过审核的成绩。',
  editor: '可维护比赛 / 项目 / 选手，可录入成绩（进入待审核，过审后生效）。',
  reviewer: '可维护基础数据、录入成绩，并审核他人提交的成绩（自己录的同样需要他人审）。',
  admin: '可直接录入生效成绩、审核成绩、创建账号与分配角色（不能授予管理员）。',
};

var currentUser = null;      // 会话中的用户对象
var currentProfile = null;   // profiles 表记录
var currentRole = 'anon';    // 当前角色

/* ---------------- 角色判断 ---------------- */

function roleAtLeast(role) { return (ROLE_RANK[currentRole] || 0) >= (ROLE_RANK[role] || 0); }
function isEditorOrAbove() { return roleAtLeast('editor'); }
function isReviewerOrAbove() { return roleAtLeast('reviewer'); }
function isAdmin() { return currentRole === 'admin'; }

/* ---------------- 初始化 ---------------- */

/**
 * 恢复会话。页面加载时调用一次。
 * @returns {Promise<void>}
 */
async function initAuth() {
  await setAuthUser(session.user() || null);

  // 账号信息完全信任数据库：窗口聚焦时同步一次（切回页面即生效，最及时）
  window.addEventListener('focus', function () { refreshMyProfile(); });
  // 兜底轮询放宽到 5 分钟（角色变更靠 focus 即可即时生效，无需高频轮询）
  setInterval(function () { refreshMyProfile(); }, 300000);
}

/**
 * 从数据库重新读取当前用户的资料与角色。数据库是唯一可信来源。
 */
async function refreshMyProfile() {
  if (!currentUser) return;
  var res = await db('profiles').select('*').eq('id', currentUser.id).maybeSingle();
  if (res.error || !res.data) return;

  var profile = res.data;
  var newRole = profile.role || 'user';
  var roleChanged = newRole !== currentRole;
  var nameChanged = !currentProfile ||
    currentProfile.username !== profile.username ||
    currentProfile.user_code !== profile.user_code;

  currentProfile = profile;
  currentRole = newRole;

  // 只有角色 / 昵称真的变了才重渲染，避免每次轮询都无谓写 DOM
  if (roleChanged || nameChanged) renderAuthUI();
  if (roleChanged) applyRoleUI();
}

/**
 * 设置当前用户并加载其角色。
 * @param {object|null} user 会话中的 user 对象
 */
async function setAuthUser(user) {
  currentUser = user || null;
  currentProfile = null;
  currentRole = 'anon';

  if (currentUser) {
    var res = await db('profiles').select('*').eq('id', currentUser.id).maybeSingle();
    if (!res.error && res.data) {
      currentProfile = res.data;
      currentRole = res.data.role || 'user';
    } else {
      // profile 尚未由触发器创建（或读取失败），按普通用户对待，不给任何额外权限
      currentRole = 'user';
    }
  }

  renderAuthUI();
  applyRoleUI();
}

/* ---------------- 登录 / 登出 ---------------- */

/** 成员须知同意记录的存储键。只记在本机，不含任何身份信息 */
var MEMBER_TERMS_KEY = 'wb_member_terms';

function memberTermsRecord() {
  try {
    var raw = localStorage.getItem(MEMBER_TERMS_KEY);
    if (!raw) return null;
    var o = JSON.parse(raw);
    return (o && typeof o.v === 'number') ? o : null;
  } catch (e) {
    return null;
  }
}

/**
 * 这个用户ID 在本机是否已同意过当前版本的成员须知。
 * 用登录ID（而非 uuid）作键，因为那才是用户认知里的「账号」；
 * 比较时统一转小写，与后端「大小写都能登录」的行为保持一致。
 */
function memberTermsAgreedFor(code) {
  if (typeof MEMBER_TERMS === 'undefined') return false;
  var r = memberTermsRecord();
  if (!r || r.v !== MEMBER_TERMS.version) return false;
  return String(r.uid || '').toLowerCase() === String(code || '').trim().toLowerCase();
}

function memberTermsSave(code) {
  if (typeof MEMBER_TERMS === 'undefined') return;
  try {
    localStorage.setItem(MEMBER_TERMS_KEY, JSON.stringify({
      v: MEMBER_TERMS.version,
      uid: String(code || '').trim(),
      at: Date.now(),
    }));
  } catch (e) {
    // 存不下来只会导致下次再问一遍，不影响这次登录
  }
}

/** 登录错误就地提示：显示在表单正下方，并把焦点移回用户ID框 */
function showAuthError(msg) {
  var box = document.getElementById('auth-error');
  if (!box) { showAlert(msg, 'error'); return; }
  box.textContent = msg;
  box.hidden = false;
  var code = document.getElementById('auth-code');
  if (code) code.focus();
}

function clearAuthError() {
  var box = document.getElementById('auth-error');
  if (box) { box.hidden = true; box.textContent = ''; }
}

/**
 * 登录。用户填的是「用户ID」（如 u00000001），不是邮箱——
 * code → code@cube.local 的映射在服务端完成，前端不参与。
 *
 * 登录前有两道本地确认（都只在页面上存在对应控件时生效）：
 *   ① 验证码：本地校验，见 captcha.js 顶部对「它不是什么」的说明
 *   ② 成员须知：勾选即表示已阅读。这是告知与确认，不是权限边界
 * @param {HTMLButtonElement} [btn] 用于 guard() 的按钮守卫
 */
async function signIn(btn) {
  clearAuthError();
  var codeEl = document.getElementById('auth-code');
  var pwdEl = document.getElementById('auth-password');
  var captchaEl = document.getElementById('auth-captcha');
  var agreeEl = document.getElementById('auth-agree');
  if (!codeEl || !pwdEl) return;

  var code = codeEl.value.trim();
  var password = pwdEl.value;
  if (!code || !password) { showAuthError('请输入用户ID和密码'); return; }

  // ① 验证码
  if (captchaEl) {
    if (!captchaEl.value.trim()) {
      showAuthError('请输入验证码');
      captchaEl.focus();
      return;
    }
    if (typeof captchaCheck === 'function' && !captchaCheck(captchaEl.value)) {
      // 输错就换一张，否则可以对着同一张图反复试。
      // 账号密码错误不换——服务端有限流，换掉只会让人多抄一次。
      showAuthError('验证码不正确，已换一张新的');
      captchaEl.value = '';
      if (typeof captchaRefresh === 'function') captchaRefresh();
      captchaEl.focus();
      return;
    }
  }

  // ② 成员须知
  if (agreeEl && typeof MEMBER_TERMS !== 'undefined' && !agreeEl.checked) {
    showAuthError('请先勾选同意《' + MEMBER_TERMS.title + '》再登录');
    agreeEl.focus();
    return;
  }

  var run = async function () {
    var res = await callWorkerAuth('login', { code: code, password: password }, { anonymous: true });
    if (!res.ok) {
      showAuthError('登录失败：' + (res.error && res.error.message ? res.error.message : '请检查用户ID和密码'));
      return;
    }
    if (!res.data || !res.data.access_token) {
      showAuthError('登录失败：未取得会话');
      return;
    }
    session.set(res.data);
    // 记住这次同意（按登录ID 记）。勾选框本身不是安全边界，
    // 真正的权限判断始终在数据库里，这里只是省掉重复确认。
    if (agreeEl) memberTermsSave(code);
    await setAuthUser(session.user());
    clearAuthError();
    pwdEl.value = '';
    showAlert('登录成功', 'success');

    // 登录后去哪：优先回到进来时的页面，其次去管理台
    var next = new URLSearchParams(location.search).get('next');
    setTimeout(function () {
      location.href = next ? decodeURIComponent(next) : 'console.html';
    }, 350);
  };

  if (btn) await guard(btn, run);
  else await run();
}

/** 登出：先让服务端失效 refresh token，再清本地 */
async function signOutNow() {
  var storedRefresh = null;
  try { storedRefresh = localStorage.getItem(SESSION_KEYS.refresh); } catch (e) { /* ignore */ }

  if (storedRefresh) {
    await callWorkerAuth('logout', { refresh_token: storedRefresh }, { anonymous: true });
  }
  session.clear();
  currentUser = null;
  currentProfile = null;
  currentRole = 'anon';
  clearAuthError();
  renderAuthUI();
  applyRoleUI();
  showAlert('已退出登录，当前为匿名访客', 'info');
}

/* ---------------- 渲染 ---------------- */

/**
 * 渲染导航右侧的身份区（#nav-auth）。
 * 未登录 → 「登录」链接；已登录 → 昵称 + 角色徽章 + 管理台入口 + 退出。
 */
function renderAuthUI() {
  var host = document.getElementById('nav-auth');
  if (!host) return;

  if (currentUser) {
    var name = (currentProfile && (currentProfile.username || currentProfile.user_code)) || '用户';
    host.innerHTML =
      '<div class="nav-user">' +
        '<span class="nav-user-name" title="' + escHtml(currentProfile && currentProfile.user_code ? 'ID: ' + currentProfile.user_code : '') + '">' +
          escHtml(name) +
        '</span>' +
        '<span class="role-badge role-' + escHtml(currentRole) + '">' + escHtml(ROLE_LABELS[currentRole] || currentRole) + '</span>' +
        '<a class="nav-console" href="console.html" data-minrole="user">管理台</a>' +
        '<button type="button" class="link-btn" onclick="guard(this, signOutNow)">退出</button>' +
      '</div>';
  } else {
    host.innerHTML = '<a class="btn btn-ghost btn-sm" href="login.html">登录</a>';
  }
  applyRoleUI();
}

/**
 * 按角色显隐带 data-minrole 的元素。
 *
 * 登出或被降权后，如果当前所在页面已不可见，自动跳到管理台之外的安全页，
 * 避免用户干瞪一个空白页。
 */
function applyRoleUI() {
  var rank = ROLE_RANK[currentRole] || 0;

  $$('[data-minrole]').forEach(function (el) {
    var need = ROLE_RANK[el.getAttribute('data-minrole')] || 0;
    el.style.display = (rank >= need) ? '' : 'none';
  });

  // 管理台门禁：匿名用户进来时直接请回去（前端礼貌性拦截；真正的锁在 RLS）。
  // 三个元素互斥显示——加载中 / 请登录 / 正文，避免出现"先看到门禁又跳走"的闪烁。
  var gate = document.getElementById('console-gate');
  if (gate) {
    var allowed = rank >= ROLE_RANK.user;
    gate.hidden = allowed;
    $$('[data-console-body]').forEach(function (el) { el.hidden = !allowed; });
    var loading = document.getElementById('console-loading');
    if (loading) loading.hidden = true;   // 会话已确定，撤掉加载态
  }

  // 页面特有的收尾渲染交给页面脚本自己实现（避免把业务逻辑堆进公共文件）
  if (typeof onRoleReady === 'function') {
    try { onRoleReady(); } catch (e) { console.error('[onRoleReady] 失败', e); }
  }
}

/* ---------------- 登录页表单绑定 ----------------
 * 放在这里而不是内联 onclick：这样按回车提交与点按钮走同一条路径，
 * 按钮守卫（guard）也统一生效。
 * ------------------------------------------------ */

document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('login-form');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = document.getElementById('login-submit');
    signIn(btn);
  });

  // 成员须知勾选框与本机已同意的账号联动：
  // 这台电脑上同意过当前版本 → 自动勾上，省掉重复确认；
  // 没同意过、或条款版本变了 → 保持不勾，必须自己勾。
  var codeEl = document.getElementById('auth-code');
  var agreeEl = document.getElementById('auth-agree');
  if (codeEl && agreeEl) {
    var syncAgree = function () {
      agreeEl.checked = codeEl.value.trim() ? memberTermsAgreedFor(codeEl.value) : false;
    };
    codeEl.addEventListener('input', syncAgree);
    codeEl.addEventListener('blur', syncAgree);
  }
});
