// BOM 物料清单识别（2026-10-14）：四种输入归一到同一契约
//   { items: [{name, spec, qty, unit_price}], source, warnings }
//  - xlsx：SheetJS 读第一个 sheet → 表头启发式定位 名称/规格/数量/单价 列（最准，纯本地）
//  - csv ：utf8（含 BOM）/ GBK 解码（Excel 中文 Windows 默认导出常是 GBK）→ 同一套行列启发式
//  - pdf ：复刻报销票据三级管线（pdfDoc 文字层 → GLM-OCR → 光栅化视觉，见 routes/expense.js）
//  - 图片：GLM-4V 视觉模型，BOM 专用 prompt
// 文本/视觉传输细节照抄 lib/vision.js（同 key/网关/思考模型正文提取），只是 prompt 换成 BOM 表格；
// 识别结果只用于**预填**，路由不落库，用户确认前一切可改 —— 看不清宁空不编同票据口径。
import * as XLSX from 'xlsx';
import { callGlmOcr, OcrError } from './ocr.js';
import { VisionError, extractModelText } from './vision.js';
import { pdfToRecognizeInput, PdfInputError, textUsable } from './pdfDoc.js';

const VISION_URL = () => process.env.VISION_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const VISION_MODEL = () => process.env.VISION_MODEL || 'glm-4.6v-flash';
const TIMEOUT_MS = 90_000;
const MAX_ITEMS = 200;
const NAME_MAX = 60;
const SPEC_MAX = 40;

// ---------------- 归一（模型输出 / 表格解析共用，杜绝两条路径漂移） ----------------
function numOr(v, fallback = 0) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : fallback;
  const s = String(v ?? '').replace(/[￥¥$,\s]/g, '');
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) return fallback;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fallback;
}

export function normalizeBomItems(parsed) {
  const raw = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.items) ? parsed.items : [];
  const items = [];
  for (const x of raw.slice(0, MAX_ITEMS * 2)) {
    if (!x || typeof x !== 'object') continue;
    const name = String(x.name ?? x['物料名称'] ?? x['名称'] ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    if (!name || /^(合计|总计|小计)/.test(name)) continue;
    const qty = numOr(x.qty ?? x['数量'], 1);
    const unit_price = numOr(x.unit_price ?? x['单价'], 0);
    items.push({
      name,
      spec: String(x.spec ?? x['规格'] ?? x['型号'] ?? '').replace(/\s+/g, ' ').trim().slice(0, SPEC_MAX),
      qty: qty > 0 ? qty : 1,
      unit_price,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

// ---------------- 表格（xlsx/csv）启发式 ----------------
const cellText = (v) => (v === null || v === undefined ? '' : String(v).trim());
const isNameHead = (s) => /(物料|道具|材料|品名|物品|商品|采购内容|采购物品|名称)/.test(s) && !/(单价|总价|金额|价税)/.test(s);
const isSpecHead = (s) => /(规格|型号|参数|配置)/.test(s);
const isQtyHead = (s) => /数\s*量/.test(s);
const isPriceHead = (s) => /(单价|单\s*价|参考价)/.test(s) && !/(总|合计|金额)/.test(s);
const isTotalRow = (s) => /(合计|总计|小计|总额|共计)/.test(s);

// 二维数组 → items。先找表头行（前 10 行里匹配列最多的），找不到则按列位置猜
export function parseBomAoa(aoa) {
  const warnings = [];
  const rows = (aoa || []).map((r) => (Array.isArray(r) ? r.map(cellText) : []))
    .filter((r) => r.some((c) => c !== ''));
  if (!rows.length) return { items: [], warnings: ['表格里没有读到内容'] };

  let headIdx = -1;
  let cols = null;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i];
    const pick = (test) => {
      const k = r.findIndex((c) => c && test(c));
      return k < 0 ? null : k;
    };
    const name = pick(isNameHead);
    if (name === null) continue;
    const qty = pick(isQtyHead);
    const price = pick(isPriceHead);
    if (qty === null && price === null) continue; // 名称 + 数量/单价至少各一个才算表头
    let spec = pick(isSpecHead);
    if (spec === name) spec = null;
    headIdx = i;
    cols = { name, spec, qty, price };
    break;
  }

  if (headIdx < 0) {
    // 无表头：首文本列当名称，数字列里第一个当数量、最后一个当单价；明确告警让用户核对
    warnings.push('没识别到标准表头（名称/数量/单价），已按列位置猜测，请逐行核对');
    const items = [];
    for (const r of rows) {
      const texts = r.map((c, i) => ({ c, i })).filter((x) => x.c !== '');
      const nameCell = texts.find((x) => !/^[-￥¥$\d.,\s]+$/.test(x.c));
      if (!nameCell || isTotalRow(nameCell.c)) continue;
      const nums = texts.filter((x) => x.i !== nameCell.i && /\d/.test(x.c) && numOr(x.c, -1) >= 0);
      const qty = nums.length >= 1 ? numOr(nums[0].c, 1) : 1;
      const price = nums.length >= 2 ? numOr(nums[nums.length - 1].c, 0) : (nums.length === 1 ? numOr(nums[0].c, 0) : 0);
      items.push({ name: nameCell.c.slice(0, NAME_MAX), spec: '', qty: qty || 1, unit_price: price });
      if (items.length >= MAX_ITEMS) break;
    }
    return { items: normalizeBomItems(items), warnings };
  }

  const matched = [`名称列「${rows[headIdx][cols.name]}」`];
  if (cols.qty !== null) matched.push(`数量列「${rows[headIdx][cols.qty]}」`);
  if (cols.price !== null) matched.push(`单价列「${rows[headIdx][cols.price]}」`);
  warnings.push(`已按表头识别：${matched.join('、')}${cols.spec !== null ? '、规格列「' + rows[headIdx][cols.spec] + '」' : ''}`);

  const items = [];
  for (let i = headIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = cellText(r[cols.name]);
    if (!name || isTotalRow(name)) continue;
    // 序号/分页残留行（名称列是纯数字）跳过
    if (/^\d+$/.test(name) && r.filter((c) => c !== '').length <= 1) continue;
    const qty = cols.qty !== null ? numOr(r[cols.qty], 1) : 1;
    const unit_price = cols.price !== null ? numOr(r[cols.price], 0) : 0;
    items.push({
      name: name.slice(0, NAME_MAX),
      spec: cols.spec !== null ? cellText(r[cols.spec]).slice(0, SPEC_MAX) : '',
      qty: qty || 1,
      unit_price,
    });
    if (items.length >= MAX_ITEMS) { warnings.push(`物料超过 ${MAX_ITEMS} 行，仅识别前 ${MAX_ITEMS} 行`); break; }
  }
  return { items: normalizeBomItems(items), warnings };
}

// xlsx buffer → items（取第一个有内容的 sheet）
export function recognizeBomXlsx(buf) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (e) {
    throw new VisionError(`Excel 解析失败：${String(e?.message || e).slice(0, 120)}`, '请确认是 .xlsx/.xls 文件，或另存为 CSV / 截图后重试');
  }
  const sn = wb.SheetNames?.[0];
  if (!sn) throw new VisionError('Excel 里没有工作表');
  const ws = wb.Sheets[sn];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  const { items, warnings } = parseBomAoa(aoa);
  return { items, warnings: [`工作表「${sn}」`, ...warnings], source: 'xlsx' };
}

// 极简 quote-aware CSV（支持引号内逗号/换行/双引号转义）
function parseCsvText(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* 吞掉，等 \n */ }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// csv buffer（utf8/GBK）→ items
export function recognizeBomCsv(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      text = buf.toString('utf8'); // 最后兜底（替换字符就替换了）
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const { items, warnings } = parseBomAoa(parseCsvText(text));
  return { items, warnings, source: 'csv' };
}

// ---------------- 模型（文本 / 视觉） ----------------
const BOM_SYSTEM = `你是 BOM 物料清单识别助手。用户会给你一张采购物料清单（BOM 表）的图片或从 PDF 提取的表格文字。
只输出一个 json 对象，不要任何多余文字、不要 markdown 代码块，格式固定：
{"items":[{"name":"物料/道具的完整名称","spec":"规格型号，没有就空字符串","qty":数量数字,"unit_price":单价数字}]}
规则：
1. 表格的每一种物料输出一条；表头行、标题行、"合计/总计/小计"行一律不要输出。
2. qty/unit_price 只输出纯数字（最多两位小数），不带￥/元/逗号；单价看不清就输出 0，数量看不清就输出 1。
3. name 看不清宁可不输出该条，禁止编造；规格型号并入 spec，不要塞进 name。
4. 最多输出 ${MAX_ITEMS} 条。没有可识别物料时返回 {"items":[]}。`;

function parseModelJson(raw) {
  let s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

async function postVision(body, timeoutMs) {
  const key = String(process.env.VISION_API_KEY || '').trim();
  const resp = await fetch(VISION_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text().catch(() => '');
  if (resp.status === 429) throw new VisionError('识别服务繁忙（免费模型限流 429），请稍后重试', '稍等几分钟再试，或直接手工录入明细');
  if (resp.status === 401 || resp.status === 403) {
    throw new VisionError(`识别服务鉴权失败（${resp.status}）—— 检查 VISION_API_KEY`, 'VISION_API_KEY 在服务器 .env 中配置（open.bigmodel.cn）');
  }
  if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
    throw new VisionError(`识别服务暂不可用（${resp.status}），请稍后重试`);
  }
  if (!resp.ok) throw new VisionError(`识别服务返回异常（${resp.status}）：${text.slice(0, 120)}`);
  return text;
}

function keyGuard() {
  if (!String(process.env.VISION_API_KEY || '').trim()) {
    throw new VisionError('未配置视觉识别服务（VISION_API_KEY）—— 可先手工录入明细',
      '检查服务器 .env 的 VISION_API_KEY（open.bigmodel.cn，key 形如 id.secret），配置后重启后端');
  }
}

// 图片路径：images=[{mime,b64}]
export async function recognizeBomVision(images, { timeoutMs = TIMEOUT_MS, source = 'image' } = {}) {
  keyGuard();
  if (!images?.length) throw new VisionError('缺少待识别图片');
  const msgs = [
    { role: 'system', content: BOM_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请识别这张 BOM 物料清单，按要求只输出 json。' },
        ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } })),
      ],
    },
  ];
  const bodyBase = { model: VISION_MODEL(), messages: msgs, temperature: 0.1, max_tokens: 4096 };
  let outText = await postVision({ ...bodyBase, response_format: { type: 'json_object' } }, timeoutMs)
    .catch((e) => {
      // 部分视觉模型不支持 response_format（400 带该字样）→ 去掉重试（同 vision.js）
      if (e instanceof VisionError && /400/.test(e.message) && /response_format/i.test(e.message)) return postVision(bodyBase, timeoutMs);
      throw e;
    });
  let got = extractModelText(outText);
  if (!got.text.trim() && (got.finish === 'length' || got.reasoningLen > 0)) {
    outText = await postVision({ ...bodyBase, max_tokens: 8192 }, timeoutMs); // 思考烧光配额 → 升额重试
    got = extractModelText(outText);
  }
  if (!got.text.trim()) throw new VisionError('识别失败：模型这次没给出结果，请重试或换更清晰的图片', '直接再点一次通常即可；表格请拍正、光线充足');
  const parsed = parseModelJson(got.text);
  if (!parsed) throw new VisionError('识别结果不是合法 JSON，请重试或换一张更清晰的图片');
  const items = normalizeBomItems(parsed);
  return { items, warnings: items.length ? [] : ['模型没有从图片中识别出确定的物料行，请手工录入或换图重试'], source };
}

// 文字层 / OCR 文本路径（DeepSeek json）；callModel 由路由注入（callDeepSeek 在 routes/ai.js，lib 不反向 import）
export async function recognizeBomText(text, callModel, { source = 'pdf-text' } = {}) {
  const body = String(text || '').trim();
  if (!body) throw new VisionError('未从该文件中提取到文字');
  if (typeof callModel !== 'function') throw new VisionError('文本识别通道未接入（服务端配置问题）');
  const msgs = [
    { role: 'system', content: BOM_SYSTEM },
    { role: 'user', content: `以下是从 BOM 表文件中提取的文字（可能含错位的表格线），按要求只输出 json：\n<<<\n${body.slice(0, 6000)}\n>>>` },
  ];
  let raw = '';
  try {
    raw = String((await callModel(msgs, { json: true, timeoutMs: TIMEOUT_MS })) || '');
  } catch (e) {
    const m = String(e?.message || e);
    if (/未配置|API_KEY/.test(m)) throw new VisionError('PDF 文字识别暂不可用（服务端未配置文本模型）', '可改用截图识别或手工录入');
    throw new VisionError(`识别服务返回异常（${m.slice(0, 100)}）`, '稍后重试；连续失败可改用截图识别');
  }
  const parsed = parseModelJson(raw);
  if (!parsed) throw new VisionError('识别结果不是合法 JSON，请重试', '模型偶发乱码：直接再点一次识别');
  const items = normalizeBomItems(parsed);
  return { items, warnings: items.length ? [] : ['没有从该文件中识别出确定的物料行，请核对文件内容或手工录入'], source };
}

// ②级：GLM-OCR → 文本模型；OCR 未配置/限流/无文本一律返回 null 交调用方回落（同 recognizeViaOcr）
async function recognizeBomViaOcr(buf, callModel) {
  let ocr;
  try {
    ocr = await callGlmOcr(buf);
  } catch (e) {
    if (e instanceof OcrError) return null;
    throw e;
  }
  if (!textUsable(ocr.text)) return null;
  return recognizeBomText(ocr.text, callModel, { source: 'pdf-ocr' });
}

// PDF 三级管线（结构同 routes/expense.js recognizePdf）
export async function recognizeBomPdf(buf, callModel) {
  let input;
  try {
    input = await pdfToRecognizeInput(buf);
  } catch (e) {
    if (e instanceof PdfInputError && e.code === 'PDF_FONT_MISSING') {
      const viaOcr = await recognizeBomViaOcr(buf, callModel);
      if (viaOcr) return viaOcr;
    }
    throw e;
  }
  if (input.kind === 'text') return recognizeBomText(input.text, callModel, { source: 'pdf-text' });
  const viaOcr = await recognizeBomViaOcr(buf, callModel);
  if (viaOcr) return viaOcr;
  const out = await recognizeBomVision(input.images, { source: 'pdf-image' });
  if (input.truncated) out.warnings = [`该 PDF 共 ${input.pageCount} 页，本次仅识别了前 ${input.images.length} 页`, ...out.warnings];
  return out;
}
