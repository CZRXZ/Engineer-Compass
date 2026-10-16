// 一次性清洗（2026-10-16）：双层署名快照  真名（真名（昵称）） → 真名（昵称）
//
// 成因：displayNameOf 的组合快照被前端二次组合（详见 PROJECT_MEMORY 2026-10-16 条）。
// 只清洗「写库瞬间走 displayNameOf」的快照列；报销花名册是自由文本、audit_log 只存 username，均不碰。
//
// 用法：
//   node scripts/cleanup_double_names.mjs           # dry-run，只列出命中与样例
//   node scripts/cleanup_double_names.mjs --apply   # 事务内实际 UPDATE
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const DB = process.env.PROBE_DB || join(__dirname, '..', 'backend', 'data', 'compass.db');

// 真名/昵称都不含括号；匹配「X（X（Y））」整体（覆盖 Y 本身带学号风括号已闭合的情形）
const RE = /([^（）()]{1,30})（\1（([^（）()]*)））/g;
const fix = (s) => String(s ?? '').replace(RE, '$1（$2）');

// [表, 列] —— 全部是 displayNameOf 写库快照
const TARGETS = [
  ['booking', 'booker_name'], ['booking', 'approver_name'], ['booking', 'cancel_by_name'],
  ['booking_participant', 'user_name'], ['booking_log', 'actor_name'],
  ['booking_team', 'owner_name'], ['booking_team_member', 'user_name'],
  ['purchase_request', 'applicant_name'], ['purchase_request', 'approver_name'],
  ['purchase_approval_log', 'approver_name'],
  ['personal_notice', 'title'], ['personal_notice', 'content'],
];

const db = new DatabaseSync(DB);
db.exec('PRAGMA foreign_keys=ON');
let total = 0;
const samples = [];
try {
  db.exec('BEGIN');
  for (const [table, col] of TARGETS) {
    const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} LIKE '%（%（%））%'`).all();
    let n = 0;
    const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
    for (const r of rows) {
      const fixed = fix(r.v);
      if (fixed === r.v) continue; // 形似但不是「同名嵌套」，不动
      n++;
      if (samples.length < 15) samples.push(`${table}.${col}#${r.id}: ${r.v}  →  ${fixed}`);
      if (APPLY) upd.run(fixed, r.id);
    }
    if (n) console.log(`${table}.${col}: ${n} 行${APPLY ? ' 已修正' : ' 待修正'}`);
    total += n;
  }
  if (APPLY) db.exec('COMMIT'); else db.exec('ROLLBACK');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
console.log(`\n${APPLY ? '实际修正' : 'dry-run 命中'} ${total} 行`);
if (samples.length) { console.log('样例：'); samples.forEach((s) => console.log('  ' + s)); }
db.close();
