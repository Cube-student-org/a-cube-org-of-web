/**
 * 站点外壳（每页都会加载）
 *
 * 职责：
 *   1. 按当前 URL 给导航项加高亮
 *   2. 窄屏汉堡菜单
 *   3. 页脚年份、组织名、免责说明由 content.js 注入
 *   4. 提供首页与「关于我们」共用的几段渲染（组织架构、核心特征、状态说明）
 *
 * 设计取舍：导航与页脚在**每个 HTML 文件里都写全了**，没有用 JS 注入。
 *   这样 JS 挂掉、或者搜索引擎爬虫不执行 JS 时，全站导航与页脚依然可用。
 *   代价是新增栏目要改 7 个文件——具体步骤写在《网站维护说明.md》里。
 */

/* ---------------- 导航 ---------------- */

/** 给当前页面对应的导航项加高亮 */
function markCurrentNav() {
  var file = location.pathname.split('/').pop() || 'index.html';
  if (file === '') file = 'index.html';
  $$('[data-nav]').forEach(function (a) {
    var target = a.getAttribute('data-nav');
    var isCurrent = (target === file) ||
      // 登录页与注册/管理台归到同一组，避免两者都不高亮
      (target === 'login.html' && file === 'login.html');
    if (isCurrent) {
      a.classList.add('is-current');
      a.setAttribute('aria-current', 'page');
    }
  });
}

/** 窄屏汉堡菜单 */
function initNavToggle() {
  var btn = document.getElementById('nav-toggle');
  var nav = document.getElementById('site-nav');
  if (!btn || !nav) return;

  btn.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // 点任何导航链接后自动收起菜单（窄屏下不然会挡住内容）
  nav.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') {
      nav.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // Esc 关闭
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      nav.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    }
  });
}

/* ---------------- 页脚 ---------------- */

function renderFooter() {
  var yearEl = document.getElementById('foot-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  var nameEl = document.getElementById('foot-name');
  if (nameEl) nameEl.textContent = ORG.name;

  var enEl = document.getElementById('foot-name-en');
  if (enEl) enEl.textContent = ORG.nameEn;

  var noteEl = document.getElementById('foot-note');
  if (noteEl) noteEl.textContent = CONTACT.note;

  var linksEl = document.getElementById('foot-links');
  if (linksEl) {
    linksEl.innerHTML = CONTACT.links.map(function (l) {
      return '<a href="' + escHtml(l.url) + '" target="_blank" rel="noopener noreferrer">' +
             escHtml(l.label) + '</a>';
    }).join('');
  }
}

/* ---------------- 共用渲染：状态卡 ---------------- */

function renderStatusCard(sel) {
  var host = typeof sel === 'string' ? $(sel) : sel;
  if (!host) return;
  host.innerHTML =
    '<div class="status-card">' +
      '<div class="status-row">' +
        '<span class="status-label">当前状态</span>' +
        '<span class="status-value"><span class="tag tag-warn">' + escHtml(ORG.status) + '</span></span>' +
      '</div>' +
      '<p class="status-note">' + escHtml(ORG.statusNote) + '</p>' +
      '<div class="status-row">' +
        '<span class="status-label">组织性质</span>' +
        '<span class="status-value">' + escHtml(ORG.tagline) + '</span>' +
      '</div>' +
      '<a class="status-more" href="about.html#status">这条状态是什么意思 →</a>' +
    '</div>';
}

/* ---------------- 共用渲染：核心特征 ---------------- */

function renderPrinciples(sel) {
  var host = typeof sel === 'string' ? $(sel) : sel;
  if (!host) return;
  host.innerHTML = PRINCIPLES.map(function (p) {
    return '<article class="card">' +
      '<h3 class="card-title">' + escHtml(p.title) + '</h3>' +
      '<p class="card-body">' + escHtml(p.body) + '</p>' +
    '</article>';
  }).join('');
}

/* ---------------- 共用渲染：组织架构 ---------------- */

/**
 * 渲染组织架构。
 *
 * 这里刻意不做「机构树」：ORG_CHART 只给整体结构（见 content.js 的说明），
 * 本函数也只负责把它排成四行。想加机构请改章程，不要改这里。
 *
 * @param {string|Element} sel
 * @param {{compact?: boolean}} [opts] compact=true 用于首页：只留性质与名称，省掉逐条说明
 */
function renderOrgChart(sel, opts) {
  var host = typeof sel === 'string' ? $(sel) : sel;
  if (!host) return;
  opts = opts || {};

  var h = '<p class="org-lead">' + escHtml(ORG_CHART.lead) + '</p>';

  var layers = ORG_CHART.layers || [];
  if (layers.length) {
    h += '<ul class="org-layers">' + layers.map(function (l) {
      return '<li class="org-layer">' +
        '<span class="org-layer-tag">' + escHtml(l.tag) + '</span>' +
        '<span class="org-layer-name">' + escHtml(l.name) + '</span>' +
        (opts.compact ? '' : '<span class="org-layer-note">' + escHtml(l.note) + '</span>') +
      '</li>';
    }).join('') + '</ul>';
  }

  // 收口那句话只在完整版出现：首页要的是印象，不是附注
  if (!opts.compact && ORG_CHART.pointer) {
    h += '<p class="org-pointer">' + escHtml(ORG_CHART.pointer) + '</p>';
  }

  host.innerHTML = h;
}

/* ---------------- 通用小工具 ---------------- */

/** 读 URL 查询参数 */
function qsParam(name, fallback) {
  var v = new URLSearchParams(location.search).get(name);
  return v == null ? (fallback == null ? '' : fallback) : v;
}

/** 统一的后端启动探测：失败就给一句人话，不继续往下加载 */
async function probeBackend() {
  var res = await db('competitions').select('id').limit(1);
  return !res.error;
}

/* ---------------- 每页启动 ---------------- */

document.addEventListener('DOMContentLoaded', function () {
  markCurrentNav();
  initNavToggle();
  renderFooter();
  // 恢复登录态（异步；导航右侧身份区会随后填充）
  initAuth().catch(function (err) {
    console.error('[initAuth] 失败', err);
  });
});
