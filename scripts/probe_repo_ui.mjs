// 浏览器探针（Playwright + Chromium）：GitHub 风资源路由 + 账号安全中心 全链路 UI 走查
//
// 链路：
//   开源大厅点项目 → /:u/:slug 真实路由 → 目录 /tree 逐级下钻 + 面包屑回跳 →
//   文件 /blob 预览 + F5 刷新停留同页 → 用户主页 → /share/:id 旧链自动 replace →
//   「我的」行内开关开源/私密（匿名大厅/直链/用户主页同步消失，404 防探测）→
//   邮箱验证码自动注册 = 初始密码态 + 个人公告 → 初始密码横幅 → 账号安全页邮箱验证码改密；
//   登录页忘记密码公开重置流；GitHub 未配置置灰；后台密码状态列 + 一键提醒（去重/补发）；
//   消息中心「系统通知」组；390px 无横溢。
//
// 沙盒：cwd=临时目录（无 .env → 邮件 dev_code）+ 临时 DB + 临时 SHARE/HONOR/PURCHASE 目录，
// 跑完只删临时目录，绝不碰真实 uploads。
// 运行：node scripts/probe_repo_ui.mjs
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const PORT = 3108, VITE = 5199;
const API = `http://localhost:${PORT}/api`, WEB = `http://localhost:${VITE}`;

const work = mkdtempSync(path.join(os.tmpdir(), 'probe_repo_'));
const dbPath = path.join(work, 'ui.db');
const serverEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  PORT: String(PORT),
  DB_PATH: dbPath,
  SHARE_UPLOAD_DIR: path.join(work, 'share'),
  HONOR_UPLOAD_DIR: path.join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: path.join(work, 'purchase'),
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}${extra ? `  ← ${extra}` : ''}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(url, n = 60) {
  for (let i = 0; i < n; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* 还没起 */ }
    await sleep(500);
  }
  throw new Error(`服务未就绪：${url}`);
}
const jreq = async (p, opts = {}) => {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(API + p, {
    method: opts.method || 'GET',
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined && !isForm ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, opts = {}) => {
  const { res, data } = await jreq(p, opts);
  if (!res.ok) throw new Error(`${p} ${res.status} ${JSON.stringify(data)}`);
  return data;
};

// multipart 上传项目文件夹：entries = [[文件名, 文本, 相对路径], ...]
async function uploadFolder(token, entries) {
  const fd = new FormData();
  const paths = [];
  for (const [name, content, rel] of entries) {
    fd.append('files', new Blob([content], { type: 'text/plain' }), name);
    paths.push(rel);
  }
  fd.append('paths', JSON.stringify(paths));
  return api('/share/uploads', { method: 'POST', token, body: fd });
}

// 邮箱验证码登录/注册（dev 模式直接拿 dev_code）
async function emailLogin(email) {
  const sc = await api('/auth/send-code', { method: 'POST', body: { email, purpose: 'login' } });
  if (!sc.dev_code) throw new Error('未拿到 dev_code（后端误读到了真实 .env？）');
  return api('/auth/email-login', { method: 'POST', body: { email, code: sc.dev_code } });
}

// ---- 起服务（后端 cwd=临时目录，找不到 .env，邮件走 dev_code）----
const children = [];
function start(cmd, args, cwd, env) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: false });
  children.push(p);
  return p;
}
const beLog = [];
const backend = start(process.execPath, [path.join(BACKEND, 'server.js')], work, serverEnv);
backend.stdout.on('data', (b) => beLog.push(b.toString()));
backend.stderr.on('data', (b) => beLog.push(b.toString()));
const viteLog = [];
const vite = start(process.execPath, [path.join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
  '--port', String(VITE), '--strictPort'], path.join(ROOT, 'frontend'), { VITE_API_TARGET: `http://localhost:${PORT}` });
vite.stdout.on('data', (b) => viteLog.push(b.toString()));
vite.stderr.on('data', (b) => viteLog.push(b.toString()));

let browser, page, context;
try {
  await waitUp(`${API}/health`);
  await waitUp(WEB);
  console.log('—— 服务就绪 ——');

  // ---- 夹具：A 楼主、B 忘密路人（密码注册）；C 邮箱验证码自动注册（天然初始密码态）----
  const stamp = Date.now().toString(36);
  const emailA = `oa_${stamp}@x.dev`, emailB = `ob_${stamp}@x.dev`, emailC = `oc_${stamp}@x.dev`;
  let A = await api('/auth/register', { method: 'POST', body: { email: emailA, password: 'pass123456', nickname: '楼主A' } });
  await api('/auth/register', { method: 'POST', body: { email: emailB, password: 'pass123456', nickname: '路人B' } });
  const C = await emailLogin(emailC);
  ok('验证码自动注册 → password_set=false（初始密码态）', C.user.password_set === false, JSON.stringify(C.user));
  const cNotices0 = await api('/notifications/personal', { token: C.token });
  ok('自动注册即收到改密个人公告，link=/account-security',
    cNotices0.rows.length >= 1 && cNotices0.rows[0].link === '/account-security', JSON.stringify(cNotices0.rows[0]));
  const cCnt0 = await api('/notifications/unread-count', { token: C.token });
  ok('C 未读总数含 notices≥1', cCnt0.notices >= 1 && cCnt0.total >= cCnt0.notices, JSON.stringify(cCnt0));

  const uA = A.user.username;
  const title = `探针仓库 ProbeKit${stamp}`;
  const up = await uploadFolder(A.token, [
    ['readme.md', '# ProbeKit\n探针项目正文 ABC', 'readme.md'],
    ['page.html', [
      '<!doctype html><html><head><meta charset="utf-8"><title>探针页</title></head>',
      '<body><h1 id="t">探针网页渲染 OK</h1>',
      '<script>',
      "document.getElementById('t').textContent='JS_RUN_OK';",
      // 越权访问父窗口必须抛 SecurityError（opaque origin 隔离）；不抛=沙箱漏了
      "try{parent.document.body.setAttribute('data-xss','1')}",
      "catch(e){var d=document.createElement('div');d.id='iso';d.textContent='ISOLATED';document.body.appendChild(d);}",
      '</script></body></html>',
    ].join('\n'), 'page.html'],
    ['a.txt', 'aaa内容', 'docs/a.txt'],
    ['b.txt', 'bbb深层', 'docs/sub/b.txt'],
  ]);
  const created = await api('/share/posts', {
    method: 'POST', token: A.token,
    body: { title, content: '探针项目正文 ABC', files: up.rows.map((x) => x.id) },
  });
  const postId = created.id;
  const slug = created.slug;
  ok('发帖拿到 slug 且默认开源', !!slug && created.is_public === 1, JSON.stringify({ slug, is_public: created.is_public }));
  const projectUrl = `/${encodeURIComponent(uA)}/${encodeURIComponent(slug)}`;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  const consoleErrors = [];
  const badResp = [];
  // 资源 404 的 console 文本不含 URL（favicon 没法按文本过滤），直接在响应层记录。
  // 放行两类设计内 404：/favicon.ico（dev 模板无图标）；/api/share/p/ 私密防探测 404（第 7 步专门验证的契约）
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && !u.endsWith('/favicon.ico') && !u.includes('/api/share/p/')) {
      badResp.push(`${r.status()} ${u}`);
    }
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  // 登录注入：先写 localStorage 再 reload，保证 SPA 以登录态启动（auth.js 启动时读 storage）
  const authAs = async (u) => {
    await page.goto(WEB + '/');
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('ec_token', token);
      localStorage.setItem('ec_user', JSON.stringify(user));
    }, u);
    await page.reload({ waitUntil: 'load' });
  };
  const logout = async () => { await page.goto(WEB + '/'); await page.evaluate(() => localStorage.clear()); };
  const curUrl = () => new URL(page.url()).pathname;
  // 列表页：等列表请求落定再断言（空列表时不能靠等行）
  const gotoWaitList = async (urlPart) => {
    const p = page.waitForResponse(
      (r) => r.url().includes('/share/posts?') && r.request().method() === 'GET', { timeout: 10000 },
    );
    await page.goto(WEB + urlPart);
    await p;
  };

  // ===== 1. 开源大厅（匿名）：点行进 GitHub 风项目路由 =====
  await logout();
  await gotoWaitList('/share');
  const hallRow = page.locator('.gh-row', { hasText: title });
  await hallRow.waitFor({ timeout: 10000 });
  ok('大厅有「全部开源」标签 + 头部「项目上传」按钮（无仿路由面包屑）',
    (await page.locator('.gh-tab').allInnerTexts()).some((t) => t.includes('全部开源'))
    && (await page.locator('.gh-actions button', { hasText: '项目上传' }).count()) === 1
    && (await page.locator('.gh-crumb').count()) === 0);
  // 显式点标题格：行中心点在当前列宽下会落在「作者」列（作者名跳用户主页）
  await hallRow.locator('.gh-fname').click();
  await page.waitForURL(`**${projectUrl}`, { timeout: 8000 });
  ok('点行落地 /:username/:slug 真实路由', curUrl() === projectUrl, curUrl());

  // ===== 2. 项目根：面包屑（显示标题）+ 文件表 =====
  await page.locator('.pv-frow', { hasText: 'docs' }).waitFor();
  const crumbText = await page.locator('.pv-crumb').innerText();
  ok('面包屑含 @用户 与项目标题', crumbText.includes('@' + uA) && crumbText.includes(title), crumbText);
  ok('根目录为 docs + page.html + readme.md 三项（目录在前，文件按名）',
    (await page.locator('.pv-frow .pv-fname').allInnerTexts()).join('|') === 'docs|page.html|readme.md');
  await page.locator('.gh-rbody').waitFor();
  ok('README 正文渲染', (await page.locator('.gh-rbody').innerText()).includes('探针项目正文 ABC'));

  // ===== 3. /tree 逐级下钻 + URL =====
  await page.locator('.pv-frow', { hasText: 'docs' }).click();
  await page.waitForURL('**/tree/docs');
  ok('进目录 URL=/tree/docs', curUrl() === `${projectUrl}/tree/docs`, curUrl());
  const rowsDocs = await page.locator('.pv-frow').allInnerTexts();
  ok('docs 内有 a.txt 与 sub',
    rowsDocs.some((t) => t.includes('a.txt')) && rowsDocs.some((t) => t.includes('sub')), JSON.stringify(rowsDocs));
  await page.locator('.pv-frow', { hasText: 'sub' }).click();
  await page.waitForURL('**/tree/docs/sub');
  ok('二级目录 URL=/tree/docs/sub', curUrl() === `${projectUrl}/tree/docs/sub`);
  ok('sub 内有 b.txt', !!(await page.locator('.pv-frow', { hasText: 'b.txt' }).count()));

  // 面包屑 docs 段回跳（blob 视图同理，中间段永远指 /tree）
  await page.locator('.pv-crumb .pv-seg', { hasText: 'docs' }).click();
  await page.waitForURL('**/tree/docs');
  ok('面包屑回跳到 /tree/docs', curUrl() === `${projectUrl}/tree/docs`);

  // ===== 4. /blob 文件预览 + F5 刷新停留 =====
  await page.locator('.pv-frow', { hasText: 'a.txt' }).click();
  await page.waitForURL('**/blob/docs/a.txt');
  ok('文件 URL=/blob/docs/a.txt', curUrl() === `${projectUrl}/blob/docs/a.txt`, curUrl());
  await page.locator('.fp-pre').waitFor({ timeout: 8000 });
  ok('文本预览显示内容', (await page.locator('.fp-pre').innerText()).includes('aaa内容'));
  await page.reload({ waitUntil: 'load' });
  await page.locator('.fp-pre').waitFor({ timeout: 8000 });
  ok('F5 刷新后仍停在同文件同内容', curUrl() === `${projectUrl}/blob/docs/a.txt`
    && (await page.locator('.fp-pre').innerText()).includes('aaa内容'));
  await page.locator('.fp-btn.x').click();
  await page.waitForURL('**/tree/docs');
  ok('关闭预览回到所在目录', curUrl() === `${projectUrl}/tree/docs`);

  // ===== 4.5 html 文件：默认沙箱渲染网页（非源码），可切「代码」，脚本被 origin 隔离 =====
  await page.goto(`${WEB}${projectUrl}/blob/page.html`);
  const htmlFrameEl = page.locator('iframe.fp-html');
  await htmlFrameEl.waitFor({ state: 'visible', timeout: 10000 });
  const sandbox = await htmlFrameEl.getAttribute('sandbox') || '';
  ok('html 默认走 iframe 渲染且 sandbox 精确白名单（无 allow-same-origin）',
    sandbox === 'allow-scripts allow-popups allow-forms' && !sandbox.includes('allow-same-origin'), sandbox);
  ok('html iframe src 是 blob: objectURL（带请求头取字节，token 不进 URL）',
    (await htmlFrameEl.getAttribute('src') || '').startsWith('blob:'));
  // opaque origin 沙箱里的 Playwright 跨源 frame 可直接定位
  const fl = page.frameLocator('iframe.fp-html');
  await fl.locator('#t').waitFor({ timeout: 10000 });
  ok('网页被真正渲染（不是源码）且页内脚本已执行：#t=JS_RUN_OK',
    (await fl.locator('#t').innerText()) === 'JS_RUN_OK');
  ok('沙箱脚本越权访问父窗口被浏览器拒绝（#iso=ISOLATED，隔离生效）',
    (await fl.locator('#iso').innerText().catch(() => '')) === 'ISOLATED');
  ok('父窗口文档未被沙箱页写入 data-xss（同源后门不存在）',
    await page.evaluate(() => document.body.getAttribute('data-xss') || '') === '');
  ok('渲染态不显示源码 <pre>，工具栏有「网页/代码」开关',
    (await page.locator('.fp-pre').count()) === 0
    && (await page.locator('.fp-seg .fp-btn.on').innerText()) === '🌐 网页');
  const textP = page.waitForResponse((r) => r.url().includes('/files/') && r.url().includes('/text') && r.status() === 200, { timeout: 8000 });
  await page.locator('.fp-seg .fp-btn', { hasText: '代码' }).click();
  await textP;
  for (let i = 0; i < 20; i++) {
    if ((await page.locator('.fp-pre').innerText()).includes('<h1')) break;
    await sleep(100);
  }
  const srcView = await page.locator('.fp-pre').innerText();
  ok('切到代码态：显示转义源码（含 <h1>/<script> 原文），iframe 卸载',
    srcView.includes('探针网页渲染 OK') && srcView.includes('<script>')
    && srcView.includes('parent.document') && (await htmlFrameEl.count()) === 0);
  await page.locator('.fp-seg .fp-btn', { hasText: '网页' }).click();
  await page.locator('iframe.fp-html').waitFor({ state: 'visible', timeout: 8000 });
  ok('切回网页态：iframe 重新挂载渲染',
    (await page.frameLocator('iframe.fp-html').locator('#t').innerText()) === 'JS_RUN_OK');

  // ===== 5. 用户项目主页 =====
  await page.locator('.pv-crumb .pv-seg.owner').click();
  await page.waitForURL(`**/${encodeURIComponent(uA)}`);
  await page.waitForResponse((r) => r.url().includes('/share/u/'), { timeout: 10000 });
  ok('用户主页 URL=/:username 且含项目卡', curUrl() === `/${encodeURIComponent(uA)}`
    && !!(await page.locator('.up-name', { hasText: title }).count()));
  await page.locator('.up-name', { hasText: title }).click();
  await page.waitForURL(`**${projectUrl}`);

  // ===== 6. /share/:id 旧数字链自动 replace =====
  await page.goto(`${WEB}/share/${postId}`);
  await page.waitForURL(`**${projectUrl}`, { timeout: 8000 });
  ok('/share/:id 自动 replace 到新路由', curUrl() === projectUrl, curUrl());

  // ===== 7. 作者：「我的」行内开关转私密 =====
  // A 未实名：登录后落在首页即弹强制实名窗（全站硬门禁——不必进入任何业务模块，先过闸才能操作）
  await authAs(A);
  const gateA = page.locator('.el-dialog:visible', { hasText: '请先完成实名认证' });
  await gateA.waitFor({ timeout: 8000 });
  ok('首页即弹强制实名窗（无需进入预约/采购等模块）', curUrl() === '/' && (await gateA.count()) === 1, curUrl());
  ok('首页强制弹窗：无 X、无取消，只能填名',
    (await gateA.locator('.el-dialog__headerbtn:visible').count()) === 0
    && (await gateA.getByRole('button', { name: '取消' }).count()) === 0
    && (await gateA.getByRole('button', { name: '保存并继续' }).count()) === 1);
  await page.keyboard.press('Escape');
  await sleep(200);
  ok('ESC 后弹窗仍在', (await page.locator('.el-dialog:visible', { hasText: '请先完成实名认证' }).count()) === 1);
  await gateA.locator('input').fill('123');
  await gateA.getByRole('button', { name: '保存并继续' }).click();
  await sleep(200);
  ok('纯数字姓名前端即时拦截（弹窗不关、显示错误文案）',
    (await gateA.locator('.rn-err').innerText()).length > 0 && (await page.locator('.el-dialog:visible').count()) >= 1);
  const aCntBefore = await api('/notifications/unread-count', { token: A.token });
  ok('填写前 A 有未读实名公告', aCntBefore.notices >= 1, JSON.stringify(aCntBefore));
  await gateA.locator('input').fill('探针实名');
  const rnPut = page.waitForResponse((r) => r.url().includes('/auth/real-name') && r.request().method() === 'PUT' && r.status() === 200, { timeout: 8000 });
  await gateA.getByRole('button', { name: '保存并继续' }).click();
  await rnPut;
  // el-dialog 离场有 ~300ms 过渡，等它真正隐藏再断言
  const gateHome = page.locator('.el-dialog', { hasText: '请先完成实名认证' });
  await gateHome.waitFor({ state: 'hidden', timeout: 3000 });
  ok('首页填名后弹窗关闭、URL 仍停在首页（无 pendingTo 不跳转）', await gateHome.isHidden() && curUrl() === '/', curUrl());
  const aCntAfter = await api('/notifications/unread-count', { token: A.token });
  ok('实名后 A 的实名公告自动已读（notices=0）', aCntAfter.notices === 0, JSON.stringify(aCntAfter));
  A = { token: A.token, user: (await api('/auth/me', { token: A.token })).user };

  await gotoWaitList('/share');
  // 「我的」入口已移到头部「项目上传」旁；点击后 scope=mine 重新拉列表
  {
    const pMine = page.waitForResponse((r) => r.url().includes('/share/posts?') && r.url().includes('scope=mine'), { timeout: 10000 });
    await page.getByRole('button', { name: '📝 我的项目' }).click();
    await pMine;
  }
  await page.locator('.gh-row', { hasText: title }).waitFor();
  const myRow = page.locator('.gh-row', { hasText: title });
  await myRow.locator('.el-switch').click();
  await page.getByText(/已转为私密项目/).waitFor({ timeout: 6000 });
  ok('私密化成功提示 + 行内出现 🔒', (await myRow.innerText()).includes('🔒'));

  // 匿名：大厅消失 / 直链 404 / 用户主页不可见
  await logout();
  await gotoWaitList('/share');
  ok('匿名大厅不再列出私密项目', !(await page.locator('.gh-row', { hasText: title }).count()));
  await page.goto(WEB + projectUrl);
  await page.locator('.pv-404').waitFor({ timeout: 8000 });
  ok('匿名直链私密项目 → 404 防探测', (await page.locator('.pv-404').innerText()).includes('项目不存在'));
  await page.goto(`${WEB}/${encodeURIComponent(uA)}`);
  await page.waitForResponse((r) => r.url().includes('/share/u/'), { timeout: 10000 });
  ok('匿名用户主页不含私密项目', !(await page.locator('.up-name', { hasText: title }).count()));

  // 作者仍可访问；About 开关转回开源
  await authAs(A);
  await page.goto(WEB + projectUrl);
  await page.locator('.gh-rbody').waitFor();
  ok('作者本人可访问私密项目', curUrl() === projectUrl);
  await page.locator('.pv-aside .el-switch').click();
  await page.getByText(/已设为开源项目/).waitFor({ timeout: 6000 });
  await logout();
  await gotoWaitList('/share');
  ok('转回开源后匿名大厅重新可见', !!(await page.locator('.gh-row', { hasText: title }).count()));

  // ===== 8. 初始密码横幅 → 账号安全 → 邮箱验证码改密 =====
  // 直接把 A 置为初始密码态（模拟存量用户迁移）；重新登录拿 password_set=false 的 user 卡
  const adminDb = new DatabaseSync(dbPath);
  adminDb.exec('PRAGMA busy_timeout=5000');
  adminDb.prepare('UPDATE user SET password_set = 0 WHERE id = ?').run(A.user.id);
  adminDb.close();
  const relogA = await api('/auth/login', { method: 'POST', body: { email: emailA, password: 'pass123456' } });
  A = { token: relogA.token, user: relogA.user };
  ok('初始密码态登录放行（软提示）', relogA.user.password_set === false);
  await authAs(A);
  await page.locator('.pw-bar').waitFor({ timeout: 6000 });
  ok('初始密码横幅显示', (await page.locator('.pw-bar').innerText()).includes('初始密码'));
  await page.locator('.pw-bar .pw-go').click();
  await page.waitForURL('**/account-security');
  await page.locator('.ac-banner').waitFor();
  ok('安全页顶部警示 + 密码卡红标',
    (await page.locator('.ac-banner').innerText()).includes('初始密码')
    && !!(await page.locator('.ac-card', { hasText: '初始密码待修改' }).count()));
  // GitHub 未配置：按钮置灰显示「未配置」
  await page.locator('.ac-card', { hasText: 'GitHub 账号' }).getByRole('button', { name: '未配置' }).waitFor({ timeout: 8000 });
  ok('GitHub 卡未配置态置灰', true);

  await page.locator('.ac-card', { hasText: '登录密码' }).getByRole('button', { name: '修改密码' }).click();
  const dlg = page.locator('.el-dialog:visible');
  await dlg.waitFor();
  const codeP = page.waitForResponse((r) => r.url().includes('/auth/send-code'), { timeout: 8000 });
  await dlg.getByRole('button', { name: '发送验证码' }).click();
  await codeP; // dev_code 随响应返回，前端自动回填
  await dlg.locator('input[placeholder="新密码"]').fill('newpass999');
  await dlg.locator('input[placeholder="再输一次新密码"]').fill('newpass999');
  await dlg.getByRole('button', { name: '确认修改' }).click();
  await page.getByText('密码修改成功').waitFor({ timeout: 8000 });
  ok('邮箱验证码改密成功', true);
  await sleep(300);
  ok('横幅消失（password_set 翻 1）', !(await page.locator('.pw-bar').count()));
  ok('密码卡变为已设置', (await page.locator('.ac-card', { hasText: '登录密码' }).innerText()).includes('已设置'));
  const loginNew = await jreq('/auth/login', { method: 'POST', body: { email: emailA, password: 'newpass999' } });
  ok('新密码可登录且 password_set=true', loginNew.res.ok && loginNew.data.user.password_set === true);
  const loginOld = await jreq('/auth/login', { method: 'POST', body: { email: emailA, password: 'pass123456' } });
  ok('旧密码被拒 401', loginOld.res.status === 401, `实际 ${loginOld.res.status}`);

  // ===== 8.5 账号安全页：实名卡已实名态（首页闸机已在 §7 过过），「修改」弹窗可关闭、改名即时生效 =====
  const rnCard = page.locator('.ac-card', { hasText: '实名认证' }).first();
  await rnCard.waitFor({ timeout: 8000 });
  ok('实名卡显示「已实名」绿标 + 真名',
    (await rnCard.innerText()).includes('已实名') && (await rnCard.innerText()).includes('探针实名'));
  await rnCard.getByRole('button', { name: '修改' }).click();
  const rnDlg = page.locator('.el-dialog:visible', { hasText: '请先完成实名认证' });
  await rnDlg.waitFor({ timeout: 6000 });
  ok('账号页修改弹窗可关闭（有 X 与取消，区别于硬门禁）',
    (await rnDlg.locator('.el-dialog__headerbtn:visible').count()) === 1
    && (await rnDlg.getByRole('button', { name: '取消' }).count()) === 1);
  const rnPut2 = page.waitForResponse((r) => r.url().includes('/auth/real-name') && r.request().method() === 'PUT', { timeout: 8000 });
  await rnDlg.locator('input').fill('探针实名改');
  await rnDlg.getByRole('button', { name: '保存并继续' }).click();
  await rnPut2;
  await sleep(400);
  ok('改名后弹窗关闭，卡片更新为新真名',
    (await page.locator('.el-dialog:visible', { hasText: '请先完成实名认证' }).count()) === 0
    && (await rnCard.innerText()).includes('已实名') && (await rnCard.innerText()).includes('探针实名改'));

  // ===== 9. 登录页「忘记密码」公开重置流（B 账号，未登录）=====
  await logout();
  await page.goto(WEB + '/login');
  await page.getByText('邮箱+密码').click();
  await page.getByText('忘记密码？').click();
  const rdlg = page.locator('.el-dialog:visible');
  await rdlg.waitFor();
  ok('忘记密码弹窗出现', (await rdlg.locator('.el-dialog__title').innerText()).includes('重置密码'));
  await rdlg.locator('input').first().fill(emailB);
  const rcP = page.waitForResponse((r) => r.url().includes('/auth/send-code'), { timeout: 8000 });
  await rdlg.getByRole('button', { name: '发送验证码' }).click();
  await rcP;
  await rdlg.locator('input[placeholder="新密码"]').fill('reset778899');
  await rdlg.locator('input[placeholder="再输一次新密码"]').fill('reset778899');
  await rdlg.getByRole('button', { name: '确认重置' }).click();
  await page.getByText(/密码已重置/).waitFor({ timeout: 8000 });
  const loginReset = await jreq('/auth/login', { method: 'POST', body: { email: emailB, password: 'reset778899' } });
  ok('公开重置后新密码可登录', loginReset.res.ok);

  // ===== 10. 后台：密码状态列 + 一键提醒（先已读 → 补发 1 条；验证去重/计数）=====
  // C 的未读公告先标已读，提醒才会补发（后端对未读同 type 去重）
  const cNotices1 = await api('/notifications/personal', { token: C.token });
  // C 现有两类公告（初始密码 + 实名提醒）：只把改密公告标已读，补发断言才精确
  const pwRow = cNotices1.rows.find((r) => r.type === 'password_init');
  await api(`/notifications/personal/${pwRow.id}/read`, { method: 'POST', token: C.token });
  const db2 = new DatabaseSync(dbPath);
  db2.exec('PRAGMA busy_timeout=5000');
  db2.prepare('UPDATE user SET is_admin = 1 WHERE id = ?').run(A.user.id);
  db2.close();
  const me = await api('/auth/me', { token: loginNew.data.token });
  A = { token: loginNew.data.token, user: me.user };
  await authAs(A);
  await page.goto(WEB + '/admin-console');
  await page.getByRole('button', { name: /提醒未改密用户/ }).waitFor({ timeout: 8000 });
  await page.locator('.el-table').first().locator('tr', { hasText: emailC }).waitFor();
  ok('用户表出现「初始密码」红标（C 行）',
    (await page.locator('.el-table').first().innerText()).includes('初始密码'));
  const remindP = page.waitForResponse((r) => r.url().includes('/admin/notices/password-remind'), { timeout: 8000 });
  await page.getByRole('button', { name: /提醒未改密用户/ }).click();
  const remindRes = await (await remindP).json();
  ok('提醒接口只补发 C（sent=1,total=1）', remindRes.sent === 1 && remindRes.total === 1, JSON.stringify(remindRes));
  await page.getByText(/已向 1 位/).waitFor({ timeout: 6000 });
  const cnt = await api('/notifications/unread-count', { token: C.token });
  ok('补发后 C 未读 notices 再 ≥1', cnt.notices >= 1, JSON.stringify(cnt));
  // C 马上要在浏览器里操作消息中心：全站门禁登录即拦，先 API 实名并用最新 user 卡注入
  await api('/auth/real-name', { method: 'PUT', token: C.token, body: { real_name: '探针西名' } });
  C.user = (await api('/auth/me', { token: C.token })).user;

  // ===== 11. 消息中心「系统通知」组 UI 可见（C 登录）=====
  await authAs(C);
  await page.locator('.dock-fab').click();
  await page.locator('.dock-tool[title="消息中心"]').click();
  const noticeTab = page.locator('.el-tabs__item', { hasText: '系统通知' });
  await noticeTab.waitFor({ timeout: 8000 });
  const noticeBadge = await noticeTab.locator('.t-num').innerText().catch(() => '');
  await noticeTab.click(); // 默认激活的是私信评论，需手动切到系统通知
  await page.locator('.n-item').first().waitFor({ timeout: 8000 });
  ok('消息中心「系统通知」组有红标且列出改密公告',
    Number(noticeBadge) >= 1
    && (await page.locator('body').innerText()).includes('请尽快修改初始密码'),
    `badge=${noticeBadge}`);

  // ===== 11.5 实名硬门禁：未实名 B 登录后首页即弹窗；再硬加载 /booking 取消初始导航，填名后自动放行 =====
  await authAs({ token: loginReset.data.token, user: loginReset.data.user });
  const gateB = page.locator('.el-dialog:visible', { hasText: '请先完成实名认证' });
  await gateB.waitFor({ timeout: 8000 });
  ok('未实名 B 登录后首页即弹硬门禁窗（全站口径，不用先进业务模块）', curUrl() === '/', curUrl());
  ok('硬门禁弹窗：无 X、无取消，只能实名',
    (await gateB.locator('.el-dialog__headerbtn:visible').count()) === 0
    && (await gateB.getByRole('button', { name: '取消' }).count()) === 0
    && (await gateB.getByRole('button', { name: '保存并继续' }).count()) === 1);
  await page.keyboard.press('Escape');
  await sleep(200);
  ok('ESC 后弹窗仍在', (await page.locator('.el-dialog:visible', { hasText: '请先完成实名认证' }).count()) === 1);
  // 弹窗压顶时硬加载受保护模块：守卫取消「初始导航」（组件不挂载、不发列表请求），目标记入 pendingTo
  await page.goto(WEB + '/booking');
  await sleep(300);
  ok('硬加载 /booking 仍被弹窗拦截（导航取消）',
    (await page.locator('.el-dialog:visible', { hasText: '请先完成实名认证' }).count()) === 1);
  await gateB.locator('input').fill('路乙实名');
  const enterP = page.waitForResponse((r) => r.url().includes('/booking/projects') && r.request().method() === 'GET' && r.status() === 200, { timeout: 10000 });
  await gateB.getByRole('button', { name: '保存并继续' }).click();
  await page.waitForURL('**/booking', { timeout: 10000 });
  await enterP;
  ok('实名保存后自动跳转到 /booking 且预约列表 200', curUrl() === '/booking', curUrl());
  // el-dialog 离场有 ~300ms 过渡，立即数 :visible 会误判；等它真正隐藏
  const gateDlg = page.locator('.el-dialog', { hasText: '请先完成实名认证' });
  await gateDlg.waitFor({ state: 'hidden', timeout: 3000 });
  ok('门禁弹窗已消失', await gateDlg.isHidden());

  // ===== 12. 390px 窄屏：项目页 / 大厅无横向溢出 =====
  await page.setViewportSize({ width: 390, height: 844 });
  await logout();
  await page.goto(`${WEB}${projectUrl}`);
  await page.locator('.pv-frow').first().waitFor();
  const overflowProj = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('项目页 390px 无横向溢出', overflowProj <= 1, `溢出 ${overflowProj}px`);
  await gotoWaitList('/share');
  await page.locator('.gh-row').first().waitFor();
  const overflowHall = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('大厅 390px 无横向溢出', overflowHall <= 1, `溢出 ${overflowHall}px`);

  ok('全程浏览器无 page 错误与非 favicon 4xx/5xx',
    consoleErrors.length === 0 && badResp.length === 0,
    [...consoleErrors, ...badResp].slice(0, 3).join(' | '));

  await context.close();
} catch (e) {
  fail++;
  console.error('探针异常：', e);
  try {
    const sp = path.join(ROOT, 'scripts', '.probe_repo_error.png');
    await page.screenshot({ path: sp, fullPage: true });
    console.log('异常截图：', sp);
  } catch { /* 页没了 */ }
  console.log('—— 后端日志尾 ——\n' + beLog.slice(-20).join(''));
  console.log('—— vite 日志尾 ——\n' + viteLog.slice(-10).join(''));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of children) {
    try { process.platform === 'win32' ? spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)]) : p.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  await sleep(800);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

if (beLog.some((l) => /ERROR|uncaught/i.test(l))) console.log('⚠️ 后端日志含 ERROR 字样');
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
