/**
 * 全局配置与后端调用封装
 *
 * 全站唯一后端入口：Cloudflare Pages 高级模式部署的 Worker
 *   https://a-cube-org-of-web.pages.dev    （源码见 cf-workers/worker.js）
 *
 * ⚠️ 关于域名（C3 约束）
 *   *.workers.dev 在国内是「DNS 污染 + SNI 阻断」双重封锁：TCP 能连上、
 *   TLS 握手被掐断，改 hosts 无效，浏览器只会报 `Failed to fetch`。
 *   *.pages.dev 实测可用，故后端以 Pages 高级模式部署。
 *   若日后绑定自有域名，只改下面这一行，其余代码无需变动。
 *
 * ⚠️ 关于 C1 约束
 *   浏览器不持有任何 Supabase URL / Key，也不知道 Supabase 的存在。
 *   认证与数据访问全部经此后端转发，权限由数据库 RLS 在库层强制。
 *   因此本文件（以及全站）永远不该出现 supabase.co 字样。
 */
var WORKERS_BASE_URL = 'https://a-cube-org-of-web.pages.dev';

/**
 * 取得当前可用的 access token。
 * 本地有未过期的 access 就直接用，否则拿 refresh 换新的。
 * @returns {Promise<string|null>} 未登录 / 刷新失败返回 null
 */
async function authToken() {
  var cur = session.access();
  if (cur) return cur;
  return await session.ensureFresh();
}

/**
 * 底层请求后端（认证端点与业务端点通用）。
 *
 * @param {string} path  如 '/api/auth/login'、'/submit-attempt'、'/api/competitions?select=*'
 *                       注意：/api/* 的数据代理由 api.js 的 db() 负责，这里主要用于非 /api 端点。
 * @param {object} [body] 请求体（GET 时忽略）
 * @param {object} [opts]
 * @param {string}  [opts.method='POST']  HTTP 方法
 * @param {boolean} [opts.anonymous=false] true 时不附带 Authorization（如登录本身）
 * @returns {Promise<{ok:boolean, data:object, status:number, error:object|null}>}
 */
async function callWorker(path, body, opts) {
  opts = opts || {};
  var method = opts.method || 'POST';
  var anonymous = !!opts.anonymous;
  var target = WORKERS_BASE_URL + path;

  try {
    var headers = { 'Content-Type': 'application/json' };
    if (!anonymous) {
      var token = await authToken();
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }

    var init = { method: method, headers: headers };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(body || {});
    }

    var resp = await fetch(target, init);
    var data = await resp.json().catch(function () { return {}; });

    if (!resp.ok) {
      var msg = (data && (data.error || data.msg || data.message)) || ('请求失败(' + resp.status + ')');
      return { ok: false, data: data, status: resp.status, error: { message: msg } };
    }
    return { ok: true, data: data, status: resp.status, error: null };
  } catch (e) {
    // 把目标地址一并抛出：浏览器报 Failed to fetch 时，最常见的原因是
    // 页面执行的是旧版 config.js（BASE_URL 指向已被封锁的 workers.dev），
    // 带着地址才能一眼看出请求到底发去了哪里。
    console.error('[callWorker] 请求失败', target, e);
    return {
      ok: false, data: {}, status: 0,
      error: { message: '无法连接后端服务：' + e.message + '（目标 ' + target + '）' }
    };
  }
}

/**
 * 认证端点便捷调用：/api/auth/<action>
 *   login    {code, password}          （匿名）
 *   refresh  {refresh_token}           （匿名）
 *   logout   {refresh_token}           （匿名）
 *   password {new_password}            （需登录）
 *   user     —                         （需登录，GET）
 * @param {string} action
 * @param {object} [body]
 * @param {object} [opts] 同 callWorker
 */
async function callWorkerAuth(action, body, opts) {
  return callWorker('/api/auth/' + action, body || {}, opts);
}
