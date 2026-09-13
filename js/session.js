/**
 * 会话层（替代 supabase-js 的 auth 模块）
 *
 * 登录 / 刷新 / 登出 全部经后端的 /api/auth/* 代理完成，
 * 浏览器不持有任何 Supabase URL / Key（C1）。
 *
 * 只有三个 localStorage key，不与任何第三方库共用命名空间：
 *   wb_access   access token（短期）
 *   wb_refresh  refresh token（长期）
 *   wb_user     用户对象（仅用于界面展示，权限判断一律回数据库取）
 */
var SESSION_KEYS = {
  access: 'wb_access',
  refresh: 'wb_refresh',
  user: 'wb_user',
};

var session = (function () {
  var accessToken = null;
  var refreshToken = null;
  var currentUser = null;

  function readStored() {
    try {
      accessToken = localStorage.getItem(SESSION_KEYS.access) || null;
      refreshToken = localStorage.getItem(SESSION_KEYS.refresh) || null;
      currentUser = JSON.parse(localStorage.getItem(SESSION_KEYS.user) || 'null');
    } catch (e) {
      // 隐私模式下 localStorage 可能不可用，退化为"每次访问都是匿名"
      accessToken = null; refreshToken = null; currentUser = null;
    }
  }
  readStored();

  function persist() {
    try {
      if (accessToken) localStorage.setItem(SESSION_KEYS.access, accessToken);
      else localStorage.removeItem(SESSION_KEYS.access);

      if (refreshToken) localStorage.setItem(SESSION_KEYS.refresh, refreshToken);
      else localStorage.removeItem(SESSION_KEYS.refresh);

      if (currentUser) localStorage.setItem(SESSION_KEYS.user, JSON.stringify(currentUser));
      else localStorage.removeItem(SESSION_KEYS.user);
    } catch (e) { /* 写入失败不致命，只是刷新后需要重新登录 */ }
  }

  return {
    /** 同步返回当前 access token（可能已过期，需要时先 ensureFresh） */
    access: function () { return accessToken; },
    /** 当前登录用户对象，未登录返回 null */
    user: function () { return currentUser; },
    /** 是否存在已保存的会话（不保证 token 仍有效） */
    hasSession: function () { return !!(accessToken && refreshToken); },
    /** 登录成功后写入 token 与用户对象 */
    set: function (data) {
      accessToken = data.access_token || null;
      refreshToken = data.refresh_token || null;
      currentUser = data.user || null;
      persist();
    },
    /** 登出或会话失效：清空本地 */
    clear: function () {
      accessToken = null;
      refreshToken = null;
      currentUser = null;
      persist();
    },
    /**
     * 确保 access token 可用：本地没有就用 refresh token 换一个。
     * 刷新失败即清空会话、退化为匿名。
     * @returns {Promise<string|null>}
     */
    ensureFresh: async function () {
      if (accessToken) return accessToken;
      if (refreshToken) {
        try {
          var r = await callWorker('/api/auth/refresh', { refresh_token: refreshToken }, { anonymous: true });
          if (r.ok && r.data && r.data.access_token) {
            session.set(r.data);
            return accessToken;
          }
        } catch (e) { /* 刷新失败按未登录处理 */ }
        session.clear();
      }
      return null;
    },
  };
})();
