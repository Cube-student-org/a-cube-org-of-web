/**
 * 迷你 Markdown 渲染器
 *
 * 只实现本组织的文本实际用到的子集，不追求完整 CommonMark。
 * 实现范围（由 data/charter/<版本>/*.md 的真实结构倒推得出，见文件末尾的格式审计说明）：
 *   块级：段落、有序列表、无序列表（含一级嵌套）、列表项续行段落、引用块、水平分隔线
 *   行内：**加粗**、`行内代码`、#内容哈希交叉引用（可点击跳转）
 *
 * 为什么不引第三方：全站零第三方依赖，是中国网络环境下最省心的选择。
 * 为什么不直接把正文塞进 <pre>：章程是给人读的——71 条条文里有序列表
 * 和强调若不渲染，读起来会非常吃力，而「读得动」正是把章程放进网站的理由。
 *
 * 安全：所有文本先经 escHtml() 转义，标记替换只作用在**转义后**的文本上，
 * 因此不存在通过章程/帖子文件注入 HTML 的路径。转义不会动 * ` # 这些标记字符，
 * 所以替换顺序放在转义之后是安全的。
 *
 * 依赖：ui.js 的 escHtml()。脚本加载顺序必须 md.js 在 ui.js 之后。
 */

/* ---------------- 行内 ---------------- */

/**
 * 行内标记渲染。
 * @param {string} text 单行原始文本
 * @param {{resolveHash?: function(string): (null|{href:string,label:string})}} [opts]
 *        resolveHash 把 8 位哈希解析成可跳转目标；返回 null 则该引用保持纯文本
 *        （找不到目标时宁可不做链接，也不造一个点了没反应的假链接）
 * @returns {string} 已转义的 HTML
 */
function mdInline(text, opts) {
  var out = escHtml(text == null ? '' : String(text));

  // `行内代码`：先做，避免代码内容被加粗规则吃掉
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  // **加粗**：非贪婪，允许行内出现多段
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // #哈希 交叉引用
  if (opts && typeof opts.resolveHash === 'function') {
    // 匹配「# + 8位十六进制」，且哈希后不能再接十六进制字符——
    // 否则 9 位以上的串会被截成 8 位匹配。
    // pre 捕获 # 之前的一个字符，用来原样保留（可能是标点或中文）。
    out = out.replace(/(^|[^\w#])#([0-9a-fA-F]{8})(?![0-9a-fA-F])/g,
      function (whole, pre, hash) {
        var hit = opts.resolveHash(hash.toLowerCase());
        // 找不到目标就保持纯文本：宁可让人看到编号，也不要给一个点了没反应的假链接
        if (!hit) return whole;
        return pre +
          '<a class="art-ref" href="' + escHtml(hit.href) + '"' +
          ' title="' + escHtml(hit.label || '') + '">#' + hash + '</a>';
      });
  }

  return out;
}

/* ---------------- 块级 ---------------- */

var MD_RE_HR = /^\s*-{3,}\s*$/;
var MD_RE_OLI = /^(\s*)(\d+)[.)]\s+(.*)$/;
var MD_RE_ULI = /^(\s*)[-*+]\s+(.*)$/;
var MD_RE_BQ = /^>\s?(.*)$/;
/** 列表项缩进一级的宽度。原文只用 0 / 3 两个值，取 3 使 3 空格正好算作一级嵌套 */
var MD_INDENT_UNIT = 3;

/** 前导空格数 → 列表层级（制表符按 3 空格计） */
function mdIndentLevel(spaces) {
  var w = String(spaces || '').replace(/\t/g, '   ').length;
  return Math.floor(w / MD_INDENT_UNIT);
}

/** 把行序列切成块：{type:'p'|'hr'|'list', ...} */
function mdScanBlocks(lines) {
  var blocks = [];
  var list = null;      // 当前列表块
  var para = null;      // 当前段落块

  function endList() { list = null; }
  function endPara() { para = null; }

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var line = raw.replace(/\s+$/, '');

    // 空行：同时结束段落与列表
    if (!line.trim()) { endList(); endPara(); continue; }

    if (MD_RE_HR.test(line)) { endList(); endPara(); blocks.push({ type: 'hr' }); continue; }

    // 引用块：通俗版里每条条文后面那一句「举个例子：…」就是它。
    // 连续多行 > 合成一个块，块内允许再有段落与列表。
    if (MD_RE_BQ.test(line)) {
      endList(); endPara();
      var quoted = [];
      while (i < lines.length) {
        var mq = lines[i].replace(/\s+$/, '').match(MD_RE_BQ);
        if (!mq) break;
        quoted.push(mq[1]);
        i++;
      }
      i--;                      // 抵消外层 for 的 i++，把多读的那一行还回去
      blocks.push({ type: 'quote', lines: quoted });
      continue;
    }

    var mOl = line.match(MD_RE_OLI);
    var mUl = line.match(MD_RE_ULI);

    if (mOl || mUl) {
      endPara();
      if (!list) { list = { type: 'list', items: [] }; blocks.push(list); }
      var indent = mOl ? mOl[1] : mUl[1];
      list.items.push({
        level: mdIndentLevel(indent),
        ordered: !!mOl,
        text: mOl ? mOl[3] : mUl[2],
        cont: [],
      });
      continue;
    }

    // 非列表行
    var lead = (line.match(/^\s*/) || [''])[0].length;

    if (list && lead > 0 && list.items.length) {
      // 有缩进的续行：归入最后一个列表项，作为该项下的段落
      list.items[list.items.length - 1].cont.push(line.trim());
      continue;
    }

    // 顶格文本：列表就此结束，开启新段落
    endList();
    if (!para) { para = { type: 'p', lines: [] }; blocks.push(para); }
    para.lines.push(line.trim());
  }

  return blocks;
}

/** 递归渲染一个列表的某一层，返回 { html, next } */
function mdRenderList(items, start, level, opts) {
  var tag = items[start].ordered ? 'ol' : 'ul';
  var html = '<' + tag + ' class="md-list">';
  var i = start;

  while (i < items.length && items[i].level >= level) {
    if (items[i].level > level) {
      // 出现更深的层级：作为子列表嵌进上一个 <li> 内（上一个 <li> 尚未闭合）
      var sub = mdRenderList(items, i, items[i].level, opts);
      html += sub.html;
      i = sub.next;
      continue;
    }

    html += '<li>' + mdInline(items[i].text, opts);

    // 该项自己的续行段落
    var cont = items[i].cont || [];
    for (var c = 0; c < cont.length; c++) {
      html += '<p class="md-li-cont">' + mdInline(cont[c], opts) + '</p>';
    }

    // 紧跟其后的更深层级 → 子列表
    if (i + 1 < items.length && items[i + 1].level > level) {
      var sub2 = mdRenderList(items, i + 1, items[i + 1].level, opts);
      html += sub2.html;
      i = sub2.next;
    } else {
      i++;
    }

    html += '</li>';
  }

  return { html: html + '</' + tag + '>', next: i };
}

/**
 * 块级渲染。
 * @param {string[]} lines 原始行
 * @param {object} [opts] 透传给 mdInline 的选项
 * @returns {string} HTML
 */
function mdBlocks(lines, opts) {
  var blocks = mdScanBlocks(lines || []);
  var html = '';

  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.type === 'hr') { html += '<hr class="md-hr">'; continue; }
    if (b.type === 'quote') {
      // 块内递归：引用里可能有段落，也可能有列表
      html += '<blockquote class="md-quote">' + mdBlocks(b.lines, opts) + '</blockquote>';
      continue;
    }
    if (b.type === 'p') {
      html += '<p>' + mdInline(b.lines.join(' '), opts) + '</p>';
      continue;
    }
    if (b.type === 'list' && b.items.length) {
      html += mdRenderList(b.items, 0, b.items[0].level, opts).html;
    }
  }

  return html;
}

/**
 * 判断一段行序列是否"有内容"（用于决定要不要渲染空盒子）
 * @param {string[]} lines
 * @returns {boolean}
 */
function mdHasContent(lines) {
  if (!lines || !lines.length) return false;
  for (var i = 0; i < lines.length; i++) {
    if (String(lines[i]).trim()) return true;
  }
  return false;
}

/* ------------------------------------------------------------------
 * 格式审计说明（2026-09-13，对 data/charter/{plain,strict}/ 下 10 个 .md 实测）
 *
 *   表格        0 处   → 未实现
 *   代码围栏    0 处   → 未实现
 *   有序列表  231 项   → 已实现
 *   无序列表   13 项   → 已实现
 *   列表项续行 有      → 已实现（md-li-cont）
 *   引用块     73 处   → 已实现。通俗版的「举个例子」几乎全靠它
 *   嵌套缩进    仅 3 空格一级（0 / 3 两档）→ MD_INDENT_UNIT = 3
 *   行内加粗   12 对   （条文头的 90 对在解析阶段已剥离，不进正文）
 *   交叉引用   13 处   （条文头自身的 90 个哈希同样已剥离；
 *                        其中 3 处在细则里、指向主章程，需要跨文件索引才跳得动）
 *
 * 若将来章程引入了表格，此文件需要相应扩展——
 * 未实现的语法不会报错，只会以原始标记形态显示出来，属于可接受的降级。
 * ------------------------------------------------------------------ */
