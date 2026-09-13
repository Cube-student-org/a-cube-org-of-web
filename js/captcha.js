/**
 * 登录验证码（本地生成）
 *
 * ⚠️ 先说清楚它是什么、不是什么——这段定位必须写进界面小字，不能让用户误以为
 *   有了它账号就绝对安全。
 *
 *   它是：浏览器本地生成的图形验证码。不依赖任何第三方验证码服务
 *        （国内网络下第三方脚本经常加载不出来，登录页不能押在它上面）。
 *   作用是：挡住「对着登录接口直接跑脚本」这类最粗糙的尝试，并减少手滑误提交。
 *   它不是：安全边界。验证码在本机生成、在本机校验，懂技术的人可以绕过。
 *       真正的防护在服务端——Supabase Auth 的登录限流，以及数据库层的 RLS。
 *
 * 生成方式：Canvas 画 4 个字符 + 干扰线 + 噪点。
 *   字符集去掉了 0/O/1/I/L 这些容易看错的，减少「明明输对了却说过期」的挫败。
 *   本题只考查「能不能看清并照抄」，不考查记忆，所以输入不做超时限制。
 */

/** 去掉易混淆字符（0 O、1 I L、2 Z、5 S 里只保留不易混的那个） */
var CAPTCHA_CHARS = 'ABCDEFGHJKMNPQRTUVWXY3456789';
var CAPTCHA_LEN = 4;

/** 当前这一张的答案。只存在内存里，刷新页面即失效 */
var captchaAnswer = '';

/** 取一个 [min,max) 的随机整数 */
function captchaRand(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

function captchaNewCode() {
  var s = '';
  for (var i = 0; i < CAPTCHA_LEN; i++) {
    s += CAPTCHA_CHARS.charAt(captchaRand(0, CAPTCHA_CHARS.length));
  }
  return s;
}

/**
 * 把字符画到 canvas 上。
 * @returns {boolean} 是否绘制成功（拿不到 2D 上下文时返回 false）
 */
function captchaDraw(canvas, code) {
  var ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return false;

  // 高分屏上按设备像素比放大画布，否则字会发虚；样式尺寸仍由 CSS 控制
  var dpr = window.devicePixelRatio || 1;
  var W = 132, H = 44;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  if (canvas.style) {
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 底色：比页面背景略深一档，让验证码看起来像一块独立的图，而不是漂浮的文字
  ctx.fillStyle = '#EEF0F4';
  ctx.fillRect(0, 0, W, H);

  // 干扰线：两条。再多会看不清，做题的人会烦
  var lineColors = ['#C9CED8', '#D9D7F7'];
  for (var i = 0; i < 2; i++) {
    ctx.strokeStyle = lineColors[i % lineColors.length];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(captchaRand(0, W), captchaRand(0, H));
    ctx.bezierCurveTo(
      captchaRand(0, W), captchaRand(0, H),
      captchaRand(0, W), captchaRand(0, H),
      captchaRand(0, W), captchaRand(0, H));
    ctx.stroke();
  }

  // 噪点
  for (var d = 0; d < 28; d++) {
    ctx.fillStyle = d % 2 ? '#C9CED8' : '#D9D7F7';
    ctx.fillRect(captchaRand(0, W), captchaRand(0, H), 1.5, 1.5);
  }

  // 字符：逐个换色、轻微旋转与上下偏移，避免一眼看穿排版规律
  var colors = ['#5B57D1', '#4440A8', '#4C5563', '#5B57D1'];
  var step = (W - 24) / CAPTCHA_LEN;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (var c = 0; c < code.length; c++) {
    ctx.save();
    ctx.translate(16 + step * c + step / 2, H / 2 + captchaRand(-3, 4));
    ctx.rotate((captchaRand(-14, 15) * Math.PI) / 180);
    ctx.font = '700 ' + captchaRand(24, 28) + 'px ui-monospace, Consolas, monospace';
    ctx.fillStyle = colors[c % colors.length];
    ctx.fillText(code.charAt(c), 0, 0);
    ctx.restore();
  }

  return true;
}

/**
 * 换一张新验证码。
 * @param {HTMLCanvasElement} [canvas] 省略则取 #captcha-canvas
 * @returns {string} 新答案（仅供调试，正常调用方不需要）
 */
function captchaRefresh(canvas) {
  canvas = canvas || document.getElementById('captcha-canvas');
  if (!canvas) return '';

  captchaAnswer = captchaNewCode();

  if (!captchaDraw(canvas, captchaAnswer)) {
    // 画不出来（极端环境）：不要让用户卡在一个空图上，
    // 直接把答案写进 title，至少人工核对还能继续
    canvas.title = '验证码：' + captchaAnswer;
  }
  return captchaAnswer;
}

/**
 * 校验用户输入。
 * 大小写不敏感、忽略首尾空格——题目只是「照着抄」，不考大小写记忆。
 */
function captchaCheck(value) {
  var v = String(value == null ? '' : value).trim().toUpperCase();
  return v.length > 0 && v === captchaAnswer;
}

/** 初始化登录页的验证码控件 */
function initCaptcha() {
  var canvas = document.getElementById('captcha-canvas');
  if (!canvas) return;

  captchaRefresh(canvas);

  var input = document.getElementById('auth-captcha');

  function renew() {
    captchaRefresh(canvas);
    if (input) { input.value = ''; input.focus(); }
  }

  var btn = document.getElementById('captcha-refresh');
  if (btn) btn.addEventListener('click', renew);

  // 图片本身也能点：这是所有网站验证码的通用习惯，不该逼人去点小按钮
  canvas.style.cursor = 'pointer';
  canvas.addEventListener('click', renew);

  // 输入框里全是自动填充或粘贴进来的内容时，用户多半是没看清，
  // 提交时会在 signIn 里统一提示，这里不额外干预
}

document.addEventListener('DOMContentLoaded', initCaptcha);
