// 资源分享 GitHub 化后端冒烟：发帖 slug 生成 + 同用户去重 → /u/:username 与 /p/:username/slug
//   （匿名可读开源项目；私密后匿名/他人 404，作者可见；错 slug/错用户名统一 404 防探测）→
//   文件端点（fid 读取/文本/整包 zip）随帖子一起私密兜底，枚举 fid 也探不到 →
//   列表开源过滤（匿名只见公开；mine 含私密；favs 转私密后自动隐藏，恢复开源后回归）→
//   visibility 端点（非本人 403、非法值 400）；PUT 改标题不动 slug/is_public；stats 只统计开源头。
//
// 全程沙盒自起后端：临时库 + SHARE_UPLOAD_DIR/HONOR/PURCHASE 临时目录 + 临时 cwd（无 .env）。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKEND = join(ROOT, 'backend');
const PORT = 3107;
const BASE = `http://localhost:${PORT}/api`;

const work = mkdtempSync(join(tmpdir(), 'smk-repo-'));
const serverEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  PORT: String(PORT),
  DB_PATH: join(work, 'compass.db'),
  SHARE_UPLOAD_DIR: join(work, 'share'),
  HONOR_UPLOAD_DIR: join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: join(work, 'purchase'),
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}${extra ? ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`)); };

const req = async (path, opts = {}) => {
  const isForm = opts.body instanceof FormData;
  const headers = { ...(isForm ? {} : { 'Content-Type': opts.ct || 'application/json' }),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const res = await fetch(BASE + path, {
    headers, method: opts.method || 'GET',
    body: opts.body !== undefined && !isForm ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(async () => {
    // 非 JSON（文件流/zip）：返回状态标记，不把流读进 JSON
    await res.body?.cancel?.();
    return { __nonJson: true };
  });
  return { res, status: res.status, data };
};
const api = async (path, opts = {}) => {
  const { res, data } = await req(path, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const expect = async (path, expected, opts = {}) => {
  const { data, status: got } = await req(path, opts);
  return { ok: got === expected, got, data };
};
// 二进制读取（文件/zip），只断言状态码与响应非空
const rawStatus = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, size: buf.length, ctype: res.headers.get('content-type') || '' };
};
// multipart 上传项目文件夹：entries = [[文件名, 文本内容, 相对路径], ...]
const uploadFolder = async (token, entries) => {
  const fd = new FormData();
  const paths = [];
  for (const [name, content, rel] of entries) {
    fd.append('files', new Blob([content], { type: 'text/plain' }), name);
    paths.push(rel);
  }
  fd.append('paths', JSON.stringify(paths));
  const { data } = await req('/share/uploads', { method: 'POST', token, body: fd });
  return data;
};

let server = null;
const serverLog = [];
try {
  server = spawn(process.execPath, [join(BACKEND, 'server.js')], {
    cwd: work, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  server.stdout.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push(l)));
  server.stderr.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push(l)));

  const ready = await (async () => {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; } catch { /* 等 */ }
      await new Promise((s) => setTimeout(s, 250));
    }
    return false;
  })();
  if (!ready) throw new Error('临时后端 15s 内未就绪');

  // ---------- 0. 用户：A 楼主、B 路人 ----------
  const stamp = Date.now().toString(36);
  const rA = await api('/auth/register', { method: 'POST', body: { email: `repoa_${stamp}@x.dev`, password: 'pass123456', nickname: '楼主A' } });
  const rB = await api('/auth/register', { method: 'POST', body: { email: `repob_${stamp}@x.dev`, password: 'pass123456', nickname: '路人B' } });
  const tA = rA.token, tB = rB.token;
  const nameA = rA.user.username, nameB = rB.user.username;
  ok('注册两人并拿到自动用户名', !!nameA && !!nameB && nameA !== nameB, [nameA, nameB]);

  // ---------- 1. 发帖 slug 生成：空白/斜杠转连字符，危险字符剥掉 ----------
  const title = '我的 竞赛/资料? v1';
  const p1 = await api('/share/posts', { method: 'POST', token: tA, body: { title, content: '正文一' } });
  ok('发帖返回 slug/is_public=1', p1.slug === '我的-竞赛-资料-v1' && p1.is_public === 1, p1);
  const p1b = await api('/share/posts', { method: 'POST', token: tA, body: { title, content: '正文二' } });
  ok('同用户同名自动加 -2', p1b.slug === '我的-竞赛-资料-v1-2', p1b.slug);

  // ---------- 2. 文件夹上传 + 绑定发帖 ----------
  const up = await uploadFolder(tA, [
    ['readme.md', '# hi\n', 'readme.md'],
    ['a.txt', 'aaa', 'docs/a.txt'],
  ]);
  ok('暂存上传 2 文件、无拒收', up.rows?.length === 2 && (up.rejected?.length || 0) === 0, up);
  const p3 = await api('/share/posts', {
    method: 'POST', token: tA,
    body: { title: '带文件夹的项目', content: '见仓库', files: up.rows.map((x) => x.id) },
  });
  ok('文件随帖发布，slug 正常', p3.slug === '带文件夹的项目', p3);
  const fidReadme = up.rows.find((x) => x.path === 'readme.md').id;
  const fidDoc = up.rows.find((x) => x.path === 'docs/a.txt').id;

  // ---------- 3. 开源项目匿名可读（slug 路由 + 数字路由同 payload） ----------
  let g = await expect(`/share/p/${nameA}/${p3.slug}`, 200);
  ok('匿名 GET /p/:u/:slug 200 且文件/用户名字段齐', g.data.files?.length === 2 && g.data.username === nameA && g.data.is_public === 1,
    { files: g.data.files?.length, username: g.data.username });
  g = await expect(`/share/posts/${p3.id}`, 200);
  ok('旧数字路由仍 200 且带 slug/username', g.data.slug === p3.slug && g.data.username === nameA);
  let rf = await rawStatus(`/share/files/${fidReadme}`);
  ok('开源文件匿名可直接取（200，非空）', rf.status === 200 && rf.size > 0, rf);
  rf = await rawStatus(`/share/files/${fidDoc}/text`);
  ok('开源文本匿名可读', rf.status === 200);
  rf = await rawStatus(`/share/posts/${p3.id}/zip`);
  ok('开源整包匿名可下载（zip）', rf.status === 200 && rf.ctype.includes('zip'), rf);

  // ---------- 4. 用户项目页 ----------
  g = await expect(`/share/u/${nameA}`, 200);
  ok('匿名看用户项目页：3 个开源项目', g.data.total === 3 && g.data.user.username === nameA, g.data.total);
  g = await expect('/share/u/no_such_user_xyz', 404);
  ok('不存在用户 404（不泄露）', g.ok);
  g = await expect(`/share/p/${nameA}/no-such-slug`, 404);
  ok('错误 slug 统一 404', g.ok);

  // ---------- 5. B 先收藏开源的 p3，然后 A 转私密 ----------
  let fav = await api(`/share/posts/${p3.id}/fav`, { method: 'POST', token: tB });
  ok('路人收藏开源项目成功', fav.faved === true, fav);
  g = await expect(`/share/posts/${p3.id}/visibility`, 403, { method: 'POST', token: tB, body: { is_public: 0 } });
  ok('非本人不能切换开源状态 403', g.ok);
  g = await expect(`/share/posts/${p3.id}/visibility`, 400, { method: 'POST', token: tA, body: { is_public: 9 } });
  ok('非法 is_public 400', g.ok);
  const vs = await api(`/share/posts/${p3.id}/visibility`, { method: 'POST', token: tA, body: { is_public: 0 } });
  ok('作者切私密成功', vs.is_public === 0, vs);

  // ---------- 6. 私密兜底：项目、数字路由、文件、zip、互动全部 404 ----------
  for (const [who, token] of [['匿名', null], ['路人B', tB]]) {
    g = await expect(`/share/p/${nameA}/${p3.slug}`, 404, token ? { token } : {});
    ok(`私密项目 ${who} slug 路由 404`, g.ok);
    g = await expect(`/share/posts/${p3.id}`, 404, token ? { token } : {});
    ok(`私密项目 ${who} 数字路由 404`, g.ok);
    rf = await rawStatus(`/share/files/${fidReadme}`, token ? { token } : {});
    ok(`私密文件 ${who} 枚举 fid 也 404`, rf.status === 404, rf.status);
    rf = await rawStatus(`/share/files/${fidDoc}/text`, token ? { token } : {});
    ok(`私密文本 ${who} 404`, rf.status === 404, rf.status);
    rf = await rawStatus(`/share/posts/${p3.id}/zip`, token ? { token } : {});
    ok(`私密 zip ${who} 404`, rf.status === 404, rf.status);
    // 匿名在 authRequired 就被 401 拦下；登录路人则穿透到私密 404（两者都不构成互动）
    g = await expect(`/share/posts/${p3.id}/like`, who === '匿名' ? 401 : 404, { method: 'POST', token, body: {} });
    ok(`私密项目 ${who} 点赞入口被拦（匿名 401/他人 404）`, g.ok, g.got);
  }
  g = await expect(`/share/p/${nameA}/${p3.slug}`, 200, { token: tA });
  ok('作者本人对私密项目 200', g.ok && g.data.is_public === 0);
  rf = await rawStatus(`/share/files/${fidReadme}`, { token: tA });
  ok('作者可取私密文件', rf.status === 200, rf.status);
  rf = await rawStatus(`/share/posts/${p3.id}/zip`, { token: tA });
  ok('作者可下私密 zip', rf.status === 200, rf.status);

  // ---------- 7. 列表与用户页的开源过滤 ----------
  g = await req('/share/posts?size=50');
  ok('大厅列表匿名不见私密项目（只见 p1/p1b）', g.data.total === 2 && g.data.rows.every((x) => x.is_public === 1),
    g.data.rows?.map((x) => x.id));
  ok('大厅行带 username/slug', g.data.rows.every((x) => x.username && x.slug));
  g = await req('/share/posts?scope=mine&size=50', { token: tA });
  ok('我的列表含全部 3 个（含私密 is_public=0）', g.data.total === 3 && g.data.rows.some((x) => x.id === p3.id && x.is_public === 0),
    g.data.rows?.map((x) => [x.id, x.is_public]));
  g = await expect('/share/u/' + nameA, 200);
  ok('用户项目页匿名只见 2 个开源', g.data.total === 2, g.data.total);
  g = await expect('/share/u/' + nameA, 200, { token: tA });
  ok('用户项目页作者见 3 个（含私密带锁标记）', g.data.total === 3 && g.data.projects.some((x) => x.is_public === 0));
  g = await req('/share/posts?scope=favs', { token: tB });
  ok('收藏夹：项目转私密后自动消失', g.data.total === 0 && Array.isArray(g.data.rows), g.data);

  // ---------- 8. PUT 改标题：slug 与 is_public 都不动 ----------
  const up3 = await api(`/share/posts/${p3.id}`, { method: 'PUT', token: tA, body: { title: '改名后的文件夹项目' } });
  ok('PUT 成功', !!up3.message);
  g = await expect(`/share/p/${nameA}/${p3.slug}`, 200, { token: tA });
  ok('slug 不变（旧 URL 仍 200）、标题已更新、仍私密',
    g.data.slug === p3.slug && g.data.title === '改名后的文件夹项目' && g.data.is_public === 0,
    [g.data.slug, g.data.title, g.data.is_public]);
  const fp = await api('/share/posts', { method: 'POST', token: tA, body: { title: '直接发私密帖', content: 'x', is_public: 0 } });
  ok('发帖可直接 is_public=0', fp.is_public === 0, fp);

  // ---------- 9. 恢复开源：路人可读、收藏回归、stats 只统计开源 ----------
  await api(`/share/posts/${p3.id}/visibility`, { method: 'POST', token: tA, body: { is_public: 1 } });
  g = await expect(`/share/p/${nameA}/${p3.slug}`, 200);
  ok('恢复开源后匿名 200', g.ok);
  g = await req('/share/posts?scope=favs', { token: tB });
  ok('恢复开源后路人收藏夹回归', g.data.total === 1, g.data.total);
  g = await req('/share/posts?size=1');
  // 开源帖：p1、p1b、p3 共 3（fp 私密不计）；幽灵帖无；stats 不随 scope/tag 变
  ok('stats.posts 只统计开源普通帖（=3）', g.data.stats.posts === 3, g.data.stats);

  // ---------- 10. 他人用户名空间隔离 ----------
  g = await expect(`/share/u/${nameB}`, 200);
  ok('路人 B 自己项目页为空', g.data.total === 0 && Array.isArray(g.data.projects));
  g = await expect(`/share/p/${nameB}/${p3.slug}`, 404);
  ok('slug 在别的用户名下 404（owner 隔离）', g.ok);

  // ---------- 11. 管理员在开源大厅同样只见开源帖（回归：私密项目曾因管理员豁免漏进大厅） ----------
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(serverEnv.DB_PATH);
    db.exec('PRAGMA busy_timeout=5000');
    // fp 是 A 直接发的私密帖（第 8 节）；把 A 提为管理员后它仍不能出现在大厅
    db.prepare('UPDATE user SET is_admin = 1 WHERE id = ?').run(rA.user.id);
    db.close();
    g = await req('/share/posts?size=50', { token: tA });
    ok('★ 管理员视角大厅无私密项目（fp 不出现，全行 is_public=1）',
      g.data.rows.every((x) => x.is_public === 1) && !g.data.rows.some((x) => x.id === fp.id),
      g.data.rows?.map((x) => [x.id, x.is_public]));
    ok('管理员大厅 stats 也不含私密/幽灵帖（posts=3）', g.data.stats.posts === 3, g.data.stats);
    // 详情与「我的项目」仍可访问（巡检不受影响）
    g = await expect(`/share/p/${nameA}/${fp.slug}`, 200, { token: tA });
    ok('管理员/作者仍可直链私密项目 200', g.ok && g.data.is_public === 0);
  }
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

console.log(`\n资源路由冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
