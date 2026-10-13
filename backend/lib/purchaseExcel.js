// 物料采购·Excel 导出（SheetJS CE，写法与 lib/expenseExcel.js 同式）
// 4 个 sheet：物料明细（一行一物料，末行合计公式）/ 按比赛·项目汇总 / 个人汇总 / 审批轨迹
import * as XLSX from 'xlsx';

// 文本注入防护：=+-@ 开头加单引号（CE 无样式，纯 aoa）
const cellSafe = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};
const cellNum = (v) => {
  const n = Math.round(Number(v || 0) * 100) / 100;
  return { t: 'n', v: Number.isFinite(n) ? n : 0 };
};
const L = (i) => XLSX.utils.encode_col(i);
const STATUS_ZH = { pending: '待审批', approved: '待传发票', invoiced: '已传发票', rejected: '已驳回' };
const ROLE_ZH = { leader: '负责人', teacher: '老师' };
const RESULT_ZH = { approved: '通过', rejected: '驳回' };

function sheetName(name, used) {
  let s = String(name || 'sheet').replace(/[\\/?*\[\]:]/g, '').slice(0, 31) || 'sheet';
  let base = s, i = 2;
  while (used.has(s)) s = `${base.slice(0, 28)}_${i++}`;
  used.add(s);
  return s;
}

function setSum(ws, rowIdx, colIdx, fromRow, toRow) {
  const ref = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  ws[ref] = { t: 'n', f: `=SUM(${L(colIdx)}${fromRow}:${L(colIdx)}${toRow})` };
}

// details：申请详情数组（items/logs 已内嵌，同 GET /requests/:id 的形状）
export function buildPurchaseWorkbook(details, scopeLabel = '全部申请') {
  const wb = XLSX.utils.book_new();
  const used = new Set();

  // ---- Sheet1 物料明细（一行一物料） ----
  const head = ['申请ID', '申请人', '比赛/项目', '类型', '物料名称', '规格型号', '数量', '单价', '金额',
    '购买链接', '状态', '申请时间', '当前审批人', '审批身份', '审批意见', '发票数'];
  const aoa = [head];
  // 金额列 = 第 9 列（index 8）；数据从第 2 行（index 1）起
  for (const d of details) {
    const common = [
      d.id,
      cellSafe(d.applicant_name),
      cellSafe(d.event_name),
      cellSafe(d.kind),
    ];
    const tail = [
      STATUS_ZH[d.status] || d.status,
      cellSafe((d.submit_time || '').replace('T', ' ').slice(0, 19)),
      cellSafe(d.approver_name || ''),
      ROLE_ZH[d.approver_role] || '',
      cellSafe(d.status === 'rejected' ? d.reject_reason || '' : ''),
      d.invoice_count || 0,
    ];
    const items = d.items?.length ? d.items : [{ name: '（无明细）', spec: '', qty: 0, unit_price: 0, amount: 0, link: '' }];
    for (const it of items) {
      aoa.push([
        ...common,
        cellSafe(it.name), cellSafe(it.spec || ''),
        cellNum(it.qty), cellNum(it.unit_price), cellNum(it.amount),
        cellSafe(it.link || ''),
        ...tail,
      ]);
    }
  }
  const firstData = 2; // Excel 行号（1-based），aoa index 1
  const lastData = aoa.length;
  aoa.push(['合计', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  const ws1 = XLSX.utils.aoa_to_sheet(aoa);
  setSum(ws1, aoa.length - 1, 8, firstData, lastData); // I 列金额合计
  ws1['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 20 }, { wch: 7 }, { wch: 28 }, { wch: 16 },
    { wch: 7 }, { wch: 9 }, { wch: 10 }, { wch: 22 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 9 }, { wch: 26 }, { wch: 7 }];
  XLSX.utils.book_append_sheet(wb, ws1, sheetName('物料明细', used));

  // ---- Sheet2 按比赛·项目汇总 ----
  const byEvent = new Map();
  for (const d of details) {
    const k = `${d.event_id}#${d.event_name}`;
    if (!byEvent.has(k)) byEvent.set(k, { event_id: d.event_id, name: d.event_name, kind: d.kind, count: 0, approved: 0, pending: 0, rejected: 0, invoicePending: 0 });
    const g = byEvent.get(k);
    g.count += 1;
    if (d.status === 'approved' || d.status === 'invoiced') g.approved += d.amount;
    else if (d.status === 'pending') g.pending += d.amount;
    else if (d.status === 'rejected') g.rejected += d.amount;
    if (d.status === 'approved') g.invoicePending += 1;
  }
  const aoa2 = [['比赛/项目', '类型', '申请数', '已通过金额', '待审批金额', '已驳回金额', '待传发票申请数']];
  for (const g of [...byEvent.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
    aoa2.push([cellSafe(g.name), cellSafe(g.kind), cellNum(g.count), cellNum(g.approved), cellNum(g.pending), cellNum(g.rejected), cellNum(g.invoicePending)]);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(aoa2);
  ws2['!cols'] = [{ wch: 24 }, { wch: 7 }, { wch: 8 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws2, sheetName('按比赛项目汇总', used));

  // ---- Sheet3 个人汇总 ----
  const byUser = new Map();
  for (const d of details) {
    if (!byUser.has(d.user_id)) byUser.set(d.user_id, { name: d.applicant_name, count: 0, approved: 0, invoicePending: 0 });
    const g = byUser.get(d.user_id);
    g.count += 1;
    if (d.status === 'approved' || d.status === 'invoiced') g.approved += d.amount;
    if (d.status === 'approved') g.invoicePending += 1;
  }
  const aoa3 = [['申请人', '申请数', '已通过金额', '待传发票申请数']];
  for (const g of [...byUser.values()].sort((a, b) => b.approved - a.approved)) {
    aoa3.push([cellSafe(g.name), cellNum(g.count), cellNum(g.approved), cellNum(g.invoicePending)]);
  }
  const ws3 = XLSX.utils.aoa_to_sheet(aoa3);
  ws3['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 13 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws3, sheetName('个人汇总', used));

  // ---- Sheet4 审批轨迹 ----
  const aoa4 = [['申请ID', '比赛/项目', '审批人', '身份', '结果', '意见', '时间']];
  for (const d of details) {
    for (const lg of d.logs || []) {
      aoa4.push([
        d.id, cellSafe(d.event_name), cellSafe(lg.approver_name),
        ROLE_ZH[lg.role] || lg.role || '',
        RESULT_ZH[lg.result] || lg.result,
        cellSafe(lg.comment || ''),
        cellSafe((lg.create_time || '').replace('T', ' ').slice(0, 19)),
      ]);
    }
  }
  const ws4 = XLSX.utils.aoa_to_sheet(aoa4);
  ws4['!cols'] = [{ wch: 8 }, { wch: 22 }, { wch: 12 }, { wch: 9 }, { wch: 7 }, { wch: 30 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws4, sheetName('审批轨迹', used));

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
