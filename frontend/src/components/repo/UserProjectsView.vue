<script setup>
// 用户项目主页（GitHub 风 /:username）：头像头 + 项目列表
// 数据来自 GET /share/u/:username —— 他人只见开源项目，本人含私密（带 🔒）。
// 用户不存在 / 幽灵账号对非授权访问者：后端统一 404 防探测，本页就渲染 404 态。
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../../api.js';
import auth from '../../auth.js';
import GhIcon from '../share/GhIcon.vue';
import { cnt, excerpt } from '../../utils/share.js';
import { fmtRelative } from '../../utils/time.js';

const route = useRoute();
const username = computed(() => String(route.params.username || ''));

const user = ref(null);
const projects = ref([]);
const loading = ref(false);
const errMsg = ref('');

const isSelf = computed(() => !!auth.user && auth.user.username === username.value);

async function load() {
  if (!username.value) return;
  loading.value = true;
  errMsg.value = '';
  user.value = null;
  projects.value = [];
  try {
    const d = await api.shareUser(username.value);
    user.value = d.user;
    projects.value = d.projects || [];
  } catch (e) {
    errMsg.value = e.message; // 统一「用户不存在」，不区分账号不存在与幽灵不可见
  } finally {
    loading.value = false;
  }
}

// /a → /b 同组件复用实例（动态路由同模式），必须 watch 参数重取
watch(username, load);
onMounted(load);

const projectHref = (p) => `/${encodeURIComponent(username.value)}/${encodeURIComponent(p.slug)}`;
</script>

<template>
  <main class="up-page" v-loading="loading">
    <!-- 返回大厅 -->
    <router-link class="up-back" to="/share">
      <GhIcon name="arrow-left" :size="14" /> 返回开源大厅
    </router-link>

    <!-- 404：用户不存在 / 无权看幽灵主页，文案一致防探测 -->
    <div v-if="errMsg" class="up-404">
      <GhIcon name="book" :size="28" />
      <p>{{ errMsg }}</p>
      <router-link class="up-btn" to="/share">去开源大厅看看</router-link>
    </div>

    <template v-else-if="user">
      <!-- GitHub profile 头：头像 + 昵称 + @username + 项目数 -->
      <header class="up-head">
        <div class="up-avatar">
          <img v-if="user.avatar" :src="user.avatar" alt="" />
          <span v-else>{{ (user.nickname || user.username || '?').charAt(0) }}</span>
        </div>
        <div class="up-id">
          <h2>{{ user.nickname || user.username }}</h2>
          <p class="up-handle">@{{ user.username }}</p>
        </div>
        <div class="up-count">
          <b>{{ projects.length }}</b> 个项目
        </div>
      </header>

      <!-- 项目列表（GitHub repositories 风） -->
      <section class="up-list">
        <article v-for="p in projects" :key="p.id" class="up-item">
          <div class="up-item-main">
            <router-link :to="projectHref(p)" class="up-name">
              <GhIcon name="repo" :size="16" />
              <span>{{ p.title }}</span>
              <span v-if="p.is_public === 0" class="up-private" title="私密项目（仅作者可见）">🔒 私密</span>
            </router-link>
            <p v-if="excerpt(p.content, 110)" class="up-desc">{{ excerpt(p.content, 110) }}</p>
            <div class="up-tags" v-if="p.tags?.length">
              <span v-for="t in p.tags" :key="t" class="up-topic">{{ t }}</span>
            </div>
          </div>
          <div class="up-item-meta">
            <span v-if="p.gitee_repo" class="up-stat"><GhIcon name="repo" :size="13" /> Gitee</span>
            <span v-if="p.file_count" class="up-stat">📦 {{ p.file_count }}</span>
            <span class="up-stat">👍 {{ cnt(p.like_count) }}</span>
            <span class="up-stat">⭐ {{ cnt(p.fav_count) }}</span>
            <span class="up-stat">💬 {{ cnt(p.comment_count) }}</span>
            <span class="up-time">{{ fmtRelative(p.update_time || p.create_time) }}</span>
          </div>
        </article>

        <div v-if="!loading && !projects.length" class="up-empty">
          <p>{{ isSelf ? '你还没有发布项目，去开源大厅开第一个楼' : '这个用户还没有公开项目' }}</p>
          <router-link v-if="isSelf" class="up-btn" to="/share">📝 去发布</router-link>
        </div>
      </section>
    </template>
  </main>
</template>

<style lang="scss" scoped>
.up-page { max-width: 900px; margin: 0 auto; padding: 20px 24px 60px; }

.up-back {
  display: inline-flex; align-items: center; gap: 5px; margin-bottom: 14px;
  font-size: 12.5px; color: var(--text-2); text-decoration: none;
  &:hover { color: var(--primary); }
}

.up-404, .up-empty {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 70px 20px; color: var(--text-3); font-size: 14px; text-align: center;
  p { margin: 0; }
}
.up-btn {
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--primary);
  border-radius: 8px; padding: 6px 16px; font-size: 13px; text-decoration: none;
  &:hover { border-color: var(--primary); }
}

// —— Profile 头 ——
.up-head {
  display: flex; align-items: center; gap: 16px;
  border: 1px solid var(--border-2); border-radius: 10px; background: var(--card-bg);
  padding: 18px 22px; margin-bottom: 18px;
}
.up-avatar {
  width: 64px; height: 64px; border-radius: 50%; flex: none; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: var(--primary); color: #fff; font-size: 26px; font-weight: 600;
  img { width: 100%; height: 100%; object-fit: cover; }
}
.up-id { flex: 1; min-width: 0;
  h2 { margin: 0 0 2px; font-size: 20px; color: var(--text); }
}
.up-handle { margin: 0; font-size: 13px; color: var(--text-3); }
.up-count {
  flex: none; font-size: 13px; color: var(--text-2);
  b { color: var(--text); font-size: 18px; margin-right: 3px; }
}

// —— 项目列表 ——
.up-list { display: flex; flex-direction: column; gap: 12px; }
.up-item {
  display: flex; justify-content: space-between; gap: 16px;
  border: 1px solid var(--border-2); border-radius: 10px; background: var(--card-bg);
  padding: 14px 18px; transition: border-color .15s;
  &:hover { border-color: var(--primary); }
}
.up-item-main { flex: 1; min-width: 0; }
.up-name {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--primary); font-size: 15px; font-weight: 600; text-decoration: none;
  &:hover { text-decoration: underline; }
}
.up-private {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 11px; font-weight: 400; color: var(--text-3);
  border: 1px solid var(--border-2); border-radius: 999px; padding: 0 7px;
}
.up-desc {
  margin: 6px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--text-2);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.up-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.up-topic {
  font-size: 11px; color: var(--primary); background: var(--primary-tint);
  border-radius: 999px; padding: 1px 9px;
}
.up-item-meta {
  flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
  font-size: 12px; color: var(--text-3); white-space: nowrap;
}
.up-stat { display: inline-flex; align-items: center; gap: 4px; }
.up-time { font-size: 11.5px; }

@media (max-width: 640px) {
  .up-page { padding: 14px 12px 48px; }
  .up-head { padding: 14px; gap: 12px; }
  .up-avatar { width: 48px; height: 48px; font-size: 20px; }
  .up-item { flex-direction: column; gap: 8px; }
  .up-item-meta { flex-direction: row; flex-wrap: wrap; align-items: center; }
}
</style>
