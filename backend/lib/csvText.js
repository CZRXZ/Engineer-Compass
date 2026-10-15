// 中性 CSV 文本工具（无领域依赖）：quote-aware 行解析 + 中文编码缓冲解码
// 从 lib/bomVision.js 原样抽出，供 BOM 识别与资源预约表格导入共用，避免两份实现漂移。

// 极简 quote-aware CSV（支持引号内逗号/换行/双引号转义）
export function parseCsvText(text) {
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

// csv buffer → 文本：utf8（含 BOM）优先，失败回落 GBK（Excel 中文 Windows 默认导出常是 GBK）
export function decodeCsvBuffer(buf) {
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
  return text;
}
