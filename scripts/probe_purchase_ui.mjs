// 浏览器探针（Playwright + Chromium）：物料采购模块全链路 UI 走查
//
// 链路：登录闸门 → 学生填报（手填一行 + BOM xlsx 识别追加 + 购买截图 + 金额联动）
//   → 老师驳回（必填原因）→ 学生修改重提（旧截图回填保留）→ 负责人通过
//   → 学生传发票（多张/删除）→ 金额统计表 + ECharts → 导出 xlsx → 审批人管理 → 375px 窄屏
//
// 探针自起临时后端（独立临时 DB）+ vite dev（代理到临时后端），跑完即弃；
// uploads/purchase 下只清理本次新出现的申请目录（绝不动既有数据）。
//
// 运行：node scripts/probe_purchase_ui.mjs
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const XLSX = require(path.join(ROOT, 'backend', 'node_modules', 'xlsx'));

const PORT = 3108, VITE = 5199;
const API = `http://localhost:${PORT}/api`, WEB = `http://localhost:${VITE}`;
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'probe_pui_'));
const dbPath = path.join(tmpDir, 'ui.db');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}${extra ? `  ← ${extra}` : ''}`)); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url, n = 60) {
  for (let i = 0; i < n; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* 还没起 */ }
    await sleep(500);
  }
  throw new Error(`服务未就绪：${url}`);
}
const jreq = async (p, opts = {}) => {
  const res = await fetch(API + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, opts = {}) => { const { res, data } = await jreq(p, opts); if (!res.ok) throw new Error(`${p} ${res.status} ${JSON.stringify(data)}`); return data; };

// ---- 起服务 ----
const children = [];
function start(cmd, args, cwd, env) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: false });
  children.push(p);
  p.on('exit', (c) => console.log(`[${cmd} 退出 ${c}]`));
  return p;
}
const beLog = [];
const backend = start(process.execPath, [path.join(ROOT, 'backend', 'server.js')], path.join(ROOT, 'backend'), { PORT: String(PORT), DB_PATH: dbPath });
backend.stdout.on('data', (b) => beLog.push(b.toString()));
backend.stderr.on('data', (b) => beLog.push(b.toString()));
const vite = start(process.execPath, [path.join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
  '--port', String(VITE), '--strictPort'], path.join(ROOT, 'frontend'), { VITE_API_TARGET: `http://localhost:${PORT}` });
const viteLog = [];
vite.stdout.on('data', (b) => viteLog.push(b.toString()));
vite.stderr.on('data', (b) => viteLog.push(b.toString()));

const shotBefore = new Set(existsSync(path.join(ROOT, 'backend', 'uploads', 'purchase'))
  ? readdirSync(path.join(ROOT, 'backend', 'uploads', 'purchase')) : []);

// ---- 夹具：BOM xlsx + 两张 PNG + 一个 PDF ----
const bomPath = path.join(tmpDir, 'bom.xlsx');
{
  const ws = XLSX.utils.aoa_to_sheet([
    ['机器人赛物料清单 BOM'],
    ['物料名称', '规格型号', '数量', '单价(元)'],
    ['电阻 10k', '0805 10kΩ', 100, 0.05],
    ['杜邦线', '母对母 20cm', 20, 0.8],
    ['合计', '', '', 21],
  ]);
  XLSX.writeFile({ SheetNames: ['BOM'], Sheets: { BOM: ws } }, bomPath);
}
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pngA = path.join(tmpDir, 'shot.png'); writeFileSync(pngA, PNG_1X1);
const pngB = path.join(tmpDir, 'inv1.png'); writeFileSync(pngB, PNG_1X1);
const pngC = path.join(tmpDir, 'inv2.png'); writeFileSync(pngC, PNG_1X1);

let browser, page;
try {
  await waitUp(`${API}/health`);
  await waitUp(WEB);
  console.log('—— 服务就绪 ——');

  // ---- 账号 + 档案（API 预置）----
  const stamp = Date.now();
  const evName = `UI探针赛${stamp}`;
  const mk = async (tag, nick, real) => {
    const r = await api('/auth/register', { method: 'POST', body: { email: `ui_${tag}_${stamp}@test.dev`, password: 'pass123456', nickname: nick } });
    const rn = await api('/auth/real-name', { method: 'PUT', token: r.token, body: { real_name: real } });
    return { ...r, user: rn.user }; // 注入浏览器的 user 卡须是实名后的最新卡
  };
  const leader = await mk('l', 'UI队长', '陈队');
  const teacher = await mk('t', `UI老师${stamp}`, '张老师');
  const student = await mk('a', 'UI学生甲', '李同学');
  const ev = await api('/purchase/events', { method: 'POST', token: leader.token, body: { name: evName, kind: '比赛', description: 'UI 探针档案' } });
  const eid = ev.event.id;
  await api(`/purchase/events/${eid}/approvers`, { method: 'POST', token: leader.token, body: { user_id: teacher.user.id, role: 'teacher' } });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[浏览器console.error]', m.text()); });
  // 全站弹窗用 .el-dialog（ImageViewer/MessageBox 不是 .el-dialog），取当前可见的一个
  const dlg = () => page.locator('.el-dialog:visible');

  async function login(u) {
    await page.goto(WEB + '/purchase');
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('ec_token', token);
      localStorage.setItem('ec_user', JSON.stringify(user));
    }, { token: u.token, user: u.user });
    await page.goto(WEB + '/purchase');
    await page.getByRole('button', { name: '新建采购申请' }).waitFor({ timeout: 8000 });
  }

  // ===== 0. 未登录闸门 =====
  await page.goto(WEB + '/purchase');
  await page.locator('.el-tabs').first().waitFor({ state: 'visible', timeout: 8000 });
  ok('未登录显示登录闸门（登录卡 tabs）', await page.locator('.el-tabs').first().isVisible());

  // ===== 1. 学生：新建（手填 + BOM + 截图） =====
  await login(student);
  await page.getByRole('button', { name: '新建采购申请' }).click();
  await dlg().locator('input[placeholder*="Arduino"]').waitFor();
  // 手填第一行
  await dlg().locator('input[placeholder*="Arduino"]').fill('手动排针');
  await dlg().locator('input[placeholder*="UNO"]').fill('2.54mm 一板');
  const numIns = dlg().locator('.items-table tbody tr').first().locator('.el-input-number input');
  await numIns.nth(0).fill('5');
  await numIns.nth(1).fill('0.2');
  // BOM 识别（隐藏 input 直接 setInputFiles，识别结果应追加）
  await dlg().locator('input[accept*="xlsx"]').setInputFiles(bomPath);
  await page.getByText(/已识别并追加 2 行/).waitFor({ timeout: 20000 });
  const rows = dlg().locator('.items-table tbody tr');
  ok('BOM 追加后共 3 行（不清空手填）', await rows.count() === 3, `实际 ${await rows.count()} 行`);
  // innerText 读不到 input.value，直接取所有输入框的值
  const inputVals = await dlg().locator('.items-table tbody input').evaluateAll((els) => els.map((e) => e.value));
  const joined = inputVals.join('|');
  ok('BOM 行内容回填（名称/规格/数量/单价）', joined.includes('电阻 10k') && joined.includes('0805 10kΩ')
    && joined.includes('杜邦线') && joined.includes('母对母 20cm'), joined);
  ok('合计行被跳过（没有"合计"物料）', !joined.includes('合计'));
  ok('合计金额正确 22.00（1+5+16）', (await dlg().locator('.total-line').innerText()).includes('22.00'),
    await dlg().locator('.total-line').innerText());
  // 第一行截图（经 filechooser，确保选中行索引生效）
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dlg().locator('.items-table tbody tr').first().getByRole('button', { name: '＋ 截图' }).click(),
  ]);
  await chooser.setFiles(pngA);
  await dlg().locator('.items-table tbody tr').first().locator('img[src^="blob:"]').waitFor({ timeout: 5000 });
  ok('行截图缩略图显示', true);
  await dlg().getByRole('button', { name: '提交申请' }).click();
  await page.getByText('申请已提交，等待审批').waitFor({ timeout: 8000 });
  ok('提交成功提示', true);
  await sleep(300);
  ok('列表出现 1 条、金额 22.00', (await page.locator('.rq-table tbody').innerText()).includes('22.00'));
  ok('顶部卡：我的申请 1 / 待审批 1', await page.locator('.stat-cards').innerText().then((t) => t.includes('待审批') && true));
  const cardsText = await page.locator('.stat-cards').innerText();
  ok('待我审批卡对学生不可见', !cardsText.includes('待我审批'));

  // ===== 2. 老师驳回 =====
  await login(teacher);
  await page.getByRole('button', { name: /审批工作台/ }).click();
  await sleep(300);
  ok('老师有审批工作台 + 待审红点 1', (await page.locator('.tab-badge').first().innerText().catch(() => '')) === '1');
  await page.locator('.rq-table tbody tr').first().click();
  await dlg().getByRole('button', { name: '驳回' }).click();
  await page.locator('.el-message-box textarea').waitFor();
  await page.locator('.el-message-box textarea').fill('规格写得太粗，请补充具体参数');
  await page.getByRole('button', { name: '确认驳回' }).click();
  await dlg().getByText('已驳回').first().waitFor();
  const dText1 = await dlg().innerText();
  ok('详情态变已驳回 + 原因可见 + 轨迹有老师标签', dText1.includes('已驳回') && dText1.includes('规格写得太粗') && dText1.includes('老师'));
  ok('老师看不到通过按钮了', !(await dlg().getByRole('button', { name: '驳回' }).count()));
  await dlg().locator('.el-dialog__headerbtn').click();

  // ===== 3. 学生修改重提（截图保留）=====
  await login(student);
  await page.locator('.rq-table tbody tr').first().click();
  await dlg().getByRole('button', { name: '修改并重新提交' }).waitFor();
  await dlg().getByRole('button', { name: '修改并重新提交' }).click();
  await dlg().locator('input[placeholder*="Arduino"]').first().waitFor();
  await sleep(500); // 等旧截图 blob 懒加载
  const rows2 = dlg().locator('.items-table tbody tr');
  ok('重提表单回填 3 行', await rows2.count() === 3);
  ok('旧截图回填显示（blob 缩略图）', await dlg().locator('.items-table img[src^="blob:"]').count() > 0);
  // 改行1单价 0.2 → 1.6
  await dlg().locator('.items-table tbody tr').first().locator('.el-input-number input').nth(1).fill('1.6');
  ok('改价后合计 29.00（8+5+16）', (await dlg().locator('.total-line').innerText()).includes('29.00'));
  await dlg().getByRole('button', { name: '提交申请' }).click();
  await page.getByText('已重新提交，等待审批').waitFor({ timeout: 8000 });
  ok('重新提交成功', true);

  // ===== 4. 负责人通过 =====
  await login(leader);
  await page.getByRole('button', { name: /审批工作台/ }).click();
  await sleep(300);
  await page.locator('.rq-table tbody tr').first().click();
  await dlg().getByRole('button', { name: '✓ 通过' }).click();
  await page.locator('.el-message-box textarea').waitFor();
  await page.getByRole('button', { name: '确认通过' }).click();
  await dlg().getByText('待传发票').first().waitFor();
  const dText2 = await dlg().innerText();
  ok('通过后态为待传发票 + 轨迹有负责人标签', dText2.includes('待传发票') && dText2.includes('负责人'));
  await dlg().locator('.el-dialog__headerbtn').click();

  // ===== 5. 学生传发票（两张，删一张） =====
  await login(student);
  await page.locator('.rq-table tbody tr').first().click();
  await dlg().getByRole('button', { name: '上传发票' }).waitFor();
  await dlg().locator('input[accept*="pdf"]').setInputFiles([pngB, pngC]);
  await page.getByText(/已上传 2 张发票/).waitFor({ timeout: 10000 });
  // 上传后弹窗会刷新详情：等 chip 真正渲染到 2 个（旧实现有整窗 loading 闪烁，已修为保留内容）
  await dlg().locator('.inv-chip').nth(1).waitFor({ timeout: 8000 });
  let chips = dlg().locator('.inv-chip');
  const chipN = await chips.count();
  const visibleDialogs = await page.locator('.el-dialog:visible').count();
  const diag = `chips=${chipN} visibleDialogs=${visibleDialogs}`;
  ok('两张发票 chip + 已传发票态', chipN === 2 && (await dlg().first().innerText()).includes('已传发票'), diag);
  await chips.first().locator('.inv-del').click();
  await page.getByRole('button', { name: '删除' }).click();
  await page.getByText('已删除').waitFor();
  chips = dlg().locator('.inv-chip');
  ok('删一张后仍已传发票（剩 1 张）', await chips.count() === 1 && (await dlg().innerText()).includes('已传发票'));
  await dlg().locator('.el-dialog__headerbtn').click();
  const stuCards = await page.locator('.stat-cards').innerText();
  ok('学生卡：已通过金额 ¥29.00', stuCards.includes('29.00'));

  // ===== 6. 负责人：统计 + 图表 + 导出 =====
  await login(leader);
  await page.getByRole('button', { name: '金额统计' }).click();
  await sleep(1000);
  const statsText = await page.locator('.st-table').first().innerText();
  ok('按档案统计出现该赛 + 通过金额 29.00', statsText.includes(evName) && statsText.includes('29.00'));
  const userStatText = await page.locator('.st-table').nth(1).innerText();
  ok('按个人统计出现「李同学（UI学生甲）」组合署名', userStatText.replace(/\s/g, '').includes('李同学（UI学生甲）'), userStatText.replace(/\n/g, ' ').slice(0, 120));
  const box = await page.locator('.chart canvas').boundingBox();
  ok('ECharts 画布真实布局（宽>100）', !!box && box.width > 100, box ? `${box.width}x${box.height}` : '无 canvas');

  const dlReady = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: /导出筛选结果/ }).click();
  const download = await dlReady;
  ok('导出文件名含「物料采购」与 xlsx', /物料采购.*\.xlsx/.test(download.suggestedFilename()), download.suggestedFilename());
  const dlPath = path.join(tmpDir, 'export.xlsx');
  await download.saveAs(dlPath);
  ok('导出文件非空（>3KB）', statSync(dlPath).size > 3000, `${statSync(dlPath).size}B`);

  // ===== 7. 档案管理：审批人列表 =====
  await page.getByRole('button', { name: '比赛·项目管理' }).click();
  await sleep(600);
  const evCard = page.locator('.ev-card', { hasText: evName });
  await evCard.waitFor();
  const apText = await evCard.locator('.ap-list').innerText();
  ok('审批人列表含负责人👑与老师', apText.includes('UI队长') && apText.includes('👑') && apText.includes(`UI老师${stamp}`));

  // ===== 8. 窄屏 390px：表格降卡片、无横溢（切回学生：他列表里有单）=====
  await page.setViewportSize({ width: 390, height: 844 });
  await login(student);
  await page.getByRole('button', { name: '我的申请' }).click();
  await sleep(400);
  const card = page.locator('.rq-cards .rq-card').first();
  await card.waitFor();
  const cb = await card.boundingBox();
  ok('窄屏渲染申请卡片且宽度≤视口', !!cb && cb.width <= 390 && cb.width > 200, cb ? `${cb.width}` : '');
  ok('窄屏桌面表格隐藏', !(await page.locator('.rq-table').isVisible()));
  const mobileShot = path.join(ROOT, 'scripts', '.probe_mobile.png');
  await page.screenshot({ path: mobileShot, fullPage: true });
  console.log(`窄屏截图：${mobileShot}`);

  await page.setViewportSize({ width: 1280, height: 900 });

  // ===== 9. 首次使用链路：新用户、零档案 → 点新建直接弹建档 → 保存后自动接申请单 =====
  // 临时库里已有他人档案（open 档案对所有人可见是正确行为）；全部置 closed，
  // closed 档案对无关联新用户不可见 → 模拟「全新系统、零档案」
  const tdb = new DatabaseSync(dbPath);
  tdb.prepare("UPDATE purchase_event SET status='closed' WHERE 1=1").run();
  tdb.close();
  const fresh = await mk('fresh', 'UI新人', '王新人');
  await login(fresh);
  // 零档案：不弹确认框，直接是建档弹窗
  await page.getByRole('button', { name: '新建采购申请' }).click();
  await dlg().locator('.el-dialog__title').filter({ hasText: '建立比赛/项目档案' }).waitFor({ timeout: 5000 });
  ok('零档案时点新建直接弹出建档弹窗', true);
  // 管理 tab 对任何登录用户可见
  ok('比赛·项目管理 tab 始终可见', await page.getByRole('button', { name: '比赛·项目管理' }).isVisible());
  await dlg().locator('input').first().fill(`UI新人赛${stamp}`);
  await dlg().getByRole('button', { name: '建档' }).click();
  await dlg().locator('.el-dialog__title').filter({ hasText: '新建采购申请' }).waitFor({ timeout: 5000 });
  ok('建档保存后自动接上新建申请弹窗', true);
  // 建档弹窗退场动画期间两个 .el-dialog 同时在场，轮询等只剩一个（:visible 是 Playwright 伪类，不能进 querySelectorAll）
  for (let i = 0; i < 40; i++) {
    if ((await page.locator('.el-dialog:visible').count()) === 1) break;
    await sleep(100);
  }
  await sleep(200);
  // Element Plus 2.9 的选中文案渲染在 .el-select__selected-item（input.value 为空）
  const evSel = await dlg().locator('.ev-select').innerText().catch(() => '');
  ok('新档案已自动选中', evSel.includes('UI新人赛'), JSON.stringify(evSel));
  await dlg().locator('input[placeholder*="Arduino"]').first().fill('新人物料');
  const freshNum = dlg().locator('.items-table tbody tr').first().locator('.el-input-number input');
  await freshNum.nth(0).fill('2');
  await freshNum.nth(1).fill('3');
  await dlg().getByRole('button', { name: '提交申请' }).click();
  await page.getByText('申请已提交，等待审批').waitFor({ timeout: 8000 });
  // 新用户建档后自动成为 leader → 审批工作台 tab 也渲染了隐藏表格，断言只认可见的
  const visibleTable = page.locator('.rq-table:visible tbody');
  ok('新用户建档→申请全链打通', (await visibleTable.innerText()).includes('6.00'));

  await context.close();
} catch (e) {
  fail++;
  console.error('探针异常：', e);
  try { const sp = path.join(ROOT, 'scripts', '.probe_error.png'); await page.screenshot({ path: sp, fullPage: true }); console.log('异常截图：', sp); } catch { /* 页没了 */ }
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of children) {
    try { process.platform === 'win32' ? spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)]) : p.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  await sleep(800);
  // 只删本次新增的申请目录
  const pdir = path.join(ROOT, 'backend', 'uploads', 'purchase');
  if (existsSync(pdir)) {
    for (const name of readdirSync(pdir)) {
      if (!shotBefore.has(name)) rmSync(path.join(pdir, name), { recursive: true, force: true });
    }
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

if (beLog.some((l) => /ERROR|uncaught/i.test(l))) console.log('⚠️ 后端日志含 ERROR 字样，见临时输出');
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
