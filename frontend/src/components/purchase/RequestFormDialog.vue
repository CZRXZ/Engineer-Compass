<template>
  <!-- 新建/修改采购申请：受控弹窗（:model-value + @update:model-value，全站弹窗同式） -->
  <el-dialog
    :model-value="modelValue"
    :title="isEdit ? '修改采购申请' : '新建采购申请'"
    width="900px"
    append-to-body
    destroy-on-close
    :close-on-click-modal="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @closed="onClosed"
  >
    <el-form label-position="top" class="pf">
      <el-form-item label="比赛 / 项目" required>
        <el-select v-model="form.event_id" placeholder="选择所属比赛或项目档案" filterable class="ev-select">
          <el-option v-for="e in events" :key="e.id" :value="e.id" :label="`${e.kind === '项目' ? '📁' : '🏆'} ${e.name}`">
            <span>{{ e.kind === '项目' ? '📁' : '🏆' }} {{ e.name }}</span>
            <span v-if="e.status === 'closed'" class="opt-closed">已关闭</span>
          </el-option>
        </el-select>
      </el-form-item>

      <div class="items-head">
        <b>物料明细</b>
        <span class="hint">名称必填；数量 > 0；金额 = 数量 × 单价，自动计算</span>
        <span class="spacer"></span>
        <!-- BOM 识别：Excel/CSV/PDF/截图，识别结果追加到表格（不清空已填行） -->
        <input ref="bomInput" type="file" accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp" hidden @change="onBom" />
        <el-button size="small" :loading="bomLoading" @click="bomInput?.click()">🤖 BOM 表识别填表</el-button>
        <el-button size="small" type="primary" plain @click="addRow">＋ 添加一行</el-button>
      </div>
      <el-alert v-for="(w, i) in bomWarnings" :key="i" :title="w" type="success" :closable="false" show-icon class="bom-w" />

      <!-- 桌面：表格录入 -->
      <table class="items-table">
        <thead>
          <tr>
            <th class="c-name">物料/道具名称</th>
            <th class="c-spec">规格型号</th>
            <th class="c-qty">数量</th>
            <th class="c-price">单价(元)</th>
            <th class="c-amt">金额</th>
            <th class="c-link">购买链接</th>
            <th class="c-shot">截图</th>
            <th class="c-del"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(it, i) in form.items" :key="it._k">
            <td><el-input v-model="it.name" size="small" placeholder="如：Arduino 主控板" maxlength="60" /></td>
            <td><el-input v-model="it.spec" size="small" placeholder="如 UNO R3" maxlength="40" /></td>
            <td><el-input-number v-model="it.qty" :min="0.01" :precision="2" :controls="false" size="small" class="num" /></td>
            <td><el-input-number v-model="it.unit_price" :min="0" :precision="2" :controls="false" size="small" class="num" /></td>
            <td class="amt">{{ amountOf(it).toFixed(2) }}</td>
            <td><el-input v-model="it.link" size="small" placeholder="https://…" /></td>
            <td>
              <div class="shot-cell">
                <img v-if="shotUrl(it)" :src="shotUrl(it)" alt="" @click="previewShot(it)" />
                <el-button v-else size="small" @click="pickShot(i)">＋ 截图</el-button>
                <template v-if="shotUrl(it) || it.pendingShot">
                  <el-button link size="small" @click="pickShot(i)">替换</el-button>
                  <el-button link size="small" type="danger" @click="removeShot(it)">删</el-button>
                </template>
              </div>
            </td>
            <td><el-button link type="danger" size="small" :disabled="form.items.length <= 1" @click="form.items.splice(i, 1)">✕</el-button></td>
          </tr>
        </tbody>
      </table>

      <!-- 窄屏：卡片录入（表格横溢） -->
      <div class="items-cards">
        <div v-for="(it, i) in form.items" :key="it._k" class="icard">
          <div class="icard-top"><b>第 {{ i + 1 }} 项</b><el-button link type="danger" size="small" :disabled="form.items.length <= 1" @click="form.items.splice(i, 1)">删除</el-button></div>
          <el-input v-model="it.name" size="small" placeholder="物料/道具名称（必填）" maxlength="60" />
          <div class="icard-grid">
            <el-input v-model="it.spec" size="small" placeholder="规格型号" maxlength="40" />
            <el-input-number v-model="it.qty" :min="0.01" :precision="2" :controls="false" size="small" class="num" placeholder="数量" />
            <el-input-number v-model="it.unit_price" :min="0" :precision="2" :controls="false" size="small" class="num" placeholder="单价" />
          </div>
          <el-input v-model="it.link" size="small" placeholder="购买链接 https://…" />
          <div class="icard-shot">
            <img v-if="shotUrl(it)" :src="shotUrl(it)" alt="" @click="previewShot(it)" />
            <el-button size="small" @click="pickShot(i)">{{ shotUrl(it) || it.pendingShot ? '替换截图' : '＋ 购买截图（可选）' }}</el-button>
            <el-button v-if="shotUrl(it) || it.pendingShot" size="small" type="danger" plain @click="removeShot(it)">删除截图</el-button>
            <span class="amt-chip">金额 ¥{{ amountOf(it).toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <div class="total-line">
        <b>合计：¥ {{ totalAmount.toFixed(2) }}</b>
      </div>

      <el-form-item label="备注（选填）" class="remark-item">
        <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="300" show-word-limit placeholder="用途说明、紧急程度等" />
      </el-form-item>
    </el-form>

    <!-- 每行截图的隐藏原生 input（全站不用 el-upload） -->
    <input ref="shotInput" type="file" accept="image/*" hidden @change="onShotPicked" />

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">{{ saving ? '提交中…' : '提交申请' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { openImage } from '../../utils/imageViewer.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  events: { type: Array, default: () => [] },
  detail: { type: Object, default: null }, // 传入 = 编辑（pending/rejected）
});
const emit = defineEmits(['update:modelValue', 'saved']);

const isEdit = computed(() => !!props.detail);
const bomInput = ref(null);
const shotInput = ref(null);
const bomLoading = ref(false);
const bomWarnings = ref([]);
const saving = ref(false);
const shotPickIdx = ref(-1);

let _kSeq = 0;
const blankRow = () => ({ _k: ++_kSeq, id: null, name: '', spec: '', qty: 1, unit_price: 0, link: '', shot: null, pendingShot: null, pendingUrl: '' });
const form = reactive({ event_id: null, remark: '', items: [blankRow()] });

const amountOf = (it) => Math.round((Number(it.qty) || 0) * (Number(it.unit_price) || 0) * 100) / 100;
const totalAmount = computed(() => Math.round(form.items.reduce((s, it) => s + amountOf(it), 0) * 100) / 100);
function addRow() { form.items.push(blankRow()); }

// 已落库截图的 blob 预览缓存（token 不进 URL，走 blob）；需 reactive 才能在拉取完成后触发重渲染
const shotBlobUrls = reactive(new Map()); // item _k → url
function shotUrl(it) {
  if (it.pendingUrl) return it.pendingUrl;
  if (it.shot) {
    if (!shotBlobUrls.has(it._k)) {
      const fid = it.shot.id;
      api.purchaseFileBlob(fid).then((blob) => shotBlobUrls.set(it._k, URL.createObjectURL(blob))).catch(() => {});
      return '';
    }
    return shotBlobUrls.get(it._k);
  }
  return '';
}
function pickShot(i) {
  shotPickIdx.value = i;
  shotInput.value?.click();
}
function onShotPicked(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!/^image\//.test(file.type)) return ElMessage.error('购买截图仅支持图片（jpg/png/webp/gif/bmp）');
  if (file.size > 25 * 1024 * 1024) return ElMessage.error('图片过大（单文件 ≤25MB）');
  const it = form.items[shotPickIdx.value];
  if (!it) return;
  if (it.pendingUrl) URL.revokeObjectURL(it.pendingUrl);
  it.pendingShot = file;
  it.pendingUrl = URL.createObjectURL(file);
}
function removeShot(it) {
  if (it.pendingShot) {
    it.pendingShot = null;
    if (it.pendingUrl) { URL.revokeObjectURL(it.pendingUrl); it.pendingUrl = ''; }
  } else if (it.shot?.id) {
    // 编辑态：旧截图立即删（服务端替换语义是重传覆盖，删除走 DELETE）
    api.purchaseFileDelete(it.shot.id).then(() => {
      it.shot = null;
      ElMessage.success('旧截图已删除');
    }).catch((err) => ElMessage.error(err.message));
  }
}
function previewShot(it) {
  const url = shotUrl(it);
  if (url) openImage(url, it.name || '购买截图');
}

// BOM 识别 → 追加行（用户可继续改；识别只预填不落库）
async function onBom(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  bomLoading.value = true;
  bomWarnings.value = [];
  try {
    const out = await api.purchaseRecognizeBom(file);
    const rows = out.items || [];
    if (!rows.length) {
      ElMessage.warning('没有从文件中识别出确定的物料行，请手工填写或换更清晰的文件');
    } else {
      for (const r of rows) form.items.push({ ...blankRow(), name: r.name, spec: r.spec || '', qty: r.qty || 1, unit_price: r.unit_price || 0 });
      ElMessage.success(`已识别并追加 ${rows.length} 行物料，请核对`);
    }
    bomWarnings.value = out.warnings || [];
    await nextTick();
  } catch (err) {
    ElMessage.error(err.message + (err.hint ? `（${err.hint}）` : ''));
  } finally {
    bomLoading.value = false;
  }
}

function validate() {
  if (!form.event_id) return '请选择比赛 / 项目档案';
  if (!form.items.length) return '至少填写一条物料明细';
  for (let i = 0; i < form.items.length; i++) {
    const it = form.items[i];
    if (!String(it.name || '').trim()) return `第 ${i + 1} 行物料名称不能为空`;
    if (!(Number(it.qty) > 0)) return `第 ${i + 1} 行数量必须大于 0`;
    if (Number(it.unit_price) < 0) return `第 ${i + 1} 行单价不正确`;
    if (it.link && !/^https?:\/\//i.test(it.link)) return `第 ${i + 1} 行购买链接需以 http:// 或 https:// 开头`;
  }
  return '';
}

async function submit() {
  const errMsg = validate();
  if (errMsg) return ElMessage.warning(errMsg);
  const payload = {
    event_id: form.event_id,
    remark: form.remark,
    items: form.items.map((it) => ({
      // 带 id 的旧行：服务端保留其已传截图；新行不传 id
      ...(it.id ? { id: it.id } : {}),
      name: String(it.name).trim(), spec: String(it.spec || '').trim(),
      qty: Number(it.qty), unit_price: Number(it.unit_price), link: String(it.link || '').trim(),
    })),
  };
  saving.value = true;
  try {
    const saved = isEdit.value
      ? await api.purchaseRequestUpdate(props.detail.id, payload)
      : await api.purchaseRequestCreate(payload);
    // 行已落库 → 按顺序补传每行的新截图（重传=替换）
    const pending = form.items.filter((it) => it.pendingShot);
    if (pending.length) {
      await Promise.all(pending.map(async (it) => {
        const idx = form.items.indexOf(it);
        const savedItem = saved.detail.items[idx];
        if (savedItem) await api.purchaseShotUpload(saved.detail.id, savedItem.id, it.pendingShot);
      }));
    }
    ElMessage.success(isEdit.value
      ? (props.detail.status === 'rejected' ? '已重新提交，等待审批' : '申请已更新')
      : '申请已提交，等待审批');
    emit('saved', saved.detail);
    emit('update:modelValue', false);
  } catch (e) {
    ElMessage.error(e.message + (e.hint ? `（${e.hint}）` : ''));
  } finally {
    saving.value = false;
  }
}

// 编辑：用详情预填（旧截图不立即拉 blob，进入视区再懒加载）
watch(() => props.modelValue, (open) => {
  if (!open) return;
  bomWarnings.value = [];
  if (props.detail) {
    form.event_id = props.detail.event_id;
    form.remark = props.detail.remark || '';
    form.items = props.detail.items.map((it) => ({
      _k: ++_kSeq, id: it.id, name: it.name, spec: it.spec || '',
      qty: it.qty, unit_price: it.unit_price, link: it.link || '', shot: it.shot, pendingShot: null, pendingUrl: '',
    }));
  } else {
    form.event_id = props.events.find((e) => e.status === 'open')?.id || null;
    form.remark = '';
    form.items = [blankRow()];
  }
});

function onClosed() {
  for (const u of shotBlobUrls.values()) URL.revokeObjectURL(u);
  shotBlobUrls.clear();
  for (const it of form.items) if (it.pendingUrl) URL.revokeObjectURL(it.pendingUrl);
}
</script>

<style scoped>
.pf .ev-select { width: 100%; }
.opt-closed { float: right; color: var(--text-3); font-size: 12px; }
.items-head { display: flex; align-items: center; gap: 8px; margin: 4px 0 10px; flex-wrap: wrap; }
.items-head b { font-size: 14px; }
.items-head .hint { color: var(--text-3); font-size: 12px; }
.items-head .spacer { flex: 1; }
.bom-w { margin-bottom: 8px; }
.items-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.items-table th { text-align: left; color: var(--text-2); font-weight: 600; padding: 6px 8px; background: var(--surface-1); border: 1px solid var(--border); white-space: nowrap; }
.items-table td { border: 1px solid var(--border); padding: 4px 6px; vertical-align: middle; }
.items-table .num { width: 86px; }
.items-table :deep(.el-input-number) { width: 100%; }
.items-table .amt { font-variant-numeric: tabular-nums; color: var(--primary); font-weight: 600; white-space: nowrap; }
.c-name { min-width: 150px; }
.c-spec { width: 120px; }
.c-qty, .c-price { width: 92px; }
.c-amt { width: 80px; }
.c-link { min-width: 130px; }
.c-shot { width: 128px; }
.shot-cell { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.shot-cell img { width: 42px; height: 42px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in; }
.total-line { text-align: right; margin: 12px 2px; font-size: 15px; }
.total-line b { color: var(--primary); }
.items-cards { display: none; }
.icard { border: 1px solid var(--border); border-radius: 10px; padding: 10px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; }
.icard-top { display: flex; justify-content: space-between; align-items: center; }
.icard-grid { display: grid; grid-template-columns: 1fr 90px 100px; gap: 6px; }
.icard-grid :deep(.el-input-number) { width: 100%; }
.icard-shot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.icard-shot img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); cursor: zoom-in; }
.amt-chip { margin-left: auto; color: var(--primary); font-weight: 600; }
@media (max-width: 768px) {
  .items-table { display: none; }
  .items-cards { display: block; }
}
</style>
