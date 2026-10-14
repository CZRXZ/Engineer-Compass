<script setup>
// 密码卡：初始密码态红标提醒；改密支持「邮箱验证码」（默认）与「旧密码」两路。
// 成功后用响应 user 整体 patchUser（password_set 翻 1，App.vue 横幅与本卡同时更新）。
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth, { patchUser } from '../../auth.js';

const dlg = ref(false);
const mode = ref('code'); // code=邮箱验证码 / old=旧密码
const code = ref('');
const oldPw = ref('');
const newPw = ref('');
const confirmPw = ref('');
const sending = ref(false);
const saving = ref(false);
const countdown = ref(0);
let timer = null;

const initial = computed(() => auth.user?.password_set === false);
const email = computed(() => auth.user?.email || '');

defineExpose({ open }); // 页面顶部「立即修改」提醒条直接开弹窗

function open() {
  mode.value = email.value ? 'code' : 'old'; // 没绑邮箱只能走旧密码
  code.value = ''; oldPw.value = ''; newPw.value = ''; confirmPw.value = '';
  dlg.value = true;
}
async function sendCode() {
  if (!email.value) return ElMessage.warning('账号尚未绑定邮箱，请用「旧密码」方式');
  sending.value = true;
  try {
    const r = await api.sendCode(email.value, 'reset');
    if (r.dev_code) {
      code.value = r.dev_code;
      ElMessage.success(`开发模式验证码：${r.dev_code}（配置 SMTP 后改为邮件发送）`);
    } else {
      ElMessage.success('验证码已发送到绑定邮箱，10 分钟内有效');
    }
    countdown.value = 60;
    timer = setInterval(() => { if (--countdown.value <= 0) { clearInterval(timer); timer = null; } }, 1000);
  } catch (e) { ElMessage.error(e.message); }
  finally { sending.value = false; }
}
async function save() {
  if (newPw.value.length < 6 || newPw.value.length > 64) return ElMessage.warning('新密码长度需 6-64 位');
  if (newPw.value !== confirmPw.value) return ElMessage.warning('两次输入的新密码不一致');
  const body = { new_password: newPw.value };
  if (mode.value === 'code') {
    if (!/^\d{6}$/.test(code.value.trim())) return ElMessage.warning('请输入 6 位邮箱验证码');
    body.code = code.value.trim();
  } else {
    if (!oldPw.value) return ElMessage.warning('请输入旧密码');
    body.old_password = oldPw.value;
  }
  saving.value = true;
  try {
    const r = await api.changePassword(body);
    patchUser(r.user);
    dlg.value = false;
    ElMessage.success('密码修改成功');
  } catch (e) { ElMessage.error(e.message); }
  finally { saving.value = false; }
}
</script>

<template>
  <section class="ac-card">
    <div class="ac-head">
      <span class="ac-icon">🔑</span>
      <div class="ac-titles">
        <h3>登录密码
          <el-tag v-if="initial" size="small" type="danger" effect="dark" style="margin-left:8px">初始密码待修改</el-tag>
          <el-tag v-else size="small" type="success" plain style="margin-left:8px">已设置</el-tag>
        </h3>
        <p class="ac-desc">
          <template v-if="initial">系统已为你设置统一初始密码，请尽快修改为本人密码，保障账号安全。</template>
          <template v-else>定期修改密码可以让账号更安全。</template>
        </p>
      </div>
      <el-button :type="initial ? 'danger' : 'primary'" plain @click="open">修改密码</el-button>
    </div>

    <el-dialog v-model="dlg" title="修改密码" width="440px" destroy-on-close @closed="countdown = 0">
      <el-radio-group v-model="mode" class="pw-mode" :disabled="!email">
        <el-radio-button value="code">📧 邮箱验证码</el-radio-button>
        <el-radio-button value="old">旧密码验证</el-radio-button>
      </el-radio-group>
      <el-alert v-if="!email" type="warning" :closable="false" show-icon style="margin:10px 0"
        title="当前账号未绑定邮箱，只能用旧密码方式修改；修改后可在「邮箱」卡片绑定邮箱。" />
      <el-form label-position="top" @submit.prevent>
        <el-form-item v-if="mode === 'code'" label="验证码（发送到绑定邮箱）">
          <div class="code-row">
            <el-input v-model="code" maxlength="6" placeholder="6 位验证码" />
            <el-button :disabled="countdown > 0" :loading="sending" @click="sendCode" style="width:130px;flex-shrink:0">
              {{ countdown > 0 ? `${countdown}s 后重发` : '发送验证码' }}
            </el-button>
          </div>
        </el-form-item>
        <el-form-item v-else label="旧密码">
          <el-input v-model="oldPw" type="password" show-password placeholder="输入当前使用的密码" />
        </el-form-item>
        <el-form-item label="新密码（6-64 位）">
          <el-input v-model="newPw" type="password" show-password placeholder="新密码" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="confirmPw" type="password" show-password placeholder="再输一次新密码" @keyup.enter="save" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">确认修改</el-button>
      </template>
    </el-dialog>
  </section>
</template>
