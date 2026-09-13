/**
 * 业务数据访问：统一走云函数的通用 /api/* 代理
 *
 * 浏览器不直连数据库，所有表的读写都经过后端，由 RLS 在库层强制权限（C2）。
 * 匿名可读公开数据（GET 不带 token 也放行）；写操作必须登录。
 *
 * 语法刻意对齐 supabase-js，便于迁移期的机械替换：
 *   迁移前  supabaseClient.from('competitions').select('*').order('competition_number')
 *   迁移后  db('competitions').select('*').order('competition_number')
 *
 * ⚠️ 两个已知能力边界（读之前先看，别浪费时间试）
 *   1. **取不到总数**。PostgREST 的 `Prefer: count=exact` 需要客户端把该头发给后端，
 *      但 worker.js 的 apiProxy 自设 Prefer（写操作固定 `return=representation`，
 *      GET 则完全不设），**不转发调用方的 Prefer**。所以无法用 count 拿总数，
 *      只能"取回数组再 .length"。数据量大时会漏（见第 2 点）。
 *   2. **没有分页**。分页要靠 Range / Content-Range 头，同样不被转发。
 *      单次读取的行数上限由 PostgREST 服务端默认值决定，前端无法感知是否被截断。
 *      → 因此本站在做统计时用 `.limit()` 明确设一个上界，并把口径写进界面文案，
 *        而不是假装拿到的是精确全量。
 *
 * 每次调用返回 { data, error }；data 为数组或对象，error 为 {message, status} 或 null。
 */

/** 取本地会话的 JWT；返回空串表示匿名（读公开数据仍可走匿名通道） */
async function getApiToken() {
  try {
    var token = await authToken();
    return token || '';
  } catch (e) { return ''; }
}

/**
 * 底层请求：GET/PATCH/DELETE 发到 /api/<table>?<查询串>
 * @param {string} method
 * @param {string} restPath 如 "competitions?select=*&order=competition_number"
 * @param {object} [body]
 * @returns {Promise<any>} 解析后的 JSON
 */
async function apiFetch(method, restPath, body) {
  var token = await getApiToken();
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['Prefer'] = 'return=representation';

  var resp = await fetch(WORKERS_BASE_URL + '/api/' + restPath, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  var data = await resp.json().catch(function () { return null; });

  if (!resp.ok) {
    var msg = (data && (data.error || data.message)) || ('请求失败(' + resp.status + ')');
    var err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * 链式数据构建器
 *   db('competitions').select('*').order('competition_number')
 *   db('attempts').select('*,participants(name)').eq('status','approved').limit(200)
 *   db('competitions').insert({...}) / .update({...}).eq('id',id) / .delete().eq('id',id)
 *
 * 可直接 await：
 *   var { data, error } = await db('competitions').select('*');
 */
function db(table) {
  var q = {
    table: table, method: 'GET', select: '*',
    filters: [], orders: [], limit: null, single: false, body: undefined,
  };

  function buildQuery() {
    var parts = [];
    if (q.select) parts.push('select=' + encodeURIComponent(q.select.replace(/\s+/g, '')));
    for (var i = 0; i < q.filters.length; i++) parts.push(q.filters[i]);
    if (q.orders.length) {
      var ord = q.orders.map(function (o) { return o.col + '.' + o.dir; });
      parts.push('order=' + encodeURIComponent(ord.join(',')));
    }
    if (q.limit != null) parts.push('limit=' + q.limit);
    return parts.join('&');
  }

  async function exec() {
    try {
      var query = buildQuery();
      var path;
      if (q.method === 'GET') {
        path = q.table + (query ? '?' + query : '');
      } else {
        // 写操作：定位条件拼进查询串（PostgREST 用 ?id=eq.x 指定目标行）
        path = q.table + (q.filters.length ? '?' + q.filters.join('&') : '');
      }
      var data = await apiFetch(q.method, path, q.body);
      // .single()/.maybeSingle()：数据库返回单对象，这里取数组首项近似
      if (q.single && Array.isArray(data)) data = data.length ? data[0] : null;
      return { data: data, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message, status: e.status } };
    }
  }

  var api = {
    select: function (cols) { q.select = cols || '*'; return api; },
    /** order(col)、order(col, {ascending:false})；可多次调用形成多段排序 */
    order: function (col, opts) {
      var dir = (opts && opts.ascending === false) ? 'desc' : 'asc';
      q.orders.push({ col: col, dir: dir });
      return api;
    },
    limit: function (n) { q.limit = n; return api; },
    eq: function (col, val) { q.filters.push(col + '=eq.' + encodeURIComponent(val)); return api; },
    neq: function (col, val) { q.filters.push(col + '=neq.' + encodeURIComponent(val)); return api; },
    is: function (col, val) { q.filters.push(col + '=is.' + val); return api; },
    gt: function (col, val) { q.filters.push(col + '=gt.' + encodeURIComponent(val)); return api; },
    gte: function (col, val) { q.filters.push(col + '=gte.' + encodeURIComponent(val)); return api; },
    lt: function (col, val) { q.filters.push(col + '=lt.' + encodeURIComponent(val)); return api; },
    lte: function (col, val) { q.filters.push(col + '=lte.' + encodeURIComponent(val)); return api; },
    /** in(col, [v1,v2]) → col=in.(v1,v2) */
    in: function (col, vals) {
      q.filters.push(col + '=in.(' + vals.map(encodeURIComponent).join(',') + ')');
      return api;
    },
    /** 模糊匹配（PostgREST 的 ilike，* 作通配符） */
    ilike: function (col, pattern) { q.filters.push(col + '=ilike.' + encodeURIComponent(pattern)); return api; },
    single: function () { q.single = true; return api; },
    maybeSingle: function () { q.single = true; return api; },
    insert: function (row) { q.method = 'POST'; q.body = row; return api; },
    update: function (row) { q.method = 'PATCH'; q.body = row; return api; },
    delete: function () { q.method = 'DELETE'; return api; },
    /** 让构建器可被 await：调用即执行，返回 { data, error } */
    then: function (resolve, reject) { return exec().then(resolve, reject); },
  };
  return api;
}
