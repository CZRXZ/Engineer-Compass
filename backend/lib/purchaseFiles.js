// 物料采购·附件落盘（纯 fs/db 辅助，不 import routes —— 同 lib/honorFiles.js 范式）
//
// 磁盘布局：backend/uploads/purchase/{requestId}/shots/{store}   购买截图（挂物料行）
//                              .../{requestId}/invoices/{store} 发票（挂申请单，多张）
// DB（purchase_file）只存元数据；磁盘文件不随外键级联消失 —— 删行/替换三个清盘点
// 必须走这里的函数，漏一个就永久占盘（shareFiles/honorFiles 同教训）。
import { mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { mimeByExt, isInlineMime, sanitizeName } from './expenseMeta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PURCHASE_ROOT = join(__dirname, '..', 'uploads', 'purchase');
// 启动即建：uploads/ 被 gitignore，生产首次部署目录不存在
mkdirSync(PURCHASE_ROOT, { recursive: true });

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
