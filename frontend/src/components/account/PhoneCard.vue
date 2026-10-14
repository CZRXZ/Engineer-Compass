<script setup>
// 手机号卡：本期只做号段校验 + 存储（未接短信通道，保存后恒标「未验证」）；空串=解绑。
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import auth, { patchUser } from '../../auth.js';

const dlg = ref(false);
const phone = ref('');
const saving = ref(false);

function open() { phone.value = auth.user?.phone || ''; dlg.value = true; }
async function save() {
  const v = phone.value.trim();
  saving.value = true;
  try {
    const r = await api.setPhone(v);
    patchUser(r.user);
    dlg.value = false;
    ElMessage.success(v ? '手机号已保存（暂未验证）' : '已解绑手机号');
  } catch (e) { ElMessage.error(e.message); }
  finally { saving.value = false; }
}
async function unbind() {
  await ElMessageBox.confirm('确定解绑当前手机号？', '解绑手机号', { type: 'warning' });
  try {
    const r = await api.setPhone('');
    patchUser(r.user);
    phone.value = '';
    ElMessage.success('已解绑手机号');
  } catch (e) { if (e !== 'cancel') ElMessage.error(e.message); }
}
</script>

<template>
  <section class="ac-card">
    <div class="ac-head">
      <span class="ac-icon">📱</span>
      <div class="ac-titles">
        <h3>手机号
          <el-tag v-if="auth.user?.phone" size="small" type="info" plain style="margin-left:8px">未验证</el-tag>
          <el-tag v-else size="small" type="warning" plain style="margin-left:8px">未绑定</el-tag>
        </h3>
        <p class="ac-desc mono">{{ auth.user?.phone || '绑定 11 位大陆手机号，便于后续账号校验与通知（本期暂不支持短信验证）' }}</p>
      </div>
      <div class="ac-actions">
        <el-button v-if="auth.user?.phone" type="danger" plain @click="unbind">解绑</el-button>
        <el-button type="primary" plain @click="open">{{ auth.user?.phone ? '更换' : '绑定' }}</el-button>
      </div>
    </div>

    <el-dialog :title="auth.user?.phone ? '更换手机号' : '绑定手机号'" v-model="dlg" width="400px" destroy-on-close>
      <el-input v-model="phone" maxlength="11" placeholder="11 位大陆手机号，如 13800138000" @keyup.enter="save" />
      <p class="ac-formtip">本期仅做号段格式校验，保存后标记「未验证」；留空保存即解绑。</p>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
