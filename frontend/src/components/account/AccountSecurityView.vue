<script setup>
// 账号安全中心：密码 / 邮箱 / 手机号 / 飞书 / GitHub 五张卡。
// 入口在「我的」页，与「退出登录」同级；未登录直接内嵌登录卡（同我的页口径）。
import { ref } from 'vue';
import auth from '../../auth.js';
import AuthView from '../AuthView.vue';
import PasswordCard from './PasswordCard.vue';
import EmailCard from './EmailCard.vue';
import PhoneCard from './PhoneCard.vue';
import BindOauthCard from './BindOauthCard.vue';

const pwCard = ref(null);
</script>

<template>
  <AuthView v-if="!auth.token" />

  <main v-else class="ac-page">
    <div class="ac-top">
      <router-link to="/me" class="ac-back">← 返回我的</router-link>
      <h2>🔐 账号安全</h2>
      <p>管理登录密码、邮箱、手机号与第三方账号绑定。</p>
    </div>

    <el-alert
      v-if="auth.user?.password_set === false"
      type="warning" show-icon :closable="false" class="ac-banner"
      title="你的账号当前使用系统初始密码，请尽快修改为本人密码。">
      <template #default>
        初始密码为系统统一发放，建议立即通过邮箱验证码修改。
        <el-button type="warning" size="small" style="margin-left:8px" @click="pwCard?.open()">立即修改</el-button>
      </template>
    </el-alert>

    <div class="ac-list">
      <PasswordCard ref="pwCard" />
      <EmailCard />
      <PhoneCard />
      <BindOauthCard platform="feishu" />
      <BindOauthCard platform="github" />
    </div>
  </main>
</template>

<style scoped>
.ac-page { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
.ac-top { margin-bottom: 16px; }
.ac-back { color: var(--text-2); font-size: 13px; text-decoration: none; }
.ac-back:hover { color: var(--primary); }
.ac-top h2 { margin: 8px 0 4px; font-size: 22px; }
.ac-top p { margin: 0; color: var(--text-2); font-size: 13px; }
.ac-banner { margin-bottom: 16px; }
.ac-list { display: flex; flex-direction: column; gap: 14px; }
@media (max-width: 768px) {
  .ac-page { padding: 16px 12px 48px; }
}
</style>

<!-- 五张卡共用的卡片样式（.ac- 前缀，全局但不污染其他页面） -->
<style>
.ac-card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 20px;
  box-shadow: 0 1px 3px rgba(15, 23, 42, .05);
}
.ac-head { display: flex; align-items: center; gap: 14px; }
.ac-icon { font-size: 26px; flex-shrink: 0; width: 40px; text-align: center; }
.ac-titles { flex: 1; min-width: 0; }
.ac-titles h3 { margin: 0 0 4px; font-size: 15px; display: flex; align-items: center; }
.ac-desc { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.5; word-break: break-all; }
.ac-desc.mono { font-variant-numeric: tabular-nums; }
.ac-actions { display: flex; gap: 8px; flex-shrink: 0; }
.code-row { display: flex; gap: 8px; width: 100%; }
.oauth-bound { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.oauth-info { display: flex; flex-direction: column; gap: 2px; }
.oauth-link { font-size: 12px; color: var(--primary); text-decoration: none; }
.ac-formtip { color: var(--text-3); font-size: 12px; margin: 8px 0 0; }
.pw-mode { margin-bottom: 4px; }
@media (max-width: 560px) {
  .ac-card { padding: 14px; }
  .ac-head { flex-wrap: wrap; }
  .ac-actions { width: 100%; justify-content: flex-end; }
}
</style>
