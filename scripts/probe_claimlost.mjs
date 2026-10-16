// 浏览器探针（Playwright + Chromium）：报销「行卡片认领失效」链路回归 —— 2026-09-10 修复的守护测试
//
// 被测行为：成员在行卡片上触发写操作 → 服务端 403（认领已被负责人重置）→ RowCard emit('claim-lost')
//   → ExpenseView.onClaimLost() 清掉本机认领 token + 软刷新 → 身份条回到「访客只读」并重新给出认领入口。
//
// 判别力（本探针存在的意义）：
//   修复前 RowCard 既没在 defineEmits 声明该事件、父层也没监听 → emit 是静默 no-op：
//   只弹一个错误 toast，localStorage 的认领 token 残留、身份条仍显「已认领」，
//   用户之后每次写操作继续撞 403（且不知道要重新认领）→ 本探针转红。
//   修复后 token 被清、UI 回落访客态 → 转绿。
//
// 沙盒（2026-10-16 起，与 probe_repo_ui/probe_booking_ui 同范式）：自起后端 :3111（cwd=临时目录、
//   DB_PATH=临时库，找不到 .env）+ vite :5201，跑完 taskkill 进程树并 rmSync 临时目录。
//   关键断言的 403 发生在认领身份校验层（rowWriteError），先于 AI 视觉调用，沙盒无视觉密钥也可测。
//   报销上传目录 EXPENSE_ROOT 后端无 env 覆盖（仍指 backend/uploads/expense），项目 DELETE 会级联删盘，
//   异常中断时 finally 再按本次邀请码兜底清一次自己的目录，绝不碰其他项目。
// 运行：node scripts/probe_claimlost.mjs   （或 npm run probe:claimlost）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const PORT = 3111, VITEP = 5201;
const API = `http://localhost:${PORT}/api`, WEB = `http://localhost:${VITEP}`;

const work = mkdtempSync(path.join(os.tmpdir(), 'probe_claim_'));
const dbPath = path.join(work, 'cl.db');
const serverEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  PORT: String(PORT),
  DB_PATH: dbPath,
};

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonReq = async (p, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const res = await fetch(API + p, { headers, method: opts.method || 'GET', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, opts = {}) => {
  const { res, data } = await jsonReq(p, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

// ---- 自起沙盒服务 ----
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
  '--port', String(VITEP), '--strictPort'], path.join(ROOT, 'frontend'), { VITE_API_TARGET: `http://localhost:${PORT}` });
vite.stdout.on('data', (b) => viteLog.push(b.toString()));
vite.stderr.on('data', (b) => viteLog.push(b.toString()));

async function waitUp(url, n = 60) {
  for (let i = 0; i < n; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* 还没起 */ }
    await sleep(500);
  }
  throw new Error(`服务未就绪：${url}`);
}

const stamp = Date.now().toString().slice(-8);
const EMAIL = `probe_claimlost_${stamp}@test.dev`;
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let browser = null, P = 0, C = '', ta = '', uid = 0;

try {
  await waitUp(`${API}/health`);
  await waitUp(WEB);
  console.log('—— 沙盒服务就绪 ——');

  // ---------- 夹具：owner + 项目 + 队 + 名单 + 项目级⑥零散票据行 + 图片附件 ----------
  // 用项目级 misc 行：其槽位 ticket 明确接受图片（train 的槽位偏 PDF），且成员认领后即可自理自己名下
  const ra = await api('/auth/register', { method: 'POST', body: { email: EMAIL, password: 'pass123456', nickname: '探针负责人' } });
  ta = ra.token; uid = Number(ra.user.id);
  await api('/auth/real-name', { method: 'PUT', token: ta, body: { real_name: '探负责' } });
  const proj = await api('/expense', { method: 'POST', token: ta, body: { name: '认领失效探针', event: '电子设计大赛' } });
  P = Number(proj.id);
  C = proj.code;
  const tm = await api(`/expense/${P}/team`, { method: 'POST', token: ta, body: { name: '探针队' } });
  const mid = Number((await api(`/expense/${P}/team/${Number(tm.id)}/member`, { method: 'POST', token: ta, body: { name: '王小明' } })).id);
  const row = await api(`/expense/o/${C}/row`, {
    method: 'POST', token: ta,
    body: { project_pay: true, category: 'misc', owner_name: '王小明', data: { 票据名称: '探针打车发票', 金额: 45.5, 备注: '', 统一支付范围: '' } },
  });
  const rid = Number(row.row.id);
  const fd = new FormData();
  fd.append('file', new Blob([PNG_1x1]), '探针票据.png');
  const up = await fetch(`${API}/expense/o/${C}/row/${rid}/file?slot=ticket`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: fd });
  if (!up.ok) throw new Error(`夹具附件上传失败 ${up.status}`);
  ok('夹具就绪：项目+队+名单(王小明)+项目级票据行+图片附件', !!C && !!rid);

  // ---------- 浏览器：匿名进入 → 认领王小明 ----------
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${WEB}/expense?code=${C}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.claim-box').waitFor({ state: 'visible', timeout: 20000 });
  ok('匿名进入显示认领入口（访客只读态）', true);

  const KEY = `expense_claim_${C}`;
  ok('进入时本机无认领 token', (await page.evaluate((k) => localStorage.getItem(k), KEY)) === null);

  await page.locator('.claim-tag:has-text("王小明")').first().click();
  await page.locator('.who:has-text("已认领")').waitFor({ state: 'visible', timeout: 15000 });
  const tok = await page.evaluate((k) => localStorage.getItem(k), KEY);
  ok('认领王小明成功：身份条显示「已认领」且本机存下 token', !!tok && tok.length === 32);

  const visLink = page.locator('.vis-go:visible').first();
  ok('自己名下行的图片附件出现「🔍识别」入口（editable=true）', (await page.locator('.vis-go:visible').count()) >= 1);

  // ---------- 负责人重置认领 → 成员侧身份在服务端失效（浏览器仍持旧 token，UI 仍是成员态）----------
  await api(`/expense/member/${mid}/reset-claim`, { method: 'POST', token: ta });
  ok('负责人重置认领（服务端已失效；浏览器未刷新仍是成员态 = 真实失效场景）',
    (await page.evaluate((k) => !!localStorage.getItem(k), KEY)) === true
    && (await page.locator('.who:has-text("已认领")').count()) === 1);

  // ---------- 关键一步：点「🔍识别」→ 403 → claim-lost → 清 token + 回落访客 ----------
  // 先挂上响应/提示的等待再点击，避免 toast 自动消失导致漏判
  const respP = page.waitForResponse((r) => r.url().includes('/recognize') && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
  const toastP = page.locator('.el-message:has-text("请先认领")').first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  await visLink.click();

  const resp = await respP;
  ok('识别请求命中服务端 403（身份已失效）', !!resp && resp.status() === 403);

  const cleared = await page.waitForFunction((k) => localStorage.getItem(k) === null, KEY, { timeout: 10000 }).then(() => true).catch(() => false);
  ok('★ localStorage 认领 token 被清除（claim-lost → onClaimLost 真正跑通）', cleared);

  const backToGuest = await page.locator('.claim-box').waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  ok('★ 身份条回落「访客只读」并重新给出认领入口', backToGuest);
  ok('离开已认领态（不再显示「已认领」）', (await page.locator('.who:has-text("已认领")').count()) === 0);

  ok('错误提示告知用户原因（toast 含「请先认领」）', await toastP);

  // ---------- 收尾：重新认领仍可用（链路没把页面搞死）----------
  await page.locator('.claim-tag:has-text("王小明")').first().click();
  const back = await page.locator('.who:has-text("已认领")').waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  ok('可重新认领（页面状态干净，未卡死）', back);

  ok('全程无未捕获的前端异常', pageErrors.length === 0);
  if (pageErrors.length) console.log(`      ↳ ${pageErrors.slice(0, 3).join(' | ')}`);

  // ---------- 清理（全在沙盒：业务 API 删项目级联清盘 + 临时库删测试用户）----------
  await browser.close(); browser = null;
  await api(`/expense/${P}`, { method: 'DELETE', token: ta });
  new DatabaseSync(dbPath).prepare('DELETE FROM user WHERE id = ?').run(uid);
  ok('自清理：沙盒项目与测试用户已删除', true);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
  console.log('—— 后端日志尾 ——\n' + beLog.slice(-20).join(''));
  console.log('—— vite 日志尾 ——\n' + viteLog.slice(-10).join(''));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of children) {
    try { process.platform === 'win32' ? spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)]) : p.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  await sleep(800);
  // 兜底：只清本次邀请码对应的上传目录（EXPENSE_ROOT 无 env 覆盖；正常已被项目 DELETE 级联）
  if (C) {
    const upDir = path.join(ROOT, 'backend', 'uploads', 'expense', C);
    if (existsSync(upDir)) rmSync(upDir, { recursive: true, force: true });
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
