<script setup>
// HTML 文件全屏预览页（/share/html/:fid?n=文件名[&source=gitee]）
// 「新窗口打开」落地页：不带站点导航，iframe 铺满视口。安全口径与 ShareFilePreview 完全一致——
// 字节走带 Authorization 头的 api.shareFileBlob → 强制 text/html 的 blob objectURL，
// iframe sandbox 无 allow-same-origin（opaque origin），脚本可跑但碰不到本站身份。
// **绝不能改成 window.open(blobUrl)**：父页上下文创建的 blob: 在本站源下导航 = 以本站源执行任意脚本。
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import GhIcon from './GhIcon.vue';

const route = useRoute();
const fid = Number(route.params.fid);
const fileName = route.query.n || '网页预览';
const isGitee = route.query.source === 'gitee';

const blobUrl = ref('');
const err = ref('');
const busy = ref(true);

async function load() {
  const b = await api.shareFileBlob(fid, { raw: isGitee });
  const typed = b.type === 'text/html' ? b : new Blob([b], { type: 'text/html' });
  blobUrl.value = URL.createObjectURL(typed);
}

async function download() {
  try {
    const b = await api.shareFileBlob(fid, { dl: true, raw: isGitee });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  } catch (e) { ElMessage.error(e.message); }
}

onMounted(async () => {
  document.title = fileName;
  try { await load(); } catch (e) { err.value = e.message; } finally { busy.value = false; }
});
onBeforeUnmount(() => { if (blobUrl.value) URL.revokeObjectURL(blobUrl.value); });
</script>

<template>
  <div v-loading="busy" class="hf-page">
    <div class="hf-bar">
      <GhIcon name="file" :size="14" />
      <span class="hf-name" :title="fileName">{{ fileName }}</span>
      <span class="hf-safe">沙箱隔离预览 · 页面脚本无法访问本站账号</span>
      <button class="hf-btn" @click="download"><GhIcon name="download" :size="14" /> 下载</button>
    </div>
    <p v-if="err" class="hf-err">{{ err }}</p>
    <iframe v-else-if="blobUrl" :src="blobUrl" class="hf-frame"
      sandbox="allow-scripts allow-popups allow-forms" referrerpolicy="no-referrer" :title="fileName"></iframe>
  </div>
</template>

<style lang="scss" scoped>
.hf-page { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg-2, #f6f8fa); z-index: 100; }
.hf-bar {
  flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 14px;
  background: var(--surface-1, #fff); border-bottom: 1px solid var(--border-2, #d9dee3);
  font-size: 12.5px; color: var(--text-2);
}
.hf-name { font-weight: 600; color: var(--text); max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-safe { color: var(--text-3); }
.hf-btn {
  margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--border-2, #d9dee3); background: var(--surface-1, #fff); color: var(--text-2);
  border-radius: 6px; padding: 3px 10px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  &:hover { border-color: var(--primary, #2563eb); color: var(--primary, #2563eb); }
}
.hf-frame { flex: 1; width: 100%; border: 0; background: #fff; }
.hf-err { margin: 40px auto; font-size: 14px; color: var(--danger-fg, #d1242f); }
</style>
