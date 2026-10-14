<script setup>
// 第三方账号 OAuth 绑定卡（飞书 / GitHub 通用）：弹窗授权 → 回调页 postMessage → 自动刷新状态。
// env 未配置时 status.configured=false：按钮置灰并说明需管理员配置 OAuth 应用。
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';

const props = defineProps({
  platform: { type: String, required: true }, // 'feishu' | 'github'
});

const CONF = {
  feishu: {
    icon: '🪶', title: '飞书账号', msgType: 'feishu-bound',
    tip: '绑定后，日程笔记 / 进度汇报 / 分享帖可直接在飞书文档里编辑，资源分享可从飞书引出链接。',
    nameField: 'user_name', nameFallback: '飞书用户', configHint: '站点尚未配置飞书应用（FEISHU_APP_ID / SECRET）',
    status: () => api.feishuStatus(), auth: () => api.feishuAuth(), unbind: () => api.feishuUnbind(),
  },
  github: {
    icon: '🐙', title: 'GitHub 账号', msgType: 'github-bound',
    tip: '绑定 GitHub 账号，用于项目作者身份展示（本期仅做账号关联）。',
    nameField: 'login', nameFallback: 'GitHub 用户', configHint: '站点尚未配置 GitHub OAuth（GITHUB_CLIENT_ID / SECRET）',
    status: () => api.githubStatus(), auth: () => api.githubAuth(), unbind: () => api.githubUnbind(),
  },
}[props.platform] || {};

const st = ref({ configured: false, bound: false, loading: false });
const listener = (e) => {
  if (e.data?.type === CONF.msgType) {
    ElMessage.success(`✅ ${CONF.title}绑定成功`);
    load();
  }
};
async function load() {
  try { st.value = { ...(await CONF.status()), loading: false }; }
  catch { st.value = { configured: false, bound: false, loading: false }; }
}
async function bind() {
  st.value.loading = true;
  try {
    const { url } = await CONF.auth();
    if (!url) throw new Error('授权地址获取失败');
    window.open(url, '_blank', 'width=720,height=640'); // 不用 noopener：回调页要 postMessage
  } catch (e) {
    ElMessage.error(e.message);
    st.value.loading = false;
  }
}
async function unbind() {
  await ElMessageBox.confirm(`解绑后本账号将解除与${CONF.title}的关联，确定解绑？`, `解绑${CONF.title}`, { type: 'warning' });
  st.value.loading = true;
  try {
    await CONF.unbind();
    ElMessage.success('已解绑');
  } finally {
    st.value.loading = false;
    load();
  }
}
onMounted(() => { window.addEventListener('message', listener); load(); });
onBeforeUnmount(() => window.removeEventListener('message', listener));
</script>

<template>
  <section class="ac-card">
    <div class="ac-head">
      <span class="ac-icon">{{ CONF.icon }}</span>
      <div class="ac-titles">
        <h3>{{ CONF.title }}
          <el-tag size="small" :type="st.bound ? 'success' : 'info'" plain style="margin-left:8px">
            {{ st.bound ? '已绑定' : '未绑定' }}
          </el-tag>
        </h3>
        <p class="ac-desc">{{ CONF.tip }}</p>
        <div v-if="st.bound" class="oauth-bound">
          <el-avatar :src="st.avatar_url" :size="36" style="flex-shrink:0">
            {{ st[CONF.nameField]?.[0] || '🔗' }}
          </el-avatar>
          <div class="oauth-info">
            <b>{{ st[CONF.nameField] || CONF.nameFallback }}</b>
            <a v-if="st.profile_url" :href="st.profile_url" target="_blank" rel="noopener" class="oauth-link">
              查看账号主页 ↗
            </a>
          </div>
        </div>
      </div>
      <div class="ac-actions">
        <template v-if="st.bound">
          <el-button type="success" plain @click="load">🔄 刷新</el-button>
          <el-button type="danger" plain :loading="st.loading" @click="unbind">解绑</el-button>
        </template>
        <el-tooltip v-else :content="CONF.configHint" :disabled="st.configured" placement="top">
          <el-button type="primary" plain :loading="st.loading" :disabled="!st.configured" @click="bind">
            {{ st.configured ? '🔗 去绑定' : '未配置' }}
          </el-button>
        </el-tooltip>
      </div>
    </div>
  </section>
</template>
