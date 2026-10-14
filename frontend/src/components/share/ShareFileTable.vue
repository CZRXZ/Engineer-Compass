<script setup>
// 资源分享页的「文件列表」表格（GitHub 仓库页的文件表形态）
// 一行 = 一条帖子；行点击 = 跳该帖的详情子路由 /share/:id（选中态由 URL 承载，表格自己不持有）
// 点赞/收藏按钮保留内联可点（@click.stop 阻止冒泡到行跳转），行为与旧卡片流一致
import { computed } from 'vue';
import { cnt, postKind, KIND_ICON } from '../../utils/share.js';
import { fmtDateTime, fmtRelative } from '../../utils/time.js';
import GhIcon from './GhIcon.vue';

const props = defineProps({
  rows: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  emptyText: { type: String, default: '' }, // 由父层按 标签/幽灵页 分支算好传入
  // 「我的」视图：行内显示开源/私密开关（父层调 visibility 接口，失败自行回滚）
  withVisibility: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'like', 'fav', 'author', 'visibility']);

// 筛选框双向绑定（纯前端筛当前页，无后端搜索接口）
const filter = defineModel('filter', { type: String, default: '' });

// 只筛当前页 —— 后端无搜索接口，文案里也如实写「本页」
const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return props.rows;
  return props.rows.filter((p) =>
    String(p.title || '').toLowerCase().includes(q) ||
    String(p.nickname || '').toLowerCase().includes(q) ||
    (p.tags || []).some((t) => String(t).toLowerCase().includes(q)));
});

const stamp = (p) => p.update_time || p.create_time;
</script>

<template>
  <div class="gh-filebox">
    <!-- 筛选条（GitHub 的「Go to file」位置：我们只筛本页，故如实标注） -->
    <div class="gh-fhead">
      <span class="gh-search">
        <GhIcon name="search" :size="14" />
        <input v-model="filter" type="text" placeholder="筛选本页资源…" aria-label="筛选本页资源" />
        <button v-if="filter" class="gh-clear" title="清除筛选" @click="filter = ''">×</button>
      </span>
    </div>

    <!-- 表头 -->
    <div class="gh-thead" aria-hidden="true">
      <span class="c-name">名称</span>
      <span class="c-author">作者</span>
      <span class="c-acts">互动</span>
      <span class="c-time">更新时间</span>
    </div>

    <div v-loading="loading" class="gh-tbody">
      <div
        v-for="p in filtered" :key="p.id" class="gh-row"
        role="button" tabindex="0"
        @click="emit('select', p.id)" @keyup.enter="emit('select', p.id)"
      >
        <span class="c-name">
          <!-- 私密项目：仅作者本人「我的」视图能看到这把锁（后端已过滤他人视角） -->
          <span v-if="p.is_public === 0" class="gh-lock" title="私密项目（仅自己可见）">🔒</span>
          <GhIcon :name="KIND_ICON[postKind(p)]" :size="16" class="gh-ficon" />
          <span class="gh-fname" :title="p.title">{{ p.title }}</span>
          <!-- 项目制：有文件夹/仓库的帖子给个小标记，一眼知道点进去是目录树而不是一堆附件 -->
          <span v-if="p.gitee_repo" class="gh-fbadge gt" :title="`含 Gitee 仓库：${p.gitee_repo}`">
            <GhIcon name="repo" :size="12" /> {{ p.file_count || 0 }}
          </span>
          <span v-else-if="p.file_count" class="gh-fbadge" :title="`含项目文件夹：${p.file_count} 个文件`">
            <GhIcon name="file-directory-fill" :size="12" /> {{ p.file_count }}
          </span>
        </span>
        <span class="c-author" :title="p.nickname" @click.stop="emit('author', p)">{{ p.nickname }}</span>
        <span class="c-acts">
          <!-- 开源开关：@click.stop 防止冒泡到整行跳转；change 才发请求，父层失败回滚 -->
          <el-switch
            v-if="withVisibility" :model-value="p.is_public !== 0" size="small" inline-prompt
            active-text="🌍" inactive-text="🔒" class="gh-vis" title="切换开源 / 私密"
            @click.stop @change="emit('visibility', p, $event)"
          />
          <button class="gh-act" :class="{ on: p.is_liked }" title="点赞" @click.stop="emit('like', p)">👍 {{ cnt(p.like_count) }}</button>
          <button class="gh-act" :class="{ on: p.is_faved }" title="收藏" @click.stop="emit('fav', p)">⭐ {{ cnt(p.fav_count) }}</button>
          <span class="gh-act plain" title="评论">💬 {{ cnt(p.comment_count) }}</span>
        </span>
        <span class="c-time" :title="fmtDateTime(stamp(p))">{{ fmtRelative(stamp(p)) }}</span>
      </div>

      <!-- 空态：区分「本页无数据」与「筛选无命中」——后者给清除入口 -->
      <div v-if="!loading && !filtered.length" class="gh-empty">
        <template v-if="filter">
          <p>本页没有匹配「{{ filter }}」的资源</p>
          <button class="gh-empty-btn" @click="filter = ''">清除筛选</button>
        </template>
        <p v-else class="gh-empty-hint">{{ emptyText || '这一页还没有资源' }}</p>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.gh-filebox {
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--card-bg);
  overflow: hidden;
}

.gh-fhead { padding: 11px 16px; border-bottom: 1px solid var(--border); background: var(--surface-1); }
.gh-search {
  display: flex; align-items: center; gap: 6px;
  border: 1px solid var(--border-2); border-radius: 6px; background: var(--card-bg);
  padding: 4px 10px; color: var(--text-3);
  input {
    flex: 1; min-width: 0; border: 0; outline: none; background: transparent;
    color: var(--text); font-size: 13px; font-family: inherit;
    &::placeholder { color: var(--text-3); }
  }
  .gh-clear {
    border: 0; background: transparent; cursor: pointer; color: var(--text-3);
    font-size: 16px; line-height: 1; padding: 0 2px;
    &:hover { color: var(--text); }
  }
}

.gh-thead, .gh-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px 204px 100px;
  gap: 12px; align-items: center; padding: 0 18px;
}
.gh-thead {
  height: 42px; font-size: 12.5px; color: var(--text-2);
  background: var(--surface-1); border-bottom: 1px solid var(--border);
}
.gh-tbody { min-height: 120px; }

.gh-row {
  height: 54px; font-size: 14px; color: var(--text-2);
  border-bottom: 1px solid var(--border); cursor: pointer;
  &:last-of-type { border-bottom: 0; }
  &:hover { background: var(--surface-1); }
  &:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
  .c-name { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text); }
  .gh-lock { flex: none; font-size: 12px; }
  .gh-ficon { color: var(--text-3); }
  .gh-fbadge {
    flex: none; display: inline-flex; align-items: center; gap: 3px;
    font-size: 10.5px; padding: 0 6px; border-radius: 999px;
    color: var(--text-3); background: var(--surface-3); border: 1px solid var(--border);
    &.gt { color: var(--primary); background: var(--primary-tint); border-color: var(--border-2); }
  }
  .gh-fname {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    &:hover { color: var(--primary); text-decoration: underline; }
  }
  .c-author {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    cursor: pointer; &:hover { color: var(--primary); }
  }
  .c-time { text-align: right; color: var(--text-3); font-size: 12.5px; white-space: nowrap; }
  .c-acts { display: flex; gap: 8px; align-items: center; }
  // 开源开关内联文字（🌍/🔒）需要比默认 40px 略宽
  .gh-vis { flex: none; width: 52px; --el-switch-on-color: var(--success-fg, #16a34a); }
}

.gh-act {
  border: 0; background: transparent; padding: 0; cursor: default;
  font-size: 12.5px; color: var(--text-3); font-family: inherit;
  &.on { color: var(--primary); font-weight: 600; }
  &:not(.plain) { cursor: pointer; &:hover { color: var(--primary); } }
}

.gh-empty {
  padding: 30px 16px; text-align: center; color: var(--text-3); font-size: 13px;
  p { margin: 0 0 10px; }
  .gh-empty-hint { margin: 0; }
  .gh-empty-btn {
    border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text);
    border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer;
    &:hover { border-color: var(--primary); color: var(--primary); }
  }
}

// 窄屏：藏掉作者与互动列，名称独占（两栏布局也在此时折叠）
@media (max-width: 768px) {
  .gh-thead .c-author, .gh-thead .c-acts,
  .gh-row .c-author, .gh-row .c-acts { display: none; }
  .gh-thead, .gh-row { grid-template-columns: minmax(0, 1fr) 78px; }
}
</style>
