// 账号安全后端冒烟：老库迁移回填（全员初始密码 gkjsdh123 + 个人公告 + slug 回填）→
//   初始密码登录/错误密码 → 个人公告未读计数/列表 → 邮箱验证码自动注册（自带初始密码）→
//   管理员补发提醒（不重复/只发未改密/非管理员 403）→ 改密两路（旧密码/邮箱验证码，含各种 400）→
//   公开找回密码（防枚举：不存在邮箱同文案、无 dev_code）→ 手机号（格式/409/解绑）→
//   GitHub 未配置口径（status configured=false / auth 400）+ 飞书 status 不受影响 →
//   密码注册 password_set=1 且无公告 / 保留用户名 share → share1。
//
// 全程沙盒：临时库 + 临时附件目录 + 临时 cwd（无 .env → mailer 开发模式回传 dev_code），
// 不打正在运行的开发实例、不碰真实 compass.db。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKEND = join(ROOT, 'backend');
const SCHEMA = join(BACKEND, 'db', 'schema.sql');
const CASE = process.argv[2];

// ---------- 子进程 1：构造「待迁移老库」 ----------
// 直接执行当前 schema.sql（结构是新的），但把 user_version 留在 0 并塞入老用户（随机废哈希）——
// user_version 闸门之后的回填路径（重置密码/插公告/补 slug）与真实老库逐字相同；
// migCol 的 ALTER 路径是平凡分支，已在开发期单独验证。
if (CASE === 'fixture') {
  const dbPath = process.env.SMK_DB;
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.exec('PRAGMA user_version = 0;');
  db.prepare("INSERT INTO user (username,password_hash,nickname,email,is_admin) VALUES ('oldalice','junk$00','爱丽丝','alice@old.dev',1)").run();
  db.prepare("INSERT INTO user (username,password_hash,nickname,email) VALUES ('oldbob','junk$00','鲍勃','bob@old.dev')").run();
  db.prepare("INSERT INTO user (username,password_hash,nickname,email) VALUES ('oldcarol','junk$00','卡罗尔','carol@old.dev')").run();
  // 同用户两个同名帖 → slug 加 -2；另一用户同名不冲突
  db.prepare("INSERT INTO share_post (user_id,title) VALUES (1,'我的竞赛资料 2026')").run();
  db.prepare("INSERT INTO share_post (user_id,title) VALUES (1,'我的竞赛资料 2026')").run();
  db.prepare("INSERT INTO share_post (user_id,title) VALUES (2,'我的竞赛资料 2026')").run();
  db.close();
  process.exit(0);
}

// ---------- 主控 ----------
const PORT = 3107;
const BASE = `http://localhost:${PORT}/api`;
const work = mkdtempSync(join(tmpdir(), 'smk-acct-'));
const dbPath = join(work, 'compass.db');
const serverEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot, // Windows 下 node 网络栈需要
  PORT: String(PORT),
  DB_PATH: dbPath,
  HONOR_UPLOAD_DIR: join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: join(work, 'purchase'),
  // 显式不带任何 SMTP_*/GITHUB_*：开发模式邮件回传 dev_code，GitHub 显示未配置
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}${extra ? ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`)); };

const jsonReq = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const res = await fetch(BASE + path, {
    headers, method: opts.method || 'GET',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (path, opts = {}) => {
  const { res, data } = await jsonReq(path, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const expect = async (path, status, opts = {}) => {
  const { res, data } = await jsonReq(path, opts);
  return { ok: res.status === status, got: res.status, data };
};
// 开发模式取验证码（未配 SMTP 时 send-code 回传 dev_code）
const devCode = async (email, purpose, token) => {
  const r = await api('/auth/send-code', { method: 'POST', token, body: { email, purpose } });
  if (!r.dev_code) throw new Error(`send-code ${email}/${purpose} 未回传 dev_code：${JSON.stringify(r)}`);
  return r.dev_code;
};

let server = null;
const serverLog = [];
try {
  // 1) 夹具建库
  const fx = spawnSync(process.execPath, [process.argv[1], 'fixture'], {
    env: { ...process.env, SMK_DB: dbPath }, encoding: 'utf8',
  });
  if (fx.status !== 0) throw new Error('夹具子进程失败：' + fx.stderr);

  // 2) 起临时后端（cwd=临时目录：server.js 找不到 .env → 邮件必然走开发模式）
  server = spawn(process.execPath, [join(BACKEND, 'server.js')], {
    cwd: work, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  server.stdout.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push('[out] ' + l)));
  server.stderr.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push('[err] ' + l)));

  const ready = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://localhost:${PORT}/api/health`);
        if (r.ok) return true;
      } catch { /* 等服务起来 */ }
      await new Promise((s) => setTimeout(s, 250));
    }
    return false;
  })();
  if (!ready) throw new Error('临时后端 15s 内未就绪');
  console.log('— 临时后端已就绪（沙盒库 ' + dbPath + '）');

  // ---------- 3. 迁移回填断言（直连临时库只读） ----------
  const db = new DatabaseSync(dbPath, { readOnly: true });
  ok('迁移闸门 user_version=2（v1 密码/slug + v2 资源两类）', Number(db.prepare('PRAGMA user_version').get().user_version) === 2);
  const olds = db.prepare('SELECT id,username,email,password_hash,password_set FROM user ORDER BY id').all();
  ok('老用户 3 人全部 password_set=0', olds.length === 3 && olds.every((u) => u.password_set === 0), olds.map((u) => u.password_set));
  ok('密码哈希已被重置（非旧 junk$00，salt$64hex）', olds.every((u) =>
    /^[0-9a-f]{32}\$[0-9a-f]{128}$/.test(u.password_hash)));
  const notices = db.prepare("SELECT user_id,type,title,content,link,is_read FROM personal_notice WHERE type='password_init' ORDER BY user_id").all();
  ok('每人恰好 1 条初始密码公告', notices.length === 3 && notices.every((n) => n.is_read === 0 && n.link === '/account-security' && n.content.includes('gkjsdh123')));
  const slug1 = db.prepare('SELECT slug FROM share_post WHERE id=1').get().slug;
  const slug2 = db.prepare('SELECT slug FROM share_post WHERE id=2').get().slug;
  const slug3 = db.prepare('SELECT slug FROM share_post WHERE id=3').get().slug;
  ok('slug 回填：空白转-、剥危险字符', slug1 === '我的竞赛资料-2026', [slug1, slug2, slug3]);
  ok('同用户同名帖 slug 加 -2', slug2 === '我的竞赛资料-2026-2', slug2);
  ok('不同用户同名 slug 不冲突', slug3 === '我的竞赛资料-2026', slug3);
  db.close();

  // ---------- 4. 初始密码登录 ----------
  let g = await expect('/auth/login', 401, { method: 'POST', body: { email: 'alice@old.dev', password: 'wrong-pass' } });
  ok('错误密码 401', g.ok);
  const rA = await api('/auth/login', { method: 'POST', body: { email: 'alice@old.dev', password: 'gkjsdh123' } });
  ok('初始密码登录成功且 password_set=false', rA.user.password_set === false, rA.user);
  const tA = rA.token;
  const rB = await api('/auth/login', { method: 'POST', body: { email: 'bob@old.dev', password: 'gkjsdh123' } });
  const tB = rB.token;
  const rC = await api('/auth/login', { method: 'POST', body: { username: 'oldcarol', password: 'gkjsdh123' } });
  const tC = rC.token;
  ok('存量用户名+初始密码同样可登录', !!tC);

  g = await expect('/auth/change-password', 401, { method: 'POST', body: { new_password: 'whatever1' } });
  ok('未登录不能改密 401', g.ok);

  // ---------- 5. 个人公告 ----------
  const uc0 = await api('/notifications/unread-count', { token: tA });
  ok('未读计数含 notices=1 且计入 total', uc0.notices === 1 && uc0.total >= 1, uc0);
  const pn = await api('/notifications/personal', { token: tA });
  ok('个人公告列表 1 条，标题/链接正确', pn.rows.length === 1 && pn.rows[0].title.includes('初始密码') && pn.rows[0].link === '/account-security', pn);

  // ---------- 6. 邮箱验证码自动注册（新用户也落初始密码） ----------
  const stamp = Date.now().toString(36);
  const daveMail = `dave_${stamp}@new.dev`;
  const code = await devCode(daveMail, 'login');
  const rD = await api('/auth/email-login', { method: 'POST', body: { email: daveMail, code } });
  const tD = rD.token;
  ok('验证码自动注册：password_set=false 且有 migrated 字段', rD.user.password_set === false && 'migrated' in rD, rD.user);
  const rDlogin = await api('/auth/login', { method: 'POST', body: { email: daveMail, password: 'gkjsdh123' } });
  ok('自动注册用户可用初始密码登录', rDlogin.user.password_set === false);

  g = await expect('/auth/send-code', 400, { method: 'POST', body: { email: daveMail, purpose: 'evil' } });
  ok('send-code 非法 purpose 400', g.ok);

  // ---------- 7. 公开找回密码的防账号枚举 ----------
  const ghostMail = `ghost_${stamp}@nowhere.dev`;
  const sc = await api('/auth/send-code', { method: 'POST', body: { email: ghostMail, purpose: 'reset' } });
  ok('不存在邮箱发重置码：成功文案且不回传 dev_code', !sc.dev_code, sc);
  g = await expect('/auth/reset-password', 400, { method: 'POST', body: { email: ghostMail, code: '000000', new_password: 'whatever1' } });
  ok('不存在邮箱重置：与验证码错误同文案 404→400', g.ok && g.data.error === '验证码错误或已过期，请重新获取', g.data);
  g = await expect('/auth/reset-password', 400, { method: 'POST', body: { email: 'bob@old.dev', code: '999999', new_password: 'whatever1' } });
  ok('错误重置码 400 同文案', g.ok && g.data.error === '验证码错误或已过期，请重新获取');

  // ---------- 8. 管理员补发提醒：全员都有未读公告时一条不重发 ----------
  let rem = await api('/admin/notices/password-remind', { method: 'POST', token: tA });
  ok('补发#1：4 人待改但都有未读公告 → sent=0 total=4', rem.sent === 0 && rem.total === 4, rem);
  g = await expect('/admin/notices/password-remind', 403, { method: 'POST', token: tC });
  ok('非管理员补发 403', g.ok);

  // ---------- 9. Alice：旧密码方式改密 ----------
  g = await expect('/auth/change-password', 400, { method: 'POST', token: tA, body: { old_password: 'wrong-old', new_password: 'aliceNewPw9' } });
  ok('旧密码不正确 400', g.ok);
  g = await expect('/auth/change-password', 400, { method: 'POST', token: tA, body: { old_password: 'gkjsdh123', new_password: '12345' } });
  ok('新密码不足 6 位 400', g.ok);
  g = await expect('/auth/change-password', 400, { method: 'POST', token: tA, body: { old_password: 'gkjsdh123', new_password: 'gkjsdh123' } });
  ok('初始密码态：新密码仍为初始密码被拒', g.ok && g.data.error.includes('初始密码'), g.data);
  let cp = await api('/auth/change-password', { method: 'POST', token: tA, body: { old_password: 'gkjsdh123', new_password: 'aliceNewPw9' } });
  ok('旧密码方式改密成功 password_set=true', cp.user.password_set === true, cp.user);
  g = await expect('/auth/login', 401, { method: 'POST', body: { email: 'alice@old.dev', password: 'gkjsdh123' } });
  ok('改密后旧密码失效 401', g.ok);
  const rA2 = await api('/auth/login', { method: 'POST', body: { email: 'alice@old.dev', password: 'aliceNewPw9' } });
  ok('新密码可登录', rA2.user.password_set === true);
  const ucA = await api('/notifications/unread-count', { token: tA });
  ok('改密成功后初始密码公告自动已读（notices=0）', ucA.notices === 0, ucA);

  // ---------- 10. Bob：邮箱验证码方式改密 ----------
  const bCode = await devCode('bob@old.dev', 'reset');
  g = await expect('/auth/change-password', 400, { method: 'POST', token: tB, body: { code: '000000', new_password: 'bobNewPw99' } });
  ok('改密验证码错误 400', g.ok);
  cp = await api('/auth/change-password', { method: 'POST', token: tB, body: { code: bCode, new_password: 'bobNewPw99' } });
  ok('验证码方式改密成功', cp.user.password_set === true, cp.user);
  const rB2 = await api('/auth/login', { method: 'POST', body: { email: 'bob@old.dev', password: 'bobNewPw99' } });
  ok('Bob 新密码可登录', !!rB2.token);

  // ---------- 11. 补发去重：公告已读后才补，已改密的不发 ----------
  await api('/notifications/personal/read-all', { method: 'POST', token: tC }); // carol 仍是初始密码态
  await api('/notifications/personal/read-all', { method: 'POST', token: tD }); // dave 同
  rem = await api('/admin/notices/password-remind', { method: 'POST', token: tA });
  ok('补发#2：待改 2 人（carol/dave）且公告已读 → sent=2 total=2', rem.sent === 2 && rem.total === 2, rem);
  rem = await api('/admin/notices/password-remind', { method: 'POST', token: tA });
  ok('补发#3：刚补过均未读 → sent=0 不重复', rem.sent === 0 && rem.total === 2, rem);
  const pnC = await api('/notifications/personal', { token: tC });
  ok('Carol 两条公告（迁移一条+补发一条）', pnC.rows.length === 2, pnC.rows.length);

  // ---------- 12. Carol：公开找回密码流 ----------
  const cCode = await devCode('carol@old.dev', 'reset');
  const rp = await api('/auth/reset-password', { method: 'POST', body: { email: 'carol@old.dev', code: cCode, new_password: 'carolNewPw9' } });
  ok('公开重置密码成功', !!rp.message, rp);
  const rC2 = await api('/auth/login', { method: 'POST', body: { email: 'carol@old.dev', password: 'carolNewPw9' } });
  ok('Carol 重置后新密码登录且 password_set=true', rC2.user.password_set === true);
  const ucC = await api('/notifications/unread-count', { token: tC });
  ok('重置后历史初始密码公告全部已读', ucC.notices === 0, ucC);

  // ---------- 13. Dave 旧密码方式改密（自动注册用户） ----------
  cp = await api('/auth/change-password', { method: 'POST', token: tD, body: { old_password: 'gkjsdh123', new_password: 'daveNewPw99' } });
  ok('自动注册用户旧密码改密成功', cp.user.password_set === true);
  const ucD = await api('/notifications/unread-count', { token: tD });
  ok('Dave 改密后补发公告也自动已读', ucD.notices === 0, ucD);
  rem = await api('/admin/notices/password-remind', { method: 'POST', token: tA });
  ok('补发#4：全员已改密 → total=0', rem.sent === 0 && rem.total === 0, rem);

  // ---------- 14. 手机号 ----------
  g = await expect('/auth/phone', 400, { method: 'PUT', token: tD, body: { phone: '12345' } });
  ok('手机号格式错误 400', g.ok);
  g = await expect('/auth/phone', 400, { method: 'PUT', token: tD, body: { phone: '02345678901' } });
  ok('非 1[3-9] 开头号段 400', g.ok);
  let ph = await api('/auth/phone', { method: 'PUT', token: tD, body: { phone: '13800138000' } });
  ok('绑定手机号成功（提示暂未验证）', ph.user.phone === '13800138000' && ph.message.includes('未验证'), ph);
  g = await expect('/auth/phone', 409, { method: 'PUT', token: tC, body: { phone: '13800138000' } });
  ok('同一手机号绑第二个账号 409', g.ok);
  ph = await api('/auth/phone', { method: 'PUT', token: tD, body: { phone: '' } });
  ok('手机号解绑成功', ph.user.phone === '');

  // ---------- 15. GitHub 未配置 + 飞书无影响 ----------
  const gcfg = await jsonReq('/github/oauth/configured');
  ok('匿名 configured 公开可取且=false', gcfg.res.ok && gcfg.data.configured === false, gcfg.data);
  g = await expect('/github/oauth/status', 401);
  ok('GitHub status 需登录 401', g.ok);
  const gh = await api('/github/oauth/status', { token: tD });
  ok('未配 env：GitHub configured=false/bound=false', gh.configured === false && gh.bound === false, gh);
  g = await expect('/github/oauth/auth', 400, { token: tD });
  ok('未配 env：发起 GitHub 授权 400 友好错误', g.ok && g.data.error.includes('GITHUB'), g.data);
  const fs = await jsonReq('/feishu/oauth/status', { token: tD });
  ok('飞书 status 不受影响仍 200', fs.res.ok, fs.data);

  // ---------- 16. 密码注册：自带密码、无公告 ----------
  const erinMail = `erin_${stamp}@new.dev`;
  const rE = await api('/auth/register', { method: 'POST', body: { email: erinMail, password: 'erinSecret9', nickname: '艾琳' } });
  ok('密码注册 201 且 password_set=true', rE.user.password_set === true && rE.user.nickname === '艾琳', rE.user);
  const ucE = await api('/notifications/unread-count', { token: rE.token });
  ok('密码注册用户无初始密码公告', ucE.notices === 0, ucE);

  // ---------- 17. 保留用户名避让 ----------
  const shareCode = await devCode('share@r.dev', 'login');
  const rS = await api('/auth/email-login', { method: 'POST', body: { email: 'share@r.dev', code: shareCode } });
  ok('顶层保留名 share → 用户名自动避让（share1）', rS.user.username === 'share1', rS.user);
} catch (e) {
  fail++;
  console.error('💥 冒烟异常：', e.message);
  console.error(serverLog.slice(-30).join('\n'));
} finally {
  if (server) {
    try {
      process.platform === 'win32'
        ? spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)])
        : server.kill('SIGKILL');
    } catch { /* 已退出 */ }
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 沙盒清理尽力而为 */ }
}

console.log(`\n账号安全冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
