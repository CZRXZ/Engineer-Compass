<template>
  <el-dialog :model-value="modelValue" @close="emit('close')" title="批量导入资源（类型表单）"
    width="720px" append-to-body destroy-on-close>
    <el-radio-group v-model="kind" class="ri-kind">
      <el-radio-button v-for="k in KINDS" :key="k.key" :value="k.key">{{ k.icon }} {{ k.label }}</el-radio-button>
    </el-radio-group>

    <div class="ri-actions">
      <el-button size="small" plain :loading="tplLoading" @click="downloadTpl">⬇️ 下载模板</el-button>
      <el-button size="small" type="primary" plain :loading="parsing" @click="pickFile">📂 选择表格（xlsx/xls/csv）</el-button>
      <span v-if="fileName" class="ri-file">已选：{{ fileName }}（{{ effectiveCount }} 条有效行）</span>
      <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" hidden @change="onFile" />
    </div>

    <el-alert v-if="warnings.length" class="ri-warn" type="warning" :closable="false" show-icon
      title="表格解析结果，请逐行核对后再导入">
      <ul class="ri-warn-list">
        <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
      </ul>
    </el-alert>

    <p class="ri-tip">
      当前录入 <b>{{ meta.label }}</b>：{{ meta.space ? '同一时段独占，按容量限人数' : '按数量库存共享' }}，每行一条，一次最多 200 行。<br />
      表格第一行为表头请勿删除；审批方式填「需审批」或「先到先得」，留空用项目默认；解析导入后仍可继续手工修改再提交。
    </p>

    <div class="ri-table-wrap">
      <table class="ri-table">
        <thead>
          <tr>
            <th style="width: 40px">#</th>
            <th>名称*</th>
            <th v-if="meta.space">位置</th>
            <th v-if="meta.space">容量*</th>
            <th v-if="meta.space">室内设备（逗号分隔）</th>
            <th v-if="!meta.space">规格</th>
            <th v-if="!meta.space">库存*</th>
            <th v-if="!meta.space">单位</th>
            <th v-if="!meta.space">位置</th>
            <th style="width: 48px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i">
            <td class="dim">{{ i + 1 }}</td>
            <td><el-input v-model="row.name" size="small" placeholder="资源名称" /></td>
            <template v-if="meta.space">
              <td><el-input v-model="row.location" size="small" placeholder="房间号" /></td>
              <td><el-input-number v-model="row.capacity" :min="1" :max="9999" size="small" controls-position="right" style="width: 100px" /></td>
              <td><el-input v-model="row.equipment_text" size="small" placeholder="投影仪, 白板" /></td>
            </template>
            <template v-else>
              <td><el-input v-model="row.spec" size="small" /></td>
              <td><el-input-number v-model="row.quantity" :min="1" :max="9999" size="small" controls-position="right" style="width: 100px" /></td>
              <td><el-input v-model="row.unit" size="small" maxlength="8" placeholder="件" style="width: 64px" /></td>
              <td><el-input v-model="row.location" size="small" /></td>
            </template>
            <td><el-button link type="danger" size="small" @click="rows.splice(i, 1)">删</el-button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <el-button size="small" plain style="margin-top: 8px" @click="addRow">＋ 加一行</el-button>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">导入 {{ effectiveCount }} 条</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { KINDS, KIND_MAP } from '../../utils/booking.js';

const props = defineProps({
  modelValue: Boolean,
  project: { type: Object, required: true },
});
const emit = defineEmits(['close', 'saved']);

const kind = ref('space');
const rows = ref([]);
const saving = ref(false);
const parsing = ref(false);
const tplLoading = ref(false);
const warnings = ref([]);
const fileName = ref('');
const fileInput = ref(null);
const meta = computed(() => KIND_MAP[kind.value]);
const effectiveCount = computed(() => rows.value.filter((r) => String(r.name || '').trim()).length);

const blankRow = () => (meta.value.space
  ? { name: '', location: '', capacity: 30, equipment_text: '' }
  : { name: '', spec: '', quantity: 1, unit: '', location: '' });
// 解析回来的数字是字符串；坏值（''/'abc'）回填 undefined，让用户在数字框里直接看到空并修正
const numOrUndef = (v) => {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
};
function addRow() {
  if (rows.value.length >= 200) return ElMessage.warning('一次最多 200 条');
  rows.value.push(blankRow());
}
// 打开弹窗或切换类型：重置录入（表格行按类型分列，混类型无意义）
watch(() => [props.modelValue, kind.value], ([open]) => {
  if (open) {
    rows.value = [blankRow(), blankRow(), blankRow()];
    warnings.value = [];
    fileName.value = '';
  }
});

function pickFile() {
  fileInput.value?.click();
}
async function onFile(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // 允许再次选择同一个文件
  if (!file) return;
  parsing.value = true;
  try {
    const d = await api.bookingResourceParseImport(props.project.id, kind.value, file);
    rows.value = d.items.map((it) => (meta.value.space
      ? { name: it.name, location: it.location || '', capacity: numOrUndef(it.capacity), equipment_text: (it.equipment || []).join('，') }
      : { name: it.name, spec: it.spec || '', quantity: numOrUndef(it.quantity), unit: it.unit || '', location: it.location || '' }));
    while (rows.value.length < 3) rows.value.push(blankRow());
    warnings.value = Array.isArray(d.warnings) ? d.warnings : [];
    fileName.value = file.name;
    if (!d.items.length) ElMessage.warning('表格里没有有效数据行，请核对后重试');
  } catch (err) {
    warnings.value = [];
    fileName.value = '';
    ElMessage.error(err.message);
  } finally {
    parsing.value = false;
  }
}
async function downloadTpl() {
  tplLoading.value = true;
  try {
    const { blob, name } = await api.bookingResourceTemplateBlob(props.project.id, kind.value);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    tplLoading.value = false;
  }
}

async function submit() {
  const items = rows.value
    .filter((r) => String(r.name || '').trim())
    .map((r) => ({
      kind: kind.value,
      name: String(r.name).trim(),
      location: r.location || '',
      approve_mode: props.project.default_approve_mode || 'approval',
      ...(meta.value.space
        ? { capacity: Number(r.capacity), equipment: String(r.equipment_text || '').split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean) }
        : { spec: r.spec || '', quantity: Number(r.quantity), unit: r.unit || '' }),
    }));
  if (!items.length) return ElMessage.warning('请至少填写一行有效数据');
  saving.value = true;
  try {
    const d = await api.bookingResourceBulk(props.project.id, items);
    ElMessage.success(d.message || `已导入 ${items.length} 条`);
    emit('saved');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.ri-kind { margin-bottom: 8px; }
.ri-actions { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ri-file { font-size: 12.5px; color: var(--text-3); }
.ri-warn { margin-bottom: 8px; }
.ri-warn-list { margin: 4px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7; }
.ri-tip { font-size: 12.5px; color: var(--text-3); margin: 4px 0 10px; }
.ri-table-wrap { overflow-x: auto; border: 1px solid var(--border-2); border-radius: 8px; }
.ri-table { width: 100%; border-collapse: collapse; min-width: 640px;
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--border-2); font-size: 12.5px; text-align: left; white-space: nowrap; }
  th { background: var(--bg-2, #f6f8fa); color: var(--text-3); font-weight: 500; }
}
</style>
