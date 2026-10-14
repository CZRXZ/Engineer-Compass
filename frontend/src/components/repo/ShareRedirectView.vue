<script setup>
// /share/:id 旧数字路由兼容层：按 id 取项目后静默 replace 到 /:username/:slug。
// 不渲染项目本身（避免与 ProjectView 两份实现漂移）；replace 而非 push，
// 浏览器后退不会在这个中转页停留。消息通知、收藏、历史书签都走这条无感迁移链。
import { ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../../api.js';
import GhIcon from '../share/GhIcon.vue';

const route = useRoute();
const router = useRouter();
const errMsg = ref('');

async function resolve() {
  errMsg.value = '';
  const id = Number(route.params.id);
  if (!id) { errMsg.value = '项目不存在'; return; }
  try {
    const p = await api.sharePost(id);
    if (p.username && p.slug) {
      router.replace(`/${encodeURIComponent(p.username)}/${encodeURIComponent(p.slug)}`);
    } else {
      errMsg.value = '项目不存在'; // 理论不可达：详情 payload 恒带 username/slug
    }
  } catch (e) {
    errMsg.value = e.message; // 已删 / 私密无权：后端统一 404 文案
  }
}
watch(() => route.params.id, resolve);
onMounted(resolve);
</script>

<template>
  <main class="sr-page" v-loading="!errMsg" element-loading-text="正在打开项目…">
    <div v-if="errMsg" class="sr-err">
      <GhIcon name="book" :size="28" />
      <p>{{ errMsg }}</p>
      <router-link class="sr-btn" to="/share">返回开源大厅</router-link>
    </div>
  </main>
</template>

<style scoped>
.sr-page { min-height: 300px; max-width: 1180px; margin: 0 auto; padding: 24px; }
.sr-err {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 80px 20px; color: var(--text-3); font-size: 14px;
  p { margin: 0; }
}
.sr-btn {
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--primary);
  border-radius: 8px; padding: 6px 16px; font-size: 13px; text-decoration: none;
  &:hover { border-color: var(--primary); }
}
</style>
