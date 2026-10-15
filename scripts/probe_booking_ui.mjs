// 浏览器探针（Playwright + Chromium）：资源预约模块全链路 UI 走查
//
// 链路：
//   未登录闸门 → A 建项目 → 表单建空间资源（容量/设备/审批）与物品资源（库存/先到先得）
//   → 甘特拖格：A 2.5h pending 琥珀块（位置/时长/姓名断言）
//   → B 重叠圈选实时冲突禁用提交 → 相邻格临时搜 C（非好友全站可搜）多人单
//   → B 建固定组队并用队下单 → C 的 mine 能见两单
//   → 物品先到先得直接 confirmed 蓝块 + 库存热度；超量借 3 件实时 409 拦截
//   → A 审批通过 → 块变蓝 → C 收到通知并点 link 自动弹详情
//   → 390px 窄屏：手风琴建约全链路、无横溢
//   → 表格导入：模板下载 + 选 CSV 解析回填（告警/warnings）→ bulk 落库新卡
//   全程无 pageerror、无意外 4xx/5xx
//
// 沙盒：后端 cwd=临时目录（无 .env）+ 临时 DB + 临时上传目录，跑完即弃，绝不碰真实数据。
// 运行：node scripts/probe_booking_ui.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3108, VITE = 5199;
const API = `http://localhost:${PORT}/api`, WEB = `http://localhost:${VITE}`;

const work = mkdtempSync(path.join(os.tmpdir(), 'probe_booking_'));
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
  const res = await fetch(API + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, opts = {}) => {
  const { res, data } = await jreq(p, opts);
  if (!res.ok) throw new Error(`${p} ${res.status} ${JSON.stringify(data)}`);
  return data;
};

const children = [];
function start(cmd, args, cwd, env) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: false });
  children.push(p);
  return p;
}
const beLog = [];
const backend = start(process.execPath, [path.join(ROOT, 'backend', 'server.js')], work, serverEnv);
backend.stdout.on('data', (b) => beLog.push(b.toString()));
backend.stderr.on('data', (b) => beLog.push(b.toString()));
const vite = start(process.execPath, [path.join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
  '--port', String(VITE), '--strictPort'], path.join(ROOT, 'frontend'), { VITE_API_TARGET: `http://localhost:${PORT}` });

// ---- 日期口径：全部约明天（保证未来时段），周一为周首 ----
const now = new Date();
const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
const p2 = (n) => String(n).padStart(2, '0');
const D = `${tomorrow.getFullYear()}-${p2(tomorrow.getMonth() + 1)}-${p2(tomorrow.getDate())}`;
const dayIdx = (tomorrow.getDay() + 6) % 7; // 明天在本周的列序

let browser;
const pageErrors = [];
const badResp = [];
try {
  await waitUp(`${API}/health`);
  await waitUp(WEB);
  console.log('—— 服务就绪 ——');

  // ---- 账号 ----
  const stamp = Date.now();
  const mk = (tag, nick) => api('/auth/register', {
    method: 'POST',
    body: { email: `ui_bk_${tag}_${stamp}@test.dev`, password: 'pass123456', nickname: nick },
  });
  const A = await mk('a', `UI预约甲${stamp}`);
  const B = await mk('b', `UI预约乙${stamp}`);
  const C = await mk('c', `丙${stamp}`);
  const cNick = C.user.nickname;

  browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxC = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageC = await ctxC.newPage();
  for (const pg of [pageA, pageB, pageC]) {
    pg.on('pageerror', (e) => pageErrors.push(`${pg.url()} :: ${e.message}`));
    pg.on('response', (r) => {
      const u = r.url();
      // /conflicts 用 4xx 表达"有冲突"是该接口的正常语义，不算故障
      if (r.status() >= 400 && !u.includes('favicon') && !/\/conflicts/.test(u)) badResp.push(`${r.status()} ${u}`);
    });
  }
  const dlg = (pg) => pg.locator('.el-dialog:visible');
  const login = async (pg, u, url = `${WEB}/booking`) => {
    await pg.goto(url);
    await pg.evaluate(({ token, user }) => {
      localStorage.setItem('ec_token', token);
      localStorage.setItem('ec_user', JSON.stringify(user));
    }, { token: u.token, user: u.user });
    await pg.goto(url);
  };
  // 甘特拖选：track 行上从 slotA 格拖到 slotB 格（可反向，slot 为明天列内 0–30）
  async function dragOn(pg, trackIndex, slotA, slotB) {
    // 先把明天所在日列横向滚入视口
    await pg.locator('.wg-scroll').evaluate((el, idx) => {
      const dayW = (el.scrollWidth - 150) / 7;
      el.scrollLeft = Math.max(0, idx * dayW - 80);
    }, dayIdx);
    await sleep(100);
    const head = pg.locator('.wg-dayhead').nth(dayIdx);
    const track = pg.locator('.wg-track').nth(trackIndex);
    await head.waitFor();
    const hb = await head.boundingBox();
    const tb = await track.boundingBox();
    // 起点落在 slotA 格内；终点是排他刻度 slotB → 坐标取该刻度前 5px（落进前一格）
    const xStart = () => hb.x + (hb.width * slotA) / 30 + 4;
    const xEnd = () => hb.x + (hb.width * slotB) / 30 - 5;
    const y = tb.y + tb.height / 2;
    await pg.mouse.move(xStart(), y);
    await pg.mouse.down();
    await pg.mouse.move(xEnd(), y, { steps: 8 });
    await sleep(80);
    await pg.mouse.up();
    await sleep(150);
  }
  // 远程多选选人（按表单项标题定位，multiple 模式 placeholder 不在 input 上）：输入关键字 → 点下拉项
  async function pickRemoteUser(pg, itemText, nick) {
    const fi = dlg(pg).locator('.el-form-item', { hasText: itemText });
    await fi.locator('.el-select').first().click();
    await pg.keyboard.type(nick.slice(0, 4), { delay: 40 });
    const opt = pg.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: nick }).first();
    await opt.waitFor({ timeout: 5000 });
    await opt.click();
  }
  // allow-create 设备标签：聚焦多选 → 输入 → 回车建档
  async function createTag(pg, itemText, tag) {
    const fi = dlg(pg).locator('.el-form-item', { hasText: itemText });
    await fi.locator('.el-select').first().click();
    await pg.keyboard.type(tag, { delay: 30 });
    await sleep(150);
    await pg.keyboard.press('Enter');
    await fi.locator('.el-tag', { hasText: tag }).first().waitFor({ timeout: 3000 });
  }

  // ===== 0. 未登录闸门 =====
  await pageA.goto(`${WEB}/booking`);
  await pageA.locator('.el-tabs').first().waitFor({ timeout: 8000 });
  ok('未登录显示登录闸门', await pageA.locator('.el-tabs').first().isVisible());

  // ===== 1. A 创建预约项目（UI） =====
  await login(pageA, A);
  await pageA.getByRole('button', { name: '＋ 创建预约项目' }).click();
  await dlg(pageA).locator('input').first().fill(`UI预约项目${stamp}`);
  await dlg(pageA).getByRole('button', { name: '创建并进入' }).click();
  await pageA.waitForURL(/\/booking\/\d+$/, { timeout: 8000 });
  const pid = Number(pageA.url().split('/').pop());
  ok('建项后跳转项目页', Number.isInteger(pid) && pid > 0, pageA.url());
  await pageA.locator('.wg-scroll .el-empty').waitFor({ timeout: 5000 });
  ok('空项目甘特显示空态', (await pageA.locator('.wg-scroll').innerText()).includes('还没有可用资源'));

  // ===== 2. 建空间资源（审批）+ 物品资源（先到先得） =====
  await pageA.locator('.tabchip', { hasText: '可用资源' }).click();
  await pageA.getByRole('button', { name: '＋ 添加资源' }).click();
  await dlg(pageA).locator('input[placeholder*="工程训练中心"]').fill('机房401');
  await dlg(pageA).locator('input[placeholder="楼栋/房间号"]').fill('工程楼401');
  // 室内设备两个 allow-create tag
  await createTag(pageA, '室内设备', '投影仪');
  await createTag(pageA, '室内设备', '白板');
  await dlg(pageA).getByRole('button', { name: '保存' }).click();
  await pageA.getByText('资源已添加').waitFor({ timeout: 5000 });
  const cardText = await pageA.locator('.rs-card').first().innerText();
  ok('空间卡：名称/容量30/设备/需审批', cardText.includes('机房401') && cardText.includes('容量 30')
    && cardText.includes('投影仪') && cardText.includes('白板') && cardText.includes('需审批'), cardText.replace(/\n/g, ' '));

  await pageA.getByRole('button', { name: '＋ 添加资源' }).click();
  await dlg(pageA).locator('.el-radio-button', { hasText: '物品资源' }).click();
  await dlg(pageA).locator('input[placeholder*="RoboMaster"]').fill('工具箱');
  await dlg(pageA).locator('.el-input-number input').fill('3');
  await pageA.keyboard.press('Tab');
  await dlg(pageA).locator('input[placeholder*="单位"]').fill('个');
  await dlg(pageA).locator('.el-radio', { hasText: '先到先得' }).click();
  await dlg(pageA).getByRole('button', { name: '保存' }).click();
  await pageA.getByText('资源已添加').waitFor({ timeout: 5000 });
  const itemCard = pageA.locator('.rs-card', { hasText: '工具箱' });
  const itemCardText = await itemCard.innerText();
  ok('物品卡：库存3 + 先到先得', itemCardText.includes('库存 3') && itemCardText.includes('先到先得'),
    itemCardText.replace(/\n/g, ' '));

  await pageA.locator('.tabchip', { hasText: '周视图' }).click();
  await pageA.locator('.wg-track').nth(1).waitFor();
  ok('甘特两行（空间 + 物品）', await pageA.locator('.wg-track').count() === 2);
  ok('甘特 7 个日表头、每天 30 格刻度', await pageA.locator('.wg-dayhead').count() === 7);

  // ===== 3. A 拖 09:00–11:30（5 格）单人约空间 → pending 块 =====
  await dragOn(pageA, 0, 4, 9);
  await dlg(pageA).waitFor();
  ok('拖选弹窗显示明天 09:00–11:30 + 2.5小时', (await dlg(pageA).innerText())
    .includes(`${D} 09:00`) && (await dlg(pageA).innerText()).includes(`${D} 11:30`)
    && (await dlg(pageA).innerText()).includes('2.5小时'));
  await dlg(pageA).locator('textarea').fill('UI 探针：机械组集训');
  await dlg(pageA).getByRole('button', { name: '提交预约' }).click();
  await pageA.getByText('已提交，待项目负责人审批').waitFor({ timeout: 8000 });
  const blk = pageA.locator('.wg-block.st-pending').first();
  await blk.waitFor({ timeout: 5000 });
  const bStyle = await blk.getAttribute('style') || '';
  const leftPct = parseFloat((bStyle.match(/left:\s*([\d.]+)%/) || [])[1]);
  const widthPct = parseFloat((bStyle.match(/width:\s*([\d.]+)%/) || [])[1]);
  const expLeft = ((dayIdx * 30 + 4) / 210) * 100;
  const expWidth = (5 / 210) * 100;
  ok('pending 琥珀块位置/宽度 = 明天09:00 起 5 格', Math.abs(leftPct - expLeft) < 0.6 && Math.abs(widthPct - expWidth) < 0.4,
    `left=${leftPct} exp=${expLeft.toFixed(2)} width=${widthPct} exp=${expWidth.toFixed(2)}`);
  const blkText = await blk.innerText();
  ok('块内含姓名/👥1/2.5小时', blkText.includes(A.user.nickname) && blkText.includes('👥1') && blkText.includes('2.5小时'), blkText.replace(/\n/g, ' '));

  // ===== 4. B：重叠圈选被实时拦截 → 临时多人单 =====
  await login(pageB, B, `${WEB}/booking/${pid}`);
  await pageB.locator('.wg-track').nth(0).waitFor();
  // 从 12:00 空格反向拖进 10 点段（down 不能落在 A 的块上）
  await dragOn(pageB, 0, 10, 7);
  await dlg(pageB).waitFor();
  await sleep(700); // /conflicts 防抖 400ms
  ok('重叠时段实时冲突告警', await dlg(pageB).locator('.el-alert--error').isVisible()
    && (await dlg(pageB).locator('.el-alert--error').innerText()).length > 4);
  ok('冲突时提交按钮禁用', await dlg(pageB).getByRole('button', { name: '提交预约' }).isDisabled());
  await dlg(pageB).getByRole('button', { name: '取消' }).click();

  // 13:00–14:00 临时选 C
  await dragOn(pageB, 0, 12, 14);
  await dlg(pageB).waitFor();
  await dlg(pageB).locator('.el-radio', { hasText: '多人' }).click();
  await dlg(pageB).locator('.el-radio', { hasText: '临时选人' }).click();
  await pickRemoteUser(pageB, '临时选择参与人', cNick);
  await sleep(700);
  ok('临时多人：本人+C 共 2 人且校验通过', (await dlg(pageB).innerText()).includes('👥 2 / 30 人')
    && await dlg(pageB).locator('.el-alert--success').isVisible());
  await dlg(pageB).getByRole('button', { name: '提交预约' }).click();
  await pageB.getByText('已提交，待项目负责人审批').waitFor({ timeout: 8000 });

  // B 建固定组队
  await pageB.locator('.tabchip', { hasText: '固定组队' }).click();
  await pageB.getByRole('button', { name: '＋ 新建组队' }).click();
  await dlg(pageB).locator('input').first().fill('探针小队');
  await pickRemoteUser(pageB, '成员（全站搜索', cNick);
  await dlg(pageB).getByRole('button', { name: '保存' }).click();
  const teamCard = pageB.locator('.tm-card', { hasText: '探针小队' });
  await teamCard.waitFor({ timeout: 5000 });
  ok('组队卡含 C 成员', (await teamCard.innerText()).includes(cNick));

  // 用组队约 15:00–16:00
  await pageB.locator('.tabchip', { hasText: '周视图' }).click();
  await dragOn(pageB, 0, 16, 18);
  await dlg(pageB).waitFor();
  await dlg(pageB).locator('.el-radio', { hasText: '多人' }).click();
  await dlg(pageB).locator('.el-form-item', { hasText: '选择我创建的组队' }).locator('.el-select').first().click();
  await pageB.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '探针小队' }).first().click();
  await sleep(700);
  ok('组队单：2 人且校验通过', (await dlg(pageB).innerText()).includes('👥 2 / 30 人')
    && await dlg(pageB).locator('.el-alert--success').isVisible());
  await dlg(pageB).getByRole('button', { name: '提交预约' }).click();
  await pageB.getByText('已提交，待项目负责人审批').waitFor({ timeout: 8000 });
  const multiBlk = pageB.locator('.wg-block.st-pending', { hasText: '👥2' });
  await multiBlk.nth(1).waitFor({ timeout: 8000 });
  ok('甘特出现两个 👥2 多人块', await multiBlk.count() >= 2);

  // C 非好友全站可搜已由上面下拉选项证实；mine 见两单
  const cMine = await api('/booking/bookings/mine', { token: C.token });
  ok('C 的 mine 含临时单与组队单（2 条）', cMine.bookings.filter((x) => x.resource_name === '机房401').length >= 2,
    `实际 ${cMine.bookings.length}`);

  // ===== 5. 物品先到先得：蓝块 + 热度 + 超量拦截 =====
  await dragOn(pageB, 1, 4, 6);
  await dlg(pageB).waitFor();
  await dlg(pageB).getByRole('button', { name: '提交预约' }).click();
  await pageB.getByText('预约成功，已确认').waitFor({ timeout: 8000 });
  await pageB.locator('.wg-block.st-confirmed', { hasText: '×1' }).first().waitFor({ timeout: 8000 });
  await pageB.locator('.wg-heat.heat-a').first().waitFor({ timeout: 8000 });
  ok('物品块立即 confirmed 蓝块 ×1', await pageB.locator('.wg-block.st-confirmed', { hasText: '×1' }).count() >= 1);
  ok('物品库存热度底色出现（半占 amber）', await pageB.locator('.wg-heat.heat-a').count() >= 1);

  // 再圈重叠时段借 3 件：1+3>3 → 实时拒
  await dragOn(pageB, 1, 6, 5);
  await dlg(pageB).waitFor();
  await dlg(pageB).locator('.el-input-number input').fill('3');
  await pageB.keyboard.press('Tab');
  await sleep(700);
  ok('超库存借 3 件实时冲突告警且禁用提交', await dlg(pageB).locator('.el-alert--error').isVisible()
    && await dlg(pageB).getByRole('button', { name: '提交预约' }).isDisabled());
  await dlg(pageB).getByRole('button', { name: '取消' }).click();

  // ===== 6. A 审批 B 的 13:00 临时单 → 变蓝；C 收通知跳详情 =====
  await pageA.reload(); // 刷新项目 pending_count 角标
  await pageA.locator('.wg-track').first().waitFor();
  await pageA.locator('.tabchip', { hasText: '预约与审批' }).click();
  await sleep(400);
  const badge = await pageA.locator('.tab-badge').first().innerText().catch(() => '0');
  ok('审批角标显示待批量 ≥3', Number(badge) >= 3, `badge=${badge}`);
  const row13 = pageA.locator('.rq-table tbody tr', { hasText: `${D} 13:00` });
  await row13.waitFor();
  await row13.getByRole('button', { name: '通过' }).click();
  await pageA.getByText('已通过').waitFor({ timeout: 8000 });
  await pageA.locator('.tabchip', { hasText: '周视图' }).click();
  const blue13 = pageA.locator(`.wg-block.st-confirmed[title*="${D} 13:00"]`);
  await blue13.first().waitFor({ timeout: 8000 });
  ok('审批通过后 13:00 块变蓝', await blue13.count() >= 1);

  // C 的通知 + link 跳转自动开详情
  await sleep(500);
  const notices = await api('/notifications/personal', { token: C.token });
  const n = notices.rows.find((x) => /^bk_approve_/.test(x.type) && x.link.includes(`/booking/${pid}?bid=`));
  ok('C 收到审批通过通知（含 bid link）', !!n, JSON.stringify(notices.rows.slice(0, 3)));
  await login(pageC, C, `${WEB}${n.link}`);
  const cDialog = pageC.locator('.el-dialog:visible');
  await cDialog.waitFor({ timeout: 8000 });
  await cDialog.getByText('已确认').first().waitFor({ timeout: 8000 });
  const cdText = await cDialog.innerText();
  ok('通知 link 打开即弹详情且态为已确认', cdText.includes('已确认') && cdText.includes('机房401'));
  const bid13 = Number(n.link.match(/bid=(\d+)/)[1]);
  ok('详情参与人含 C', cdText.includes(cNick));

  // ===== 7. 390px 窄屏：手风琴 + 建约全链路 + 无横溢 =====
  await pageA.setViewportSize({ width: 390, height: 844 });
  await pageA.goto(`${WEB}/booking/${pid}`);
  await pageA.locator('.wg-m').waitFor({ timeout: 8000 });
  ok('窄屏渲染手风琴、不渲染大网格', await pageA.locator('.wg-m').isVisible()
    && !(await pageA.locator('.wg-grid').isVisible()));
  const sw = await pageA.evaluate(() => document.documentElement.scrollWidth);
  ok('窄屏无横向溢出（scrollWidth≤400）', sw <= 400, `scrollWidth=${sw}`);
  // 选明天
  await pageA.locator('.wg-m .el-select').click();
  await pageA.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: `${tomorrow.getMonth() + 1}/${tomorrow.getDate()}` }).first().click();
  await pageA.locator('.el-collapse-item__header', { hasText: '机房401' }).click();
  await pageA.getByRole('button', { name: '＋ 预约该资源' }).click();
  await dlg(pageA).waitFor();
  ok('窄屏建约走表单模式', await dlg(pageA).locator('.bd-time').isVisible());
  // 时间改到 16:30–17:00（避开既有占用）；每次只认最新的那个可见下拉 popper
  const pickTime = async (text) => {
    await sleep(200);
    const popper = pageA.locator('.el-select-dropdown:visible').last();
    await popper.locator('.el-select-dropdown__item', { hasText: text }).click();
  };
  const tSel = dlg(pageA).locator('.bd-time .el-select');
  await tSel.nth(0).click();
  await pickTime('16:30');
  await tSel.nth(1).click();
  await pickTime('17:00');
  await dlg(pageA).locator('.el-alert--success').waitFor({ timeout: 8000 });
  ok('窄屏时段校验通过', await dlg(pageA).locator('.el-alert--success').isVisible());
  await dlg(pageA).getByRole('button', { name: '提交预约' }).click();
  await pageA.getByText('已提交，待项目负责人审批').waitFor({ timeout: 8000 });
  ok('窄屏当天列表出现预约 chip', (await pageA.locator('.wg-m-item').first().innerText()).includes(A.user.nickname));
  await pageA.setViewportSize({ width: 1280, height: 900 });

  // ===== 7b. 表格导入：模板下载 + CSV 解析回填 → bulk 落库 =====
  await pageA.goto(`${WEB}/booking/${pid}`);
  await pageA.locator('.tabchip', { hasText: '可用资源' }).click();
  await pageA.getByRole('button', { name: '📋 批量导入' }).click();
  await dlg(pageA).waitFor();
  await dlg(pageA).locator('.el-radio-button', { hasText: '物品资源' }).click();

  // 模板下载（blob 链接触发 download 事件，文件名取自 filename*）
  const dlPromise = pageA.waitForEvent('download');
  await dlg(pageA).getByRole('button', { name: /下载模板/ }).click();
  const dl = await dlPromise;
  ok('模板下载：文件名含「资源导入模板」', (dl.suggestedFilename() || '').includes('资源导入模板'), dl.suggestedFilename());

  // 别名表头 + 2 行物品（含空位置/中文审批词），走隐藏 file input
  const csvPath = path.join(work, 'ui-items.csv');
  writeFileSync(csvPath, ['资源名称,规格型号,库存数量,单位,存放位置,审批方式',
    'UI导入电池盒,5号8格,12,个,器材柜C1,先到先得',
    'UI导入扎带堆,3x100mm,40,包,,需审批'].join('\n'), 'utf8');
  await dlg(pageA).locator('input[type=file]').setInputFiles(csvPath);
  await dlg(pageA).locator('.el-alert--warning').waitFor({ timeout: 8000 });
  // 名称在 el-input 内（value 不进 innerText），按输入框值断言；行数=2 数据+1 补齐空行
  const nameInputs = dlg(pageA).locator('.ri-table tbody tr td:nth-child(2) input');
  await nameInputs.nth(0).waitFor({ timeout: 5000 });
  const rowCount = await dlg(pageA).locator('.ri-table tbody tr').count();
  const [n0, n1] = await Promise.all([nameInputs.nth(0).inputValue(), nameInputs.nth(1).inputValue()]);
  const importText = await dlg(pageA).innerText();
  ok('CSV 解析回填：名称/库存入框 + 表头告警 + 有效行计数',
    n0 === 'UI导入电池盒' && n1 === 'UI导入扎带堆' && rowCount === 3 &&
    importText.includes('已识别表头') && importText.includes('（2 条有效行）'),
    `n0=${n0} n1=${n1} rows=${rowCount}`);
  // 库存列（物品表第 4 列：#/名称/规格/库存）回填数字
  const qty0 = await dlg(pageA).locator('.ri-table tbody tr td:nth-child(4) input').nth(0).inputValue();
  ok('库存数字回填（字符串→数字框）', qty0 === '12', `qty0=${qty0}`);
  await dlg(pageA).getByRole('button', { name: /导入 2 条/ }).click();
  await pageA.getByText('已导入 2 条资源').waitFor({ timeout: 8000 });
  await sleep(500);
  const panelText = await pageA.locator('.rp-wrap').innerText();
  ok('导入后面板出现两条物品卡（库存回显）', panelText.includes('UI导入电池盒') && panelText.includes('库存 12')
    && panelText.includes('UI导入扎带堆') && panelText.includes('库存 40'), panelText.replace(/\n/g, ' ').slice(0, 300));

  // ===== 8. 全局洁净度 =====
  ok('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  ok('无 /conflicts 之外的 4xx/5xx', badResp.length === 0, badResp.slice(0, 3).join(' | '));

  await ctxA.close(); await ctxB.close(); await ctxC.close();
} catch (e) {
  fail++;
  console.error('探针异常：', e);
  const allPages = browser ? browser.contexts().flatMap((c) => c.pages()) : [];
  for (const [i, pg] of allPages.entries()) {
    try {
      const sp = path.join(ROOT, 'scripts', `.probe_booking_error_${i}.png`);
      await pg.screenshot({ path: sp, fullPage: true });
      console.log('异常截图：', sp);
    } catch { /* 页没了 */ }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of children) {
    try { process.platform === 'win32' ? spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)]) : p.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  await sleep(800);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}
if (beLog.some((l) => /ERROR|uncaught/i.test(l))) console.log('⚠️ 后端日志含 ERROR 字样：\n' + beLog.slice(-10).join(''));
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
