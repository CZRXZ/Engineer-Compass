<script setup>
// 邮箱卡：绑定 / 更换邮箱（新邮箱验证码，purpose=bind）。从「我的」页迁入，逻辑不重写。
import { ref, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth, { patchUser } from '../../auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dlg = ref(false);
const mail = ref('');
const code = ref('');
const sending = ref(false);
const saving = ref(false);
const countdown = ref(0);
let timer = null;

function open() {
  mail.value = auth.user?.email || '';
  code.value = '';
  dlg.value = true;
}
async function sendCode() {
  if (!EMAIL_RE.test(mail.value.trim())) return ElMessage.warning('请输入正确的邮箱地址');
  sending.value = true;
  try {
    const r = await api.sendCode(mail.value.trim(), 'bind');
    if (r.dev_code) {
      code.value = r.dev_code;
      ElMessage.success(`开发模式验证码：${r.dev_code}（配置 SMTP 后改为邮件发送）`);
    } else {
      ElMessage.success('验证码已发送到新邮箱，10 分钟内有效');
    }
    countdown.value = 60;
    timer = setInterval(() => { if (--countdown.value <= 0) { clearInterval(timer); timer = null; } }, 1000);
  } catch (e) { ElMessage.error(e.message); }
  finally { sending.value = false; }
}
async function save() {
  const m = mail.value.trim();
  if (!EMAIL_RE.test(m)) return ElMessage.warning('请输入正确的邮箱地址');
  if (!/^\d{6}$/.test(code.value.trim())) return ElMessage.warning('请输入 6 位数字验证码');
  saving.value = true;
  try {
    const r = await api.bindEmail({ email: m, code: code.value.trim() });
    patchUser(r.user);
    dlg.value = false;
    ElMessage.success('邮箱已更新，下次可用新邮箱登录');
  } catch (e) { ElMessage.error(e.message); }
  finally { saving.value = false; }
}
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <section class="ac-card">
    <div class="ac-head">
      <span class="ac-icon">📧</span>
      <div class="ac-titles">
        <h3>邮箱绑定
          <el-tag :type="auth.user?.email ? 'success' : 'warning'" plain size="small" style="margin-left:8px">
            {{ auth.user?.email ? '已绑定' : '未绑定' }}
          </el-tag>
        </h3>
        <p class="ac-desc mono">{{ auth.user?.email || '绑定邮箱后可用于登录、接收验证码与找回密码' }}</p>
      </div>
      <el-button type="primary" plain @click="open">{{ auth.user?.email ? '更换邮箱' : '绑定邮箱' }}</el-button>
    </div>

    <el-dialog v-model="dlg" :title="auth.user?.email ? '更换邮箱' : '绑定邮箱'" width="440px" destroy-on-close>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="新邮箱（用于登录与接收验证码）">
          <el-input v-model="mail" placeholder="you@example.com" />
        </el-form-item>
        <el-form-item label="验证码">
          <div class="code-row">
            <el-input v-model="code" maxlength="6" placeholder="6 位验证码" />
            <el-button :disabled="countdown > 0" :loading="sending" @click="sendCode" style="width:130px;flex-shrink:0">
              {{ countdown > 0 ? `${countdown}s 后重发` : '发送验证码' }}
            </el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">确认{{ auth.user?.email ? '更换' : '绑定' }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>
