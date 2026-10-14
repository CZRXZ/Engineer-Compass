// 失安全验证：清理逻辑在「正常 / DB 错配空库 / 根目录错配」三种场景下的行为。
// 每个场景独立子进程（env 必须在 import 前注入），数据全在 os.tmpdir 沙盒里。
// 用完即删，不进仓库常规脚本。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const CASE = process.argv[2];
const sandbox = process.env.SMK_ROOT;

function walk(dir, base = dir) {
  let out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p, base));
    else out.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out.sort();
}
const old = () => new Date(Date.now() - 3 * 86400e3);
const mkfile = (p, mtime) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'); if (mtime) utimesSync(p, mtime, mtime); };

// ---------- 子进程场景 ----------
if (CASE === 'purchase-populate') {
  const { sweepOrphanPurchaseFiles } = await import('../backend/lib/purchaseFiles.js');
  const db = (await import('../backend/db/database.js')).default;
  db.prepare("INSERT INTO user (username,password_hash) VALUES ('sweep_u','x')").run();
  db.prepare("INSERT INTO purchase_event (name) VALUES ('sweep-ev')").run();
  db.prepare("INSERT INTO purchase_request (event_id,user_id,applicant_name) VALUES (1,1,'s')").run();
  db.prepare("INSERT INTO purchase_file (request_id,kind,orig_name,store_name,mime,size) VALUES (1,'shot','s.png','111111_aaaaaa.png','image/png',1)").run();
  db.prepare("INSERT INTO purchase_file (request_id,kind,orig_name,store_name,mime,size) VALUES (1,'invoice','i.pdf','222222_bbbbbb.pdf','application/pdf',1)").run();
  const root = process.env.SMK_PURCHASE_ROOT;
  // 申请 1（库中存在）：有主文件（故意做成 3 天前的旧文件）/ 无主旧文件 / 无主新文件
  mkfile(join(root, '1/shots/111111_aaaaaa.png'), old());
  mkfile(join(root, '1/shots/orphan_old.png'), old());
  mkfile(join(root, '1/shots/orphan_new.png'));
  mkfile(join(root, '1/invoices/222222_bbbbbb.pdf'), old());
  // 申请 2：库行不存在 + 目录/文件都是旧的 → 整目录删
  mkfile(join(root, '2/shots/x.png'), old());
  utimesSync(join(root, '2'), old(), old()); utimesSync(join(root, '2/shots'), old(), old());
  // 申请 3：库行不存在但目录是新的 → 保留
  mkfile(join(root, '3/shots/y.png'));
  // 非数字目录 → 永不碰
  mkfile(join(root, 'keepme/notes.txt'));
  const removed = sweepOrphanPurchaseFiles(24);
  console.log('JSON ' + JSON.stringify({ removed, files: walk(root) }));
} else if (CASE === 'purchase-misconfig') {
  // 灾难重演：DB_PATH 是全新空库，附件目录是「真实」沙盒（含旧文件）
  const { sweepOrphanPurchaseFiles } = await import('../backend/lib/purchaseFiles.js');
  const root = process.env.SMK_PURCHASE_ROOT;
  const before = walk(root);
  const removed = sweepOrphanPurchaseFiles(24);
  console.log('JSON ' + JSON.stringify({ removed, before, after: walk(root) }));
} else if (CASE === 'purchase-root-guard') {
  const { sweepOrphanPurchaseFiles } = await import('../backend/lib/purchaseFiles.js');
  console.log('JSON ' + JSON.stringify({ removed: sweepOrphanPurchaseFiles(24) }));
} else if (CASE === 'honor-populate') {
  const { sweepOrphanHonorFiles } = await import('../backend/lib/honorFiles.js');
  const db = (await import('../backend/db/database.js')).default;
  db.prepare("INSERT INTO honor (title,store_name) VALUES ('sweep-h','known.jpg')").run();
  db.prepare("INSERT INTO honor (title,store_name) VALUES ('sweep-h2','ledger_old.jpg')").run();
  const dir = process.env.SMK_HONOR_DIR;
  mkfile(join(dir, 'known.jpg'));
  mkfile(join(dir, 'ledger_old.jpg'), old()); // 有主且陈旧——空库错配时全靠护栏保命
  mkfile(join(dir, 'orphan_old.jpg'), old());
  mkfile(join(dir, 'orphan_new.jpg'));
  const removed = sweepOrphanHonorFiles(24);
  console.log('JSON ' + JSON.stringify({ removed, files: walk(dir) }));
} else if (CASE === 'honor-misconfig') {
  const { sweepOrphanHonorFiles } = await import('../backend/lib/honorFiles.js');
  const dir = process.env.SMK_HONOR_DIR;
  const before = walk(dir);
  const removed = sweepOrphanHonorFiles(24);
  console.log('JSON ' + JSON.stringify({ removed, before, after: walk(dir) }));
} else {
  // ---------- 主控 ----------
  const work = mkdtempSync(join(tmpdir(), 'sweep-safe-'));
  const pRoot = join(work, 'purchase'); const hDir = join(work, 'honor');
  mkdirSync(pRoot, { recursive: true }); mkdirSync(hDir, { recursive: true });
  const realDb = join(work, 'real.db'); const emptyDb = join(work, 'empty.db'); const emptyDb2 = join(work, 'empty2.db');
  let pass = 0, fail = 0;
  const ok = (cond, name, extra) => { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (extra ? ' → ' + extra : '')); } };
  const run = (k, env) => {
    const r = spawnSync(process.execPath, [process.argv[1], k], {
      env: { ...process.env, SMK_PURCHASE_ROOT: pRoot, SMK_HONOR_DIR: hDir, ...env },
      encoding: 'utf8',
    });
    if (r.status !== 0) { console.error(r.stderr); throw new Error(k + ' 子进程异常'); }
    return JSON.parse(r.stdout.trim().split('\n').find((l) => l.startsWith('JSON ')).slice(5));
  };

  // 1) 正常场景：该删的删、该留的留
  let res = run('purchase-populate', { DB_PATH: realDb, PURCHASE_UPLOAD_DIR: pRoot });
  ok(res.removed === 2, '正常库：返回清理数 2（1 无主旧文件 + 1 无主申请目录）', JSON.stringify(res));
  const f = res.files;
  ok(f.includes('1/shots/111111_aaaaaa.png'), '有主截图保留');
  ok(f.includes('1/invoices/222222_bbbbbb.pdf'), '有主发票保留');
  ok(f.includes('1/shots/orphan_new.png'), '24h 内新文件保留（防误删上传中）');
  ok(!f.some((x) => x.startsWith('1/shots/orphan_old')), '超 24h 无主文件删除');
  ok(!f.some((x) => x.startsWith('2/')), '无主申请整目录删除');
  ok(f.includes('3/shots/y.png'), '新无主申请目录保留');
  ok(f.includes('keepme/notes.txt'), '非数字目录永不碰');

  // 2) 灾难场景：空库 + 同一有数据目录 → 0 删除且文件全留
  res = run('purchase-misconfig', { DB_PATH: emptyDb, PURCHASE_UPLOAD_DIR: pRoot });
  ok(res.removed === 0, '【关键】空库错配：返回 0 不动任何文件', JSON.stringify({ removed: res.removed }));
  ok(JSON.stringify(res.before) === JSON.stringify(res.after), '【关键】空库错配：磁盘文件清单逐一不变');

  // 3) 根目录错配成盘符根 → 立即放弃
  res = run('purchase-root-guard', { DB_PATH: emptyDb2, PURCHASE_UPLOAD_DIR: 'D:\\' });
  ok(res.removed === 0, '清理根=盘符根时直接跳过');

  // 4) 荣誉墙正常场景
  res = run('honor-populate', { DB_PATH: realDb, HONOR_UPLOAD_DIR: hDir });
  ok(res.removed === 1, '荣誉墙：无主旧图删 1 张', JSON.stringify(res.files));
  ok(res.files.includes('known.jpg') && res.files.includes('ledger_old.jpg') && res.files.includes('orphan_new.jpg'),
    '荣誉墙：有主新图/有主旧图/无主新图全部保留');

  // 5) 荣誉墙空库错配 → 全保留
  res = run('honor-misconfig', { DB_PATH: join(work, 'empty3.db'), HONOR_UPLOAD_DIR: hDir });
  ok(res.removed === 0, '【关键】荣誉墙空库错配：返回 0', JSON.stringify({ removed: res.removed }));
  ok(JSON.stringify(res.before) === JSON.stringify(res.after), '【关键】荣誉墙空库错配：文件清单不变');

  rmSync(work, { recursive: true, force: true });
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
