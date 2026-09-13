/**
 * 章程页
 *
 * 内容来源：组织仓库「文档/规范性文件」下的两个目录（严谨版 / 通俗版）。
 * 已经逐字放进 data/charter/<版本>/，本页只负责解析与展示，不改一个字。
 * 规范文件本身不在本站维护——同一份规则不应有两处说法。
 *
 * 解析器要认的结构（就是仓库那两个目录里的实际写法）：
 *   # 文件名               ← h1，作为文档标题
 *   ## 第X章 章名          ← 章（h2）。细则可能整篇不分章
 *   ### / #### ...         ← 节与子节（主章程已并入细则后不再使用，但解析器保留支持）
 *   **第X条#hash** 正文     ← 条文，hash 为 8 位十六进制，可缺省
 *   其余为正文：段落 / 有序与无序列表 / 引用块 / --- 分隔线
 *
 * 两条解析原则（都是被真实文本逼出来的，改之前先看）
 *   ① **空行不结束条文**。条文与它的列举列表之间常常隔着空行；
 *      若用空行断条，列表就会被甩到条文外面。只有标题行和新条文头才结束条文。
 *   ② **认不出的行一律当正文收下**，不报错也不丢弃。
 *      这是展示页：宁可排版朴素一点，也不能让条文在网页上凭空消失。
 *
 * 跨文件引用：细则里会写「依据#9a265b9b授权制定」，那个哈希在**主章程**里。
 * 本页因此会额外读一次主章程建索引，让这类引用也能点得动。
 */

/* ---------------- 版本 ---------------- */

var CHARTER_VERSIONS = {
  plain: {
    key: 'plain',
    label: '通俗版',
    dir: 'data/charter/plain/',
    note: '以例子为核心、语言通俗。日常陈述与执行的默认版本，多数情形直接用它。',
  },
  strict: {
    key: 'strict',
    label: '严谨版',
    dir: 'data/charter/strict/',
    note: '表述精确。用于正式决议、对外正式文件、争议裁决等需要精确界定权责的场合。',
  },
};
var CHARTER_VER_ORDER = ['plain', 'strict'];
var CHARTER_VER_DEFAULT = 'plain';

/** 记住访客上次选的版本与文件；只是阅读偏好，不涉及任何身份信息 */
var CHARTER_VER_KEY = 'wb_charter_ver';
var CHARTER_FILE_KEY = 'wb_charter_file';

/** 当前视图状态。跨文件哈希索引也放这里，渲染时要用 */
var charterState = {
  verKey: CHARTER_VER_DEFAULT,
  fileKey: '',
  doc: null,
  fileIndex: {},
};

/* ---------------- 文件清单 ---------------- */

function charterFileDef(key) {
  var list = (typeof CHARTER !== 'undefined' && CHARTER.files) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === key) return list[i];
  }
  return null;
}

function charterFilePath(verKey, fileKey) {
  var ver = CHARTER_VERSIONS[verKey];
  var f = charterFileDef(fileKey);
  if (!ver || !f) return null;
  return ver.dir + f.file;
}

/* ---------------- 解析 ---------------- */

var CH_RE_HR = /^-{3,}$/;
var CH_RE_HEAD = /^(#{1,4})\s+(.*)$/;
var CH_RE_CH_NO = /^(第[一二三四五六七八九十百零〇\d]+章)\s*(.*)$/;
var CH_RE_ARTICLE = /^\*\*\s*第\s*([一二三四五六七八九十百零〇\d]+)\s*条\s*(?:#\s*([0-9a-fA-F]{8}))?\s*\*\*\s*([\s\S]*)$/;

/**
 * 把一份规范文件的 Markdown 解析成结构化文档。
 * @param {string} md
 * @param {string} verKey
 * @returns {object}
 */
function parseCharter(md, verKey) {
  var src = String(md || '').split(/\r?\n/);
  var doc = {
    verKey: verKey,
    title: '',
    front: [],           // 第一个章之前的内容（细则常常整篇都在这里）。不单独成章
    chapters: [],
    byHash: {},          // hash → 条文（用于 #hash 交叉引用跳转）
    byNo: {},            // 阿拉伯条号 → 条文（用于按数字检索）
    count: { chapters: 0, sections: 0, subsections: 0, articles: 0 },
    hasText: false,
  };
  var chap = null;
  var art = null;

  function newChapter(noCn, title, index) {
    var c = { noCn: noCn, title: title, index: index, items: [], nArticles: 0, nSections: 0 };
    doc.chapters.push(c);
    doc.count.chapters++;
    return c;
  }

  /** 把一行归入「不属于任何条文的段落」容器（容器可能是章，也可能是文档前言） */
  function addLoose(host, raw) {
    var last = host[host.length - 1];
    if (last && last.kind === 'loose') last.lines.push(raw);
    else host.push({ kind: 'loose', lines: [raw] });
  }

  for (var i = 0; i < src.length; i++) {
    var raw = src[i];
    var t = raw.trim();

    // 空行与分隔线只作视觉分隔，不产生内容，也不结束条文（见文件头原则①）
    if (!t || CH_RE_HR.test(t)) continue;

    // ---- 标题 ----
    var mh = t.match(CH_RE_HEAD);
    if (mh) {
      var level = mh[1].length;
      var text = mh[2].trim();

      if (level === 1) {
        if (!doc.title) doc.title = text;
        continue;
      }

      if (level === 2) {
        var mc = text.match(CH_RE_CH_NO);
        chap = newChapter(mc ? mc[1] : '', mc ? mc[2].trim() : text, doc.chapters.length + 1);
        art = null;
        continue;
      }

      // h3 / h4：节与子节。只记层级与原文标题，不拆编号——原文的节编号曾写作「第X章」，
      // 拆出来单独显示反而会产生「第二章下面又有第一章」的困惑。
      var headItem = { kind: 'head', level: level, text: text };
      if (chap) {
        chap.items.push(headItem);
        if (level === 3) chap.nSections++;
      } else {
        doc.front.push(headItem);
      }
      if (level === 3) doc.count.sections++;
      else doc.count.subsections++;
      art = null;
      continue;
    }

    // ---- 条文头 ----
    var ma = t.match(CH_RE_ARTICLE);
    if (ma) {
      var hash = (ma[2] || '').toLowerCase();
      art = {
        noCn: ma[1],
        hash: hash,
        seq: doc.count.articles + 1,
        lines: ma[3] ? [ma[3].trim()] : [],
      };
      doc.count.articles++;
      doc.hasText = true;
      if (hash) doc.byHash[hash] = art;
      var num = cnToNumber(art.noCn);
      if (num != null) doc.byNo[num] = art;

      if (chap) {
        chap.nArticles++;
        chap.items.push({ kind: 'article', ref: art });
      } else {
        doc.front.push({ kind: 'article', ref: art });   // 不分章的细则：条文进前言区
      }
      continue;
    }

    // ---- 普通正文 ----
    // 必须 push 原始行而不是 trim 后的行：Markdown 的列表嵌套完全靠前导空格判断，
    // 一旦 trim 掉，「1. … ／   - …」这种嵌套列表就会被拍平成普通段落。
    if (art) art.lines.push(raw);
    else if (chap) addLoose(chap.items, raw);
    else addLoose(doc.front, raw);
  }

  return doc;
}

/** 条文锚点：用序号而非中文条号，这样链接可以直接手写（#art-13） */
function articleAnchor(a) { return 'art-' + a.seq; }

/* ---------------- 中文数字 ---------------- */

var CN_DIGITS = { '零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

/** 中文条号转数字：第七十七条 → 77。章程规模到 999 足够 */
function cnToNumber(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  var section = 0, num = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (CN_DIGITS[c] != null) num = CN_DIGITS[c];
    else if (c === '十') { section += (num || 1) * 10; num = 0; }
    else if (c === '百') { section += (num || 1) * 100; num = 0; }
    else return null;
  }
  return (section + num) || null;
}

/* ---------------- 交叉引用 ---------------- */

/**
 * 把一个 #hash 解析成可跳转目标。
 *
 * 顺序：当前文件 → 跨文件索引（主章程）。
 * 都找不到就返回 null，让渲染层保持纯文本——宁可让人看到编号，
 * 也不要给一个点了没反应的假链接。
 */
function resolveHashRef(hash) {
  var cur = charterState.doc;
  if (cur) {
    var a = cur.byHash[hash];
    if (a) return { href: '#' + articleAnchor(a), label: '第' + a.noCn + '条' };
  }

  var hit = charterState.fileIndex[hash];
  if (!hit) return null;

  if (hit.fileKey === charterState.fileKey) {
    return { href: '#art-' + hit.seq, label: '第' + hit.noCn + '条' };
  }

  var fd = charterFileDef(hit.fileKey);
  return {
    href: '?f=' + encodeURIComponent(hit.fileKey) +
          '&v=' + encodeURIComponent(charterState.verKey) +
          '#art-' + hit.seq,
    label: (fd ? fd.label : '') + ' 第' + hit.noCn + '条',
  };
}

/** md.js 的行内渲染选项 */
function charterMdOpts() {
  return { resolveHash: resolveHashRef };
}

/* ---------------- 渲染 ---------------- */

function renderCharterMeta(doc) {
  var hasText = doc.hasText;
  var ver = CHARTER_VERSIONS[charterState.verKey] || CHARTER_VERSIONS[CHARTER_VER_DEFAULT];
  var fd = charterFileDef(charterState.fileKey);

  // 一切数字都以实际解析结果为准，读不到文件才回落到 content.js 的声明值
  var items = [
    { label: '当前文件', value: fd ? fd.label : '—' },
    { label: '条文总数', value: String(hasText ? doc.count.articles : CHARTER.meta.articles) },
    { label: '章数', value: doc.chapters.length ? String(doc.chapters.length) : '不分章' },
    { label: '正在显示', value: ver.label },
  ];

  setHtml('#charter-meta', items.map(function (it) {
    return '<div class="charter-meta-item">' +
      '<div class="charter-meta-label">' + escHtml(it.label) + '</div>' +
      '<div class="charter-meta-value">' + escHtml(it.value) + '</div>' +
    '</div>';
  }).join(''));

  if (hasText) {
    setText('#charter-source-note',
      '本页 ' + doc.count.articles + ' 条条文由 ' + charterFilePath(charterState.verKey, charterState.fileKey) +
      ' 逐条解析得出，与组织仓库中的规范性文件是同一份文本，未作改写。' +
      '引用时请同时注明条号（内容哈希）与文本版本。');
  } else {
    setText('#charter-source-note',
      '正文未能读取：这个文件没有取到，或取到的是空文件。' +
      '请确认 data/charter/' + charterState.verKey + '/ 下有对应的 .md（做法见《网站维护说明》）。');
  }
  return hasText;
}

function renderToc(doc) {
  var host = $('#toc');
  var fd = charterFileDef(charterState.fileKey);
  var who = fd ? fd.label : '本文件';

  // 不分章的细则谈不上目录，直接说清楚，别让人对着空白区猜
  if (doc.hasText && !doc.chapters.length) {
    setText('#toc-desc', who + ' 不分章，全部 ' + doc.count.articles +
      ' 条条文按原顺序排在下面的全文里。');
    if (host) {
      host.innerHTML = '<p class="muted">本文件不分章，共 ' + doc.count.articles +
        ' 条，直接读下面的全文即可。</p>';
    }
    return;
  }

  if (!doc.hasText) {
    setText('#toc-desc', '正文未能读取，暂无可跳转的目录。');
    if (host) host.innerHTML = '';
    return;
  }

  setText('#toc-desc', who + ' 共 ' + doc.chapters.length + ' 章 ' + doc.count.articles +
    ' 条。点任一章可跳到全文对应位置。');

  if (!host) return;

  host.innerHTML = doc.chapters.map(function (ch) {
    var bits = [];
    if (ch.nSections) bits.push(ch.nSections + ' 节');
    bits.push(ch.nArticles + ' 条');
    return '<a class="toc-item" href="#ch-' + ch.index + '">' +
      '<span class="toc-no">' + escHtml(ch.noCn || ('第' + ch.index + '章')) + '</span>' +
      '<span class="toc-body">' +
        '<span class="toc-title">' + escHtml(ch.title || '（未命名）') + '</span>' +
        '<span class="toc-note">' + escHtml(bits.join(' · ')) + '</span>' +
      '</span>' +
    '</a>';
  }).join('');
}

/** 单条条文 */
function articleHtml(a, doc) {
  return '<article class="article" id="' + articleAnchor(a) + '">' +
    '<div class="article-head">' +
      '<span class="article-no">第' + escHtml(a.noCn) + '条</span>' +
      (a.hash
        ? '<span class="article-hash" title="条文内容哈希：永久编号，跨版本、跨文件引用条文时用它">#' +
          escHtml(a.hash) + '</span>'
        : '') +
    '</div>' +
    (mdHasContent(a.lines)
      ? '<div class="article-body">' + mdBlocks(a.lines, charterMdOpts()) + '</div>'
      : '') +
  '</article>';
}

/** 一串条目的渲染：节标题、条文、游离段落都按原始顺序出现。
 *  章内内容与文档前言共用这一个函数——它们的结构本来就是一样的。 */
function renderItems(items, doc) {
  return items.map(function (it) {
    if (it.kind === 'head') {
      var isSub = it.level >= 4;
      return '<h' + (isSub ? '4' : '3') + ' class="charter-sec' + (isSub ? ' charter-sec-sub' : '') + '">' +
        '<span class="sec-tag">' + (isSub ? '子节' : '节') + '</span>' +
        escHtml(it.text) +
      '</h' + (isSub ? '4' : '3') + '>';
    }
    if (it.kind === 'article') return articleHtml(it.ref, doc);
    // loose：不属于任何条文的段落（细则开头的说明就属于这一类）
    return '<div class="charter-loose">' + mdBlocks(it.lines, charterMdOpts()) + '</div>';
  }).join('');
}

function renderCharterBody(doc) {
  var host = $('#charter-body');
  if (!host) return;

  if (!doc.hasText) {
    renderEmpty('#charter-body', '正文未能读取',
      '请确认 data/charter/' + charterState.verKey + '/ 下存在对应的 .md 文件，然后刷新本页。');
    return;
  }

  // 文档前言（第一个章之前的内容，细则整篇都在这里）单独一块，放在章列表前面
  var frontHtml = doc.front.length
    ? '<div class="charter-front">' + renderItems(doc.front, doc) + '</div>'
    : '';

  var chaptersHtml = doc.chapters.map(function (ch) {
    var open = ch.index === 1 ? ' open' : '';
    var bits = [];
    if (ch.nSections) bits.push(ch.nSections + ' 节');
    bits.push(ch.nArticles + ' 条');
    return '<details class="disclosure" id="ch-' + ch.index + '"' + open + '>' +
      '<summary>' +
        escHtml(ch.noCn || ('第' + ch.index + '章')) + '　' + escHtml(ch.title || '') +
        '<span class="chapter-count">' + escHtml(bits.join(' · ')) + '</span>' +
      '</summary>' +
      '<div class="disclosure-body">' +
        (ch.items.length ? renderItems(ch.items, doc) : '<p class="faint">本章暂无条文。</p>') +
      '</div>' +
    '</details>';
  }).join('');

  // 章默认展开第一章（其余折叠，否则一进页面就是几百行）；
  // 不分章的细则没有可折叠的东西，直接平铺
  host.innerHTML = frontHtml + chaptersHtml;
}

/* ---------------- 检索 ---------------- */

/**
 * 在当前版本的当前文件里检索条文。
 * 支持：阿拉伯条号（77）、中文条号（第七十七条）、哈希（006f09d3）、关键词。
 */
function searchCharter(doc, query) {
  var q = String(query || '').trim();
  if (!q) return [];

  var qLower = q.toLowerCase();
  var qNum = cnToNumber(q.replace(/^第/, '').replace(/条$/, ''));
  var qHash = q.replace(/^#/, '').toLowerCase();
  var hits = [];

  function scan(a, ch) {
    var hitNo = qNum != null && cnToNumber(a.noCn) === qNum;
    var hitHash = qHash.length >= 4 && a.hash && a.hash.indexOf(qHash) === 0;
    var hitText = (a.lines.join(' ')).toLowerCase().indexOf(qLower) !== -1;
    if (hitNo || hitHash || hitText) hits.push({ chapter: ch, article: a });
  }

  doc.chapters.forEach(function (ch) {
    ch.items.forEach(function (it) { if (it.kind === 'article') scan(it.ref, ch); });
  });
  // 不分章的细则：条文都在前言区
  doc.front.forEach(function (it) { if (it.kind === 'article') scan(it.ref, null); });

  return hits;
}

function renderSearchResults(doc, query) {
  var host = $('#search-results');
  if (!host) return;

  var q = String(query || '').trim();
  if (!q) { host.innerHTML = ''; return; }

  if (!doc.hasText) {
    renderEmpty('#search-results', '正文尚未读取，无法检索条文',
      '目前只能浏览目录。文件就位后即可按条号、哈希或关键词检索。');
    return;
  }

  var hits = searchCharter(doc, q);
  if (!hits.length) {
    renderEmpty('#search-results', '没有找到匹配的条文',
      '可以换个关键词，或直接输入条号（如 35、第三十五条）。检索范围只是当前打开的这一份文件。');
    return;
  }

  var shown = hits.slice(0, 30);
  host.innerHTML =
    '<p class="muted mb-4">在当前文件里找到 ' + hits.length + ' 条结果' +
      (hits.length > shown.length ? '（只列出前 ' + shown.length + ' 条）' : '') + '：</p>' +
    shown.map(function (h) {
      var head = h.chapter
        ? '<a class="ch-search-hit-chapter" href="#ch-' + h.chapter.index + '">' +
            escHtml(h.chapter.noCn || '') + '　' + escHtml(h.chapter.title || '') + '</a>'
        : '<span class="ch-search-hit-chapter">本文件（不分章）</span>';
      return '<div class="card ch-search-hit">' + head + articleHtml(h.article, doc) + '</div>';
    }).join('');
}

function bindSearch(doc) {
  var input = $('#charter-q');
  if (!input) return;

  var timer = null;
  function run() { renderSearchResults(charterState.doc || doc, input.value); }

  // 输入即检索（防抖 250ms），回车与按钮立即响应
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { clearTimeout(timer); run(); }
  });

  var btn = $('#charter-search-btn');
  if (btn) btn.addEventListener('click', function () { clearTimeout(timer); run(); });

  var clear = $('#charter-clear-btn');
  if (clear) {
    clear.addEventListener('click', function () {
      input.value = '';
      clearTimeout(timer);
      var results = $('#search-results');
      if (results) results.innerHTML = '';
      input.focus();
    });
  }
}

/* ---------------- 来源与下载 ---------------- */

function renderSources() {
  var host = $('#charter-sources');
  if (!host) return;

  var ver = CHARTER_VERSIONS[charterState.verKey];
  var fd = charterFileDef(charterState.fileKey);
  var path = charterFilePath(charterState.verKey, charterState.fileKey);

  // 第一项指向本站自己的文件：不依赖 GitHub 当前是否可达，
  // 在国内网络下这是最实用的一条，也是「正在读的这一份」的准确指认。
  var items = [
    { label: '下载正在读的这一份（' + (ver ? ver.label : '') + ' · ' + (fd ? fd.label : '') + '）', url: path },
  ].concat((CHARTER.sources || []).map(function (s) {
    return { label: s.label, url: s.url, external: true };
  }));

  host.innerHTML = items.map(function (s) {
    return '<a href="' + escHtml(s.url) + '"' +
      (s.external ? ' target="_blank" rel="noopener noreferrer"' : ' download') +
      '>' + escHtml(s.label) + ' ↗</a>';
  }).join('');
}

/* ---------------- 选择器 ---------------- */

/**
 * 文件一览：把「一共有哪几份、各管什么」摆成一个列表。
 *
 * 为什么值得单独做：选择器上的按钮只有文件名，而「这份细则到底管什么」
 * 恰恰是访客判断该读哪一份的唯一依据。note 就来自 content.js，不另写一份文案，
 * 免得两处说法走岔。
 *
 * 用 <a> 而不是按钮：换文件会重建整页视图，直接跳 URL 最稳，
 * 顺便让「复制链接分享某一份」这件事自然成立（?f=history&v=plain）。
 */
function renderFileOverview() {
  var host = $('#charter-overview');
  if (!host) return;

  host.innerHTML = (CHARTER.files || []).map(function (f) {
    var on = f.key === charterState.fileKey;
    return '<a class="file-card' + (on ? ' is-on' : '') + '"' +
      ' href="?f=' + encodeURIComponent(f.key) + '&v=' + encodeURIComponent(charterState.verKey) + '"' +
      (on ? ' aria-current="page"' : '') + '>' +
      '<span class="file-card-head">' +
        '<span class="file-card-name">' + escHtml(f.label) + '</span>' +
        (on ? '<span class="file-card-tag">正在读</span>' : '') +
      '</span>' +
      '<span class="file-card-note">' + escHtml(f.note || '') + '</span>' +
    '</a>';
  }).join('');
}

function renderPicker() {
  var verHost = $('#charter-version');
  if (verHost) {
    verHost.innerHTML = CHARTER_VER_ORDER.map(function (key) {
      var v = CHARTER_VERSIONS[key];
      var on = key === charterState.verKey;
      return '<button class="ver-btn' + (on ? ' is-on' : '') + '" type="button"' +
        ' data-ver="' + escHtml(key) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
        escHtml(v.label) +
      '</button>';
    }).join('');
  }

  var fileHost = $('#charter-files');
  if (fileHost) {
    fileHost.innerHTML = (CHARTER.files || []).map(function (f) {
      var on = f.key === charterState.fileKey;
      return '<button class="file-btn' + (on ? ' is-on' : '') + '" type="button"' +
        ' data-file="' + escHtml(f.key) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
        escHtml(f.label) +
      '</button>';
    }).join('');
  }

  var fd = charterFileDef(charterState.fileKey);
  setText('#charter-file-note', fd ? fd.note : '');
  setText('#charter-version-note', (CHARTER_VERSIONS[charterState.verKey] || {}).note || '');
}

/* ---------------- 数据加载 ---------------- */

/** 读取某一版某一文件的正文；失败返回 null（不抛，让调用方决定怎么提示） */
async function fetchCharterText(verKey, fileKey) {
  var path = charterFilePath(verKey, fileKey);
  if (!path) return null;
  try {
    // 带时间戳绕开缓存：章程是会被修订的文本，
    // 让人读到上一次的条文，比读不到更糟。
    var resp = await fetch(path + '?t=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return null;
    var text = await resp.text();
    return text.trim() ? text : null;
  } catch (e) {
    // 用 file:// 直接打开页面时 fetch 会被 CORS 拦住，这是预期内的
    console.warn('[charter] 读取失败：' + path, e);
    return null;
  }
}

/**
 * 建跨文件哈希索引。
 *
 * 细则里会引用主章程的条文（如「由常任委员会依据#9a265b9b授权制定」），
 * 只看当前文件找不到目标，所以要额外读一次主章程，把它的条文位置记下来。
 * 主章程约 37KB，这个代价可以接受；读不到也不影响当前文件的正常显示。
 */
async function buildCrossFileIndex(verKey) {
  var idx = {};
  var md = await fetchCharterText(verKey, CHARTER.defaultFile);
  if (!md) return idx;

  var doc = parseCharter(md, verKey);
  Object.keys(doc.byHash).forEach(function (h) {
    var a = doc.byHash[h];
    idx[h] = { fileKey: CHARTER.defaultFile, seq: a.seq, noCn: a.noCn };
  });
  return idx;
}

/** 读文件 → 解析 → 渲染整套视图 */
async function loadAndRender() {
  var loading = $('#charter-loading');
  if (loading) loading.hidden = false;

  var md = await fetchCharterText(charterState.verKey, charterState.fileKey);
  var doc = parseCharter(md || '', charterState.verKey);
  charterState.doc = doc;

  // 当前文件不是主章程时，才需要额外读主章程建索引
  charterState.fileIndex = (charterState.fileKey === CHARTER.defaultFile)
    ? {}
    : await buildCrossFileIndex(charterState.verKey);

  if (loading) loading.hidden = true;

  renderCharterMeta(doc);
  renderFileOverview();
  renderToc(doc);
  renderCharterBody(doc);
  renderPicker();
  renderSources();

  var box = $('#charter-q');
  renderSearchResults(doc, box ? box.value : '');

  return doc;
}

/* ---------------- 选择与 URL ---------------- */

/** 读「该显示哪一版」：URL 参数 > 上次选择 > 默认 */
function resolveVersion() {
  var fromUrl = qsParam('v', '');
  if (CHARTER_VERSIONS[fromUrl]) return fromUrl;
  try {
    var saved = localStorage.getItem(CHARTER_VER_KEY);
    if (CHARTER_VERSIONS[saved]) return saved;
  } catch (e) { /* 隐私模式下读不到，用默认值即可 */ }
  return CHARTER_VER_DEFAULT;
}

/** 读「该显示哪个文件」：URL 参数 > 上次选择 > 默认 */
function resolveFile() {
  var fromUrl = qsParam('f', '');
  if (charterFileDef(fromUrl)) return fromUrl;
  try {
    var saved = localStorage.getItem(CHARTER_FILE_KEY);
    if (charterFileDef(saved)) return saved;
  } catch (e) { /* 同上 */ }
  return CHARTER.defaultFile;
}

/** 把当前选择写回 URL，便于分享与刷新后停在原处 */
function syncUrl(clearHash) {
  if (!history.replaceState) return;
  try {
    var u = new URL(location.href);
    u.searchParams.set('v', charterState.verKey);
    u.searchParams.set('f', charterState.fileKey);
    if (clearHash) u.hash = '';
    history.replaceState(null, '', u);
  } catch (e) { /* URL 构造失败也不该影响阅读 */ }
}

function bindPicker() {
  var host = $('#charter-picker');
  if (!host) return;

  host.addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-ver], button[data-file]');
    if (!btn) return;

    var nextVer = btn.getAttribute('data-ver');
    var nextFile = btn.getAttribute('data-file');

    var verChanged = nextVer && nextVer !== charterState.verKey;
    var fileChanged = nextFile && nextFile !== charterState.fileKey;
    if (!verChanged && !fileChanged) return;

    var y = window.scrollY;

    if (verChanged) charterState.verKey = nextVer;
    if (fileChanged) charterState.fileKey = nextFile;

    try {
      localStorage.setItem(CHARTER_VER_KEY, charterState.verKey);
      localStorage.setItem(CHARTER_FILE_KEY, charterState.fileKey);
    } catch (err) { /* 存不了也无妨，只是下次回到默认 */ }

    // 换文件要清掉旧 hash：锚点在新文件里多半不存在，留着会指向错的地方
    syncUrl(fileChanged);

    await loadAndRender();

    // 换版本保持位置（两版章条一一对应，停在同一处正好对照着读）；
    // 换文件则回到顶部——两份文件结构不同，硬保位置只会让人以为页面坏了
    if (fileChanged) window.scrollTo(0, 0);
    else window.scrollTo(0, y);
  });
}

/* ---------------- 锚点跳转 ---------------- */

/**
 * 打开折叠面板并滚到锚点目标。
 *
 * 为什么必须做：章是折叠的，锚点 #ch-3 或 #art-13 落在折叠面板内部时，
 * 浏览器跳过去只会看到一行摘要——内容还没展开，等于跳了个空。
 * 所以要先逐级打开祖先 details，再滚动。
 */
function revealHashTarget() {
  var hash = location.hash;
  if (!hash || hash.length < 2) return;

  var el;
  try {
    el = document.querySelector(hash);
  } catch (e) {
    return;  // 手写的非法选择器（例如 #13 这种纯数字 id）会抛，忽略即可
  }
  if (!el) return;

  var box = el.closest ? el.closest('details.disclosure') : null;
  while (box) {
    box.open = true;
    var parent = box.parentElement;
    box = parent && parent.closest ? parent.closest('details.disclosure') : null;
  }

  if (el.scrollIntoView) el.scrollIntoView();
}

/* ---------------- 入口 ---------------- */

document.addEventListener('DOMContentLoaded', async function () {
  charterState.verKey = resolveVersion();
  charterState.fileKey = resolveFile();

  var doc = await loadAndRender();
  bindSearch(doc);
  bindPicker();

  // 从别处带锚点进来（目录、条文交叉引用、或别的页面链过来的条文）时要展开并定位
  revealHashTarget();
  window.addEventListener('hashchange', revealHashTarget);
});
