// 物料采购·附件落盘（纯 fs/db 辅助，不 import routes —— 同 lib/honorFiles.js 范式）
//
// 磁盘布局：backend/uploads/purchase/{requestId}/shots/{store}   购买截图（挂物料行）
//                              .../{requestId}/invoices/{store} 发票（挂申请单，多张）
// DB（purchase_file）只存元数据；磁盘文件不随外键级联消失 —— 删行/替换三个清盘点
// 必须走这里的函数，漏一个就永久占盘（shareFiles/honorFiles 同教训）。
import { mkdirSync, existsSync, unlinkSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname, parse } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { mimeByExt, isInlineMime, sanitizeName } from './expenseMeta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 默认 uploads/purchase；PURCHASE_UPLOAD_DIR 可覆盖（部署/隔离测试用）
export const PURCHASE_ROOT = process.env.PURCHASE_UPLOAD_DIR
  ? join(process.env.PURCHASE_UPLOAD_DIR)
  : join(__dirname, '..', 'uploads', 'purchase');
// 启动即建：uploads/ 被 gitignore，生产首次部署目录不存在
// 容错：PURCHASE_UPLOAD_DIR 错配（如盘符根/不可写）不能让整个服务启动崩溃
try { mkdirSync(PURCHASE_ROOT, { recursive: true }); }
catch (e) { console.error(`⚠️ PURCHASE_UPLOAD_DIR 不可用（${PURCHASE_ROOT}）：${e.message}，采购附件上传会失败，请检查配置`); }

export const MAX_FILE = 25 * 1024 * 1024;   // 单文件 ≤25MB（截图/发票 PDF 够用）
export const REQUEST_QUOTA = Number(process.env.PURCHASE_REQUEST_QUOTA) || 200 * 1024 * 1024; // 每申请软配额 200MB

export { mimeByExt, isInlineMime, sanitizeName };

export const dirs = {
  request: (rid) => join(PURCHASE_ROOT, String(rid)),
  shots: (rid) => join(PURCHASE_ROOT, String(rid), 'shots'),
  invoices: (rid) => join(PURCHASE_ROOT, String(rid), 'invoices'),
};
export const dirOfKind = (rid, kind) => (kind === 'invoice' ? dirs.invoices(rid) : dirs.shots(rid));

export const unlinkQuiet = (p) => { try { if (existsSync(p)) unlinkSync(p); } catch {} };
const rmDirQuiet = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch {} };

// 磁盘文件名：{ts}_{6hex}{ext}（与 expense/honor 同式），扩展名走白名单字符
export function storeNameOf(origName) {
  const ext = extname(basename(String(origName || ''))).slice(0, 16).toLowerCase();
  const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : '';
  return `${Date.now()}_${randomBytes(6).toString('hex')}${safeExt}`;
}

// 某条附件记录的磁盘绝对路径（store_name 是我们生成的 basename，再 basename 一次防穿越）
export function absPathOf(fileRow) {
  if (!fileRow?.store_name) return null;
  return join(dirOfKind(fileRow.request_id, fileRow.kind), basename(fileRow.store_name));
}

// 申请已占用字节（配额校验用）
export function usedBytes(rid) {
  return db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM purchase_file WHERE request_id = ?').get(Number(rid)).n || 0;
}

// 删一个附件：先删盘（尽力）再删库；返回是否删了库行
export function deleteFile(fileRow) {
  const info = db.prepare('DELETE FROM purchase_file WHERE id = ?').run(fileRow.id);
  unlinkQuiet(absPathOf(fileRow));
  return info.changes > 0;
}

// 删申请前调：整个申请目录清盘（库行交给外键级联）
export function purgeRequestFiles(rid) {
  rmDirQuiet(dirs.request(rid));
}

// 兜「已落盘但库行消失」的无主文件（配额不过/进程被杀在 multer 落盘后写库前；
// 撤删时 rmDir 被中断残留）。24h 宽限：正在上传中的文件绝不碰。
// 失安全原则：任何「不确定归属」的情况一律保留（DB 不可用/疑似错配/单目录查询失败），
// 磁盘垃圾可以下次再清，用户发票/截图删了不可恢复。
export function sweepOrphanPurchaseFiles(hours = 24) {
  if (!existsSync(PURCHASE_ROOT)) return 0;
  // 护栏 1：清理根不能是文件系统根（PURCHASE_UPLOAD_DIR 错配成 D:\ 这类时绝不递归删）
  if (PURCHASE_ROOT === parse(PURCHASE_ROOT).root) {
    console.error(`⚠️ 采购附件清理：PURCHASE_UPLOAD_DIR=${PURCHASE_ROOT} 像是文件系统根，跳过本轮清理`);
    return 0;
  }
  // 护栏 2：DB 不可用直接放弃；DB 里 0 条申请但盘上有申请目录，几乎必然是
  // DB_PATH 指到了空库/临时库（真附件目录还在）——宁可不删并告警。
  let reqCount;
  try {
    reqCount = db.prepare('SELECT COUNT(*) AS n FROM purchase_request').get().n;
  } catch (e) {
    console.error('⚠️ 采购附件清理：数据库不可用，本轮跳过：', e.message);
    return 0;
  }
  let entries;
  try { entries = readdirSync(PURCHASE_ROOT); } catch { return 0; }
  if (reqCount === 0) {
    let numericDirs = 0;
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      try { if (statSync(join(PURCHASE_ROOT, name)).isDirectory()) numericDirs++; } catch { /* 忽略 */ }
    }
    if (numericDirs > 0) {
      console.error(`⚠️ 采购附件清理：数据库中无任何申请单，但附件根目录下有 ${numericDirs} 个申请目录`
        + `（${PURCHASE_ROOT}），疑似 DB_PATH/PURCHASE_UPLOAD_DIR 错配，本轮全部保留不删`);
      return 0;
    }
  }
  const cutoff = Date.now() - hours * 3600 * 1000;
  let removed = 0;
  const stripEmpty = (p) => {
    try {
      if (!existsSync(p) || readdirSync(p).length) return;
      rmSync(p, { recursive: true, force: true });
    } catch { /* 并发占用就留到下次 */ }
  };
  for (const ridName of entries) {
    // 护栏 3：单个目录处理中任何异常（DB 锁住/目录竞态消失）都跳过该目录，绝不带着疑问删除
    try {
      const reqDir = join(PURCHASE_ROOT, ridName);
      let st;
      try { st = statSync(reqDir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const rid = Number(ridName);
      if (!Number.isInteger(rid)) continue; // 非数字目录不认识，永不碰
      const exists = !!db.prepare('SELECT 1 FROM purchase_request WHERE id = ?').get(rid);
      if (!exists) {
        // 申请已不存在：整目录超过宽限期才清
        if (st.mtimeMs < cutoff) {
          removed += countFiles(reqDir);
          rmDirQuiet(reqDir);
        }
        continue;
      }
      // 申请还在：逐 kind 目录对账 purchase_file.store_name
      const rows = db.prepare('SELECT store_name, kind FROM purchase_file WHERE request_id = ?').all(rid);
      const known = new Set(rows.map((r) => basename(r.store_name)));
      for (const kind of ['shots', 'invoices']) {
        const kdir = join(reqDir, kind);
        if (!existsSync(kdir)) continue;
        for (const fn of readdirSync(kdir)) {
          const fp = join(kdir, fn);
          try {
            const fs2 = statSync(fp);
            if (!fs2.isFile() || known.has(fn) || fs2.mtimeMs >= cutoff) continue;
            unlinkSync(fp);
            removed++;
          } catch { /* 占用跳过，下次再试 */ }
        }
        stripEmpty(kdir);
      }
      stripEmpty(reqDir);
    } catch (e) {
      console.error(`⚠️ 采购附件清理：目录 ${ridName} 处理失败，已跳过：`, e.message);
    }
  }
  return removed;
}

function countFiles(dir) {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) n++;
      else if (e.isDirectory()) n += countFiles(join(dir, e.name));
    }
  } catch { /* 目录消失就算了 */ }
  return n;
}
