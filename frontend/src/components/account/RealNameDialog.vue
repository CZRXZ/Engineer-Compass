<script setup>
// 实名认证弹窗：closable=false 时为全局硬门禁（无 X、点遮罩/ESC 不关、无取消，只能填完提交）；
// 账号安全页以 closable=true 复用，可取消。校验与后端 PUT /auth/real-name 同口径。
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth, { patchUser } from '../../auth.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  closable: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'done']);

const name = ref('');
const err = ref('');
const saving = ref(false);

const REALNAME_RE = /^[一-龥A-Za-z][一-龥A-Za-z·•.\s]{0,18}[一-龥A-Za-z.]$/;
function norm(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ');
}
function validate(v) {
  const s = norm(v);
  const len = Array.from(s).length; // 按码点计，emoji 也算 1 个码点（后续白名单正则会拦）
  if (len < 2 || len > 20) return '姓名长度需为 2-20 个字符';
  if (!REALNAME_RE.test(s)) return '姓名仅支持汉字、英文字母、空格和间隔号（·）';
  if ((s.match(/[一-龥A-Za-z]/g) || []).length < 2) return '姓名不能为纯数字、纯符号或单字';
  return '';
}

watch(() => props.modelValue, (v) => {
  if (v) {
    name.value = auth.user?.real_name || '';
    err.value = '';
  }
});

function onInput() { if (err.value) err.value = validate(name.value); }
function requestClose() { if (props.closable) emit('update:modelValue', false); }

async function save() {
  const msg = validate(name.value);
  if (msg) { err.value = msg; return; }
  saving.value = true;
  try {
    const r = await api.setRealName(norm(name.value));
    patchUser(r.user);
    ElMessage.success('实名认证信息已保存');
    emit('update:modelValue', false);
    emit('done', r.user);
  } catch (e) {
    err.value = e.message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    title="请先完成实名认证"
    :model-value="modelValue"
    width="420px"
    :show-close="closable"
    :close-on-click-modal="closable"
    :close-on-press-escape="closable"
    :close-on-hash-change="false"
    @update:model-value="(v) => { if (!v) requestClose(); }"
    append-to-body
  >
    <p class="rn-intro">
      根据平台要求，所有账号必须先完成实名认证才能使用本站。你的真实姓名仅用于资源预约、经费报销、物料采购的署名与管理追责，不会公开展示到其他模块。
    </p>
    <el-input
      v-model="name"
      placeholder="请输入真实姓名，如：张三 / John Smith"
      maxlength="24"
      clearable
      @input="onInput"
      @keyup.enter="save"
    />
    <p v-if="err" class="rn-err">{{ err }}</p>
    <p v-else class="rn-tip">2-20 个字符，支持汉字、英文字母、空格与间隔号（·），不可为纯数字或符号。</p>
    <template #footer>
      <el-button v-if="closable" @click="requestClose()">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存并继续</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.rn-intro { margin: 0 0 12px; font-size: 13px; line-height: 1.7; color: var(--el-text-color-regular); }
.rn-tip { margin: 8px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.rn-err { margin: 8px 0 0; font-size: 12px; color: var(--el-color-danger); }
</style>
