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
    // 飞书回调页 targetOrigin='*'（历史行为不动），这里不强制来源
    checkOrigin: false, errorType: '',
    status: () => api.feishuStatus(), auth: () => api.feishuAuth(), unbind: () => api.feishuUnbind(),
  },
  github: {
    icon: '🐙', title: 'GitHub 账号', msgType: 'github-bound',
    tip: '绑定后可用 GitHub 一键登录：已绑定直接登录；未绑定时按 GitHub 已验证邮箱自动匹配本站账号，匹配不到会自动创建新账号。',
    nameField: 'login', nameFallback: 'GitHub 用户', configHint: '站点尚未配置 GitHub OAuth（GITHUB_CLIENT_ID / SECRET）',
    // GitHub 回调页同源（dev 走 Vite 代理）：必须校验来源，拒绝外站 postMessage
    checkOrigin: true, errorType: 'github-oauth-error',
    status: () => api.githubStatus(), auth: () => api.githubAuth(), unbind: () => api.githubUnbind(),
  },
}[props.platform] || {};

const st = ref({ configured: false, bound: false, loading: false });
const loadFailed = ref(false); // status 拉取失败：显示「重试」，不伪装成「未配置」
let oauthWin = null;
let closeTimer = null;

function stopWinWatch() {
  if (closeTimer) { clearInterval(closeTimer); closeTimer = null; }
  oauthWin = null;
}

const listener = (e) => {
  // GitHub 只收同源消息；飞书维持历史口径不校验
  if (CONF.checkOrigin && e.origin !== location.origin) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === CONF.msgType) {
    stopWinWatch();
    st.value.loading = false;
    ElMessage.success(`✅ ${CONF.title}绑定成功`);
    load();
  } else if (CONF.errorType && d.type === CONF.errorType) {
    // 回调失败也要复位 loading，否则按钮永久转圈
    stopWinWatch();
    st.value.loading = false;
    ElMessage.error(d.message || `${CONF.title}绑定失败，请重试`);
  }
};
async function load() {
  try {
    st.value = { ...(await CONF.status()), loading: false };
    loadFailed.value = false;
  } catch {
    loadFailed.value = true;
    st.value.loading = false;
  }
}
async function bind() {
  st.value.loading = true;
  try {
    const { url } = await CONF.auth();
    if (!url) throw new Error('授权地址获取失败');
    oauthWin = window.open(url, '_blank', 'width=720,height=640'); // 不用 noopener：回调页要 postMessage
    if (!oauthWin) {
      st.value.loading = false;
      ElMessage.warning('浏览器拦截了弹窗，请允许本站弹出窗口后重试');
      return;
    }
    // 用户直接关窗 = 放弃绑定：轮询复位 loading
    closeTimer = setInterval(() => {
      if (oauthWin?.closed) { stopWinWatch(); st.value.loading = false; }
    }, 500);
  } catch (e) {
    ElMessage.error(e.message);
    st.value.loading = false;
  }
}
async function unbind() {
  // 取消确认是正常操作：单独吞掉，不留 loading 也不产生未处理拒绝
  try {
    await ElMessageBox.confirm(`解绑后本账号将解除与${CONF.title}的关联，确定解绑？`, `解绑${CONF.title}`, { type: 'warning' });
  } catch {
    return;
  }
  st.value.loading = true;
  try {
    await CONF.unbind();
    ElMessage.success('已解绑');
    await load();
  } catch (e) {
    st.value.loading = false;
    ElMessage.error(e.message || '解绑失败，请稍后重试');
  }
}
onMounted(() => { window.addEventListener('message', listener); load(); });
onBeforeUnmount(() => { window.removeEventListener('message', listener); stopWinWatch(); });
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
        <el-button v-if="loadFailed" plain @click="load">↻ 重试</el-button>
        <template v-else-if="st.bound">
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
