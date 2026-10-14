<script setup>
// 项目页（GitHub 风 /:username/:slug 及 /tree、/blob 子路由）
// 与旧 SharePostView 的根本区别：文件夹/文件状态全部由 URL 承载 ——
// F5 刷新、前进后退、外发链接都停在同一目录/文件；面包屑每段都是真实 router-link。
// 数据只取一次（watch username/slug 才重取），切目录/切文件只动路由不请求。
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { normAtts } from '../team/AttachmentList.vue';
import { buildTree, fmtSize, fileKind, KIND_ICON } from '../../utils/share.js';
import ShareReadme from '../share/ShareReadme.vue';
import SharePostDialog from '../share/SharePostDialog.vue';
import ShareFilePreview from '../share/ShareFilePreview.vue';
import GhIcon from '../share/GhIcon.vue';

const router = useRouter();
const route = useRoute();

const username = computed(() => String(route.params.username || ''));
const slug = computed(() => String(route.params.slug || ''));
const splatSegs = computed(() => {
  const m = route.params.pathMatch;
  if (Array.isArray(m)) return m.filter(Boolean);
  return m ? String(m).split('/').filter(Boolean) : [];
});
const splatPath = computed(() => splatSegs.value.join('/'));
const mode = computed(() => (route.name === 'project-blob' ? 'blob' : route.name === 'project-tree' ? 'tree' : 'root'));

const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');
const userHref = computed(() => `/${encodeURIComponent(username.value)}`);
const rootHref = computed(() => `${userHref.value}/${encodeURIComponent(slug.value)}`);

const cur = ref(null);
const loading = ref(false);
const errMsg = ref('');
const feishuUrl = ref('');
const feishuBusy = ref(false);
const commentSending = ref(false);
const tagList = ref([]);

const isMine = computed(() => !!cur.value && !!auth.user
  && (Number(cur.value.author_id) === Number(auth.user.id) || auth.user.is_admin));
const needLogin = () => {
  if (auth.token) return false;
  ElMessage.warning('请先登录');
  router.push(`/login?redirect=${encodeURIComponent(route.fullPath)}`);
  return true;
};

async function load() {
  if (!username.value || !slug.value) { errMsg.value = '项目不存在'; cur.value = null; return; }
  loading.value = true;
  errMsg.value = '';
  cur.value = null;
  feishuUrl.value = '';
  try {
    const d = await api.shareProject(username.value, slug.value);
    d.attachments = normAtts(d.attachments); // 唯一 normAtts 调用点
    cur.value = d;
    if (auth.token) {
      api.feishuBizStatus('share_post', d.id).then((s) => { if (s?.mapped) feishuUrl.value = s.doc_url; }).catch(() => {});
    }
  } catch (e) {
    errMsg.value = e.message; // 私密/删除/幽灵口径统一 404 文案
  } finally {
    loading.value = false;
  }
}
async function loadTags() {
  try { tagList.value = await api.shareTags(); } catch { /* 标签失败不阻塞 */ }
}

// 换项目才重取；只切 tree/blob 不重取（同一份 files 推导）
watch([username, slug], load);
onMounted(() => { load(); loadTags(); });

// —— 目录推导（buildTree：服务端不存目录行，目录全由 path 前缀推导）——
const tree = computed(() => buildTree(cur.value?.files || []));
function findNode(nodes, segs) {
  let level = nodes;
  let node = null;
  for (const seg of segs) {
    node = level.find((n) => n.dir && n.name === seg);
    if (!node) return null;
    level = node.children;
  }
  return node;
}
const folderNode = computed(() => (mode.value === 'tree' ? findNode(tree.value, splatSegs.value) : null));
// 当前目录条目：根 = 顶层；tree = 该目录；blob 视图不显示目录表
const entries = computed(() => {
  if (mode.value === 'tree') return folderNode.value?.children || [];
  if (mode.value === 'root') return tree.value;
  return [];
});
const currentFile = computed(() =>
  (mode.value === 'blob' ? (cur.value?.files || []).find((f) => f.path === splatPath.value) : null) || null);
// URL 指向了项目里不存在的目录/文件（旧链接、作者更新过文件夹）
const pathMissing = computed(() => {
  if (mode.value === 'tree') return splatSegs.value.length > 0 && !folderNode.value;
  if (mode.value === 'blob') return !currentFile.value;
  return false;
});

// 面包屑路径段：中间段是可点的 /tree 链接，最后一段（当前目录/文件名）不可点加粗
const crumbs = computed(() => splatSegs.value.map((seg, i) => {
  const prefix = splatSegs.value.slice(0, i + 1).join('/');
  const last = i === splatSegs.value.length - 1;
  // 中间段一律指 /tree（GitHub 口径：blob 视图面包屑里的上级目录点回目录页）
  return { seg, last, href: last ? '' : `${rootHref.value}/tree/${encPath(prefix)}` };
}));

function openNode(n) {
  router.push(n.dir
    ? `${rootHref.value}/tree/${encPath(n.path)}`
    : `${rootHref.value}/blob/${encPath(n.path)}`);
}
// 文件预览关闭 → 回到所在目录（根文件回项目根）
function closePreview() {
  if (splatSegs.value.length > 1) {
    const parent = splatSegs.value.slice(0, -1).join('/');
    router.push(`${rootHref.value}/tree/${encPath(parent)}`);
  } else {
    router.push(rootHref.value);
  }
}

// —— 互动（与旧详情页同口径，只写 cur 这一份）——
const applyActs = (patch) => { if (cur.value) Object.assign(cur.value, patch); };
async function toggleLike() {
  if (needLogin()) return;
  try {
    const r = await api.shareLike(cur.value.id);
    applyActs({ is_liked: r.liked ? 1 : 0, like_count: r.count });
  } catch (e) { ElMessage.error(e.message); }
}
async function toggleFav() {
  if (needLogin()) return;
  try {
    const r = await api.shareFav(cur.value.id);
    applyActs({ is_faved: r.faved ? 1 : 0, fav_count: r.count });
  } catch (e) { ElMessage.error(e.message); }
}
async function sendComment(text) {
  if (!cur.value || needLogin()) return;
  commentSending.value = true;
  try {
    const c = await api.shareComment(cur.value.id, text);
    (cur.value.comments ||= []).push(c);
    applyActs({ comment_count: (cur.value.comment_count || 0) + 1 });
  } catch (e) { ElMessage.error(e.message); } finally { commentSending.value = false; }
}
async function delComment(c) {
  try {
    await api.shareCommentDelete(c.id);
    cur.value.comments = cur.value.comments.filter((x) => x.id !== c.id);
    applyActs({ comment_count: Math.max(0, (cur.value.comment_count || 0) - 1) });
    ElMessage.success('评论已删除');
  } catch (e) { ElMessage.error(e.message); }
}

async function delPost() {
  try {
    await ElMessageBox.confirm(`删除项目「${cur.value.title}」？评论与点赞收藏将一并删除`, '删除项目', { type: 'warning' });
  } catch { return; }
  try {
    await api.shareDelete(cur.value.id);
    ElMessage.success('项目已删除');
    router.push('/share');
  } catch (e) { ElMessage.error(e.message); }
}

// —— 开源/私密开关（作者/管理员；乐观更新 + 失败回滚）——
async function toggleVisibility(open) {
  if (!cur.value) return;
  const prev = cur.value.is_public;
  cur.value.is_public = open ? 1 : 0;
  try {
    await api.shareVisibility(cur.value.id, open ? 1 : 0);
    ElMessage.success(open ? '已设为开源项目' : '已转为私密项目');
  } catch (e) {
    cur.value.is_public = prev;
    ElMessage.error(e.message);
  }
}

// —— Gitee 同步 ——
const giteeFiles = computed(() => (cur.value?.files || []).filter((f) => f.source === 'gitee'));
const uploadFiles = computed(() => (cur.value?.files || []).filter((f) => f.source !== 'gitee'));
const giteeHref = computed(() => (cur.value?.gitee_repo ? `https://gitee.com/${cur.value.gitee_repo}` : ''));
const giteeBusy = ref(false);
async function syncGitee() {
  if (!cur.value || giteeBusy.value) return;
  giteeBusy.value = true;
  try {
    const r = await api.shareGiteeSync(cur.value.id, cur.value.gitee_repo, cur.value.gitee_ref);
    ElMessage.success(`已同步 ${r.count} 个文件`);
    await load();
  } catch (e) { ElMessage.error(e.message); } finally { giteeBusy.value = false; }
}

// —— ZIP：开源项目走浏览器直连（匿名可下）；私密项目直连带不上 Authorization 头，
// 必须 fetch+blob（token 只进请求头，绝不进 URL）——
const zipBusy = ref(false);
async function downloadZip() {
  if (!cur.value || zipBusy.value) return;
  zipBusy.value = true;
  try {
    const blob = await api.shareZipBlob(cur.value.id);
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = `${cur.value.title || cur.value.id}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  } catch (e) { ElMessage.error(e.message); } finally { zipBusy.value = false; }
}

// —— 编辑弹窗 ——
const postDlg = ref(false);
const editing = ref(null);
function openEdit() {
  if (!isMine.value) return;
  editing.value = cur.value;
  postDlg.value = true;
}
async function onDialogChanged({ id: pid } = {}) {
  await loadTags();
  if (!cur.value || Number(cur.value.id) === Number(pid)) await load();
}

const dirItemCount = (n) => `${n.children.length} 项`;
</script>

<template>
  <main class="pv-page">
    <!-- 面包屑：每段都是真实链接 —— @用户 → 用户主页；项目名 → 项目根；目录段逐级累积 -->
    <header class="pv-crumb-wrap">
      <router-link class="pv-back" to="/share">
        <GhIcon name="arrow-left" :size="14" /> 返回开源大厅
      </router-link>
      <div v-if="!errMsg" class="pv-crumb">
        <GhIcon name="book" :size="16" />
        <router-link :to="userHref" class="pv-seg owner">@{{ username }}</router-link>
        <span class="pv-slash">/</span>
        <router-link :to="rootHref" class="pv-seg name">
          {{ cur?.title || slug }}
          <span v-if="cur && cur.is_public === 0" class="pv-lock" title="私密项目">🔒</span>
          <span v-if="cur?.is_ghost" class="pv-ghost" title="幽灵帖">👻</span>
        </router-link>
        <template v-for="(c, i) in crumbs" :key="i">
          <span class="pv-slash">/</span>
          <router-link v-if="!c.last" :to="c.href" class="pv-seg">{{ c.seg }}</router-link>
          <b v-else class="pv-seg cur">{{ c.seg }}</b>
        </template>
      </div>
    </header>

    <!-- 加载中（首次取项目 / 切到另一个项目）：占位避免空白闪 -->
    <div v-if="loading" class="pv-loading" v-loading="true" />

    <!-- 404：项目不存在 / 私密无权 / 幽灵不可见，文案统一 -->
    <div v-else-if="errMsg" class="pv-404">
      <GhIcon name="book" :size="28" />
      <p>{{ errMsg }}</p>
      <router-link class="pv-btn" to="/share">返回开源大厅</router-link>
    </div>

    <div v-else-if="cur" class="pv-body">
      <div class="pv-main">
        <!-- 根/文件夹：GitHub 风文件表（行点击进 tree/blob 路由） -->
        <section v-if="mode !== 'blob'" class="pv-files">
          <div class="pv-fhead">
            <GhIcon name="file-directory-fill" :size="15" />
            {{ mode === 'tree' ? splatPath || '项目文件' : '项目文件' }}
            <span class="pv-fmeta">{{ entries.length }} 项</span>
          </div>
          <div v-if="entries.length" class="pv-fbody">
            <button
              v-for="n in entries" :key="n.path" class="pv-frow"
              :class="{ dir: n.dir }" @click="openNode(n)"
            >
              <GhIcon
                v-if="n.dir" name="file-directory-fill" :size="16" class="pv-ficon dir"
              />
              <GhIcon
                v-else :name="n.file.source === 'gitee' ? 'repo' : KIND_ICON[fileKind(n.file)]"
                :size="16" class="pv-ficon" :class="{ gitee: n.file.source === 'gitee' }"
              />
              <span class="pv-fname" :title="n.path">{{ n.name }}</span>
              <span v-if="n.file?.source === 'gitee'" class="pv-ftag">Gitee</span>
              <span class="pv-fsize">{{ n.dir ? dirItemCount(n) : fmtSize(n.file.size) }}</span>
            </button>
          </div>
          <p v-else class="pv-fempty">这个目录还是空的</p>
        </section>

        <!-- 路径指向不存在的目录/文件 -->
        <div v-if="pathMissing" class="pv-missing">
          <p>路径「{{ splatPath }}」不存在 —— 作者可能更新过项目文件。</p>
          <button class="pv-btn" @click="router.push(rootHref)">回到项目根目录</button>
        </div>

        <!-- 文件预览：key 跟文件走，blob 间切换强制重新挂载取数 -->
        <ShareFilePreview
          v-if="currentFile" :key="currentFile.id"
          :file="currentFile" :repo="cur.gitee_repo || ''" :ref-name="cur.gitee_ref || ''"
          @close="closePreview"
        />

        <!-- 正文 / 附件 / 点赞收藏 / 讨论（所有视图都在下方，评论链接永远可直达） -->
        <ShareReadme
          standalone :post="cur" :loading="loading" :sending="commentSending"
          :feishu-busy="feishuBusy" :feishu-url="feishuUrl"
          @like="toggleLike" @fav="toggleFav" @comment="sendComment" @del-comment="delComment"
          @edit="openEdit" @feishu-edit="openEdit" @feishu-sync="openEdit" @del="delPost"
          @close="router.push('/share')"
        />
      </div>

      <aside class="pv-aside">
        <!-- About：含开源/私密开关（作者/管理员） -->
        <div class="pv-abox">
          <div class="pv-ahead">About</div>
          <p class="pv-atext">项目正文、附件与讨论都在左侧；URL 即位置，可随时复制分享。</p>
          <div v-if="isMine" class="pv-visrow">
            <span class="pv-vis-label">项目可见性</span>
            <el-switch
              :model-value="cur.is_public !== 0" inline-prompt active-text="🌍 开源" inactive-text="🔒 私密"
              style="--el-switch-on-color: var(--success-fg, #16a34a)"
              @change="toggleVisibility($event)"
            />
          </div>
        </div>

        <div v-if="uploadFiles.length" class="pv-abox">
          <div class="pv-ahead">项目文件</div>
          <p class="pv-atext"><b>{{ uploadFiles.length }}</b> 个文件 · {{ fmtSize(uploadFiles.reduce((s, f) => s + (Number(f.size) || 0), 0)) }}</p>
          <!-- 开源：浏览器直连（匿名也能下，带原生下载进度）；私密：fetch+blob 带 Authorization -->
          <a v-if="cur.is_public !== 0" class="pv-zip" :href="api.shareZipUrl(cur.id)" download>
            <GhIcon name="download" :size="14" /> 下载整个项目（ZIP）
          </a>
          <button v-else class="pv-zip" :disabled="zipBusy" @click="downloadZip">
            <GhIcon name="download" :size="14" /> {{ zipBusy ? '打包中…' : '下载整个项目（ZIP）' }}
          </button>
        </div>

        <div v-if="cur.gitee_repo" class="pv-abox">
          <div class="pv-ahead">Gitee 仓库</div>
          <a class="pv-zip" :href="giteeHref" target="_blank" rel="noopener noreferrer">
            <GhIcon name="repo" :size="14" /> {{ cur.gitee_repo }}
          </a>
          <p v-if="giteeFiles.length" class="pv-atext dim" style="margin-top:8px">已收录 {{ giteeFiles.length }} 个仓库文件</p>
          <button v-if="isMine" class="pv-zip" :disabled="giteeBusy" style="margin-top:8px" @click="syncGitee">
            {{ giteeBusy ? '同步中…' : '↻ 同步仓库' }}
          </button>
        </div>

        <div v-if="cur.tags?.length" class="pv-abox">
          <div class="pv-ahead">Topics</div>
          <div class="pv-topics">
            <router-link v-for="t in cur.tags" :key="t" :to="`/share`" class="pv-topic">{{ t }}</router-link>
          </div>
        </div>
      </aside>
    </div>

    <SharePostDialog v-model="postDlg" :editing="editing" :tag-list="tagList" @changed="onDialogChanged" />
  </main>
</template>

<style lang="scss" scoped>
.pv-page { padding: 20px 24px 60px; max-width: 1180px; margin: 0 auto; }

.pv-crumb-wrap { margin-bottom: 14px; }
.pv-back {
  display: inline-flex; align-items: center; gap: 5px; margin-bottom: 10px;
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 4px 12px; font-size: 12.5px; text-decoration: none;
  &:hover { border-color: var(--primary); color: var(--primary); }
}
.pv-crumb {
  display: flex; align-items: center; gap: 7px; font-size: 18px; color: var(--text-2);
  flex-wrap: wrap;
}
.pv-seg {
  color: var(--primary); text-decoration: none; min-width: 0;
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 5px;
  &:hover { text-decoration: underline; }
  &.name { font-weight: 600; }
  &.cur { color: var(--text); font-weight: 600; }
}
.pv-slash { color: var(--text-3); }
.pv-lock { font-size: 13px; }
.pv-ghost { font-size: 13px; }

.pv-loading { min-height: 320px; }
.pv-404, .pv-missing {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 70px 20px; color: var(--text-3); font-size: 14px; text-align: center;
  p { margin: 0; }
}
.pv-btn {
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--primary);
  border-radius: 8px; padding: 6px 16px; font-size: 13px; text-decoration: none; cursor: pointer; font-family: inherit;
  &:hover { border-color: var(--primary); }
}

.pv-body { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 18px; align-items: start; }
.pv-main { min-width: 0; }

// —— GitHub 风文件表 ——
.pv-files {
  border: 1px solid var(--border-2); border-radius: 6px;
  background: var(--card-bg); overflow: hidden;
}
.pv-fhead {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 14px; background: var(--surface-1); border-bottom: 1px solid var(--border);
  font-size: 13px; color: var(--text-2); font-weight: 600;
}
.pv-fmeta { color: var(--text-3); font-weight: 400; font-size: 12px; }
.pv-fbody { }
.pv-frow {
  display: flex; align-items: center; gap: 8px; width: 100%;
  height: 36px; padding: 0 14px; border: 0; border-bottom: 1px solid var(--border);
  background: transparent; color: var(--text-2); font-size: 13px;
  font-family: inherit; text-align: left; cursor: pointer;
  &:last-child { border-bottom: 0; }
  &:hover, &.dir:hover { background: var(--surface-1); color: var(--primary); }
  &.dir .pv-fname { color: var(--text); font-weight: 500; }
}
.pv-ficon { flex: none; color: var(--text-3); &.dir { color: var(--badge-fg, #d29922); } &.gitee { color: var(--primary); } }
.pv-fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-ftag {
  flex: none; font-size: 10.5px; padding: 0 6px; border-radius: 999px;
  background: var(--primary-tint); color: var(--primary); border: 1px solid var(--border-2);
}
.pv-fsize { flex: none; width: 90px; text-align: right; font-size: 12px; color: var(--text-3); }
.pv-fempty { padding: 22px; margin: 0; text-align: center; font-size: 13px; color: var(--text-3); }

.pv-missing { padding: 40px 20px; }

// —— 侧栏 ——
.pv-aside { display: flex; flex-direction: column; gap: 12px; }
.pv-abox {
  border: 1px solid var(--border-2); border-radius: 6px; background: var(--card-bg);
  padding: 12px 14px;
}
.pv-ahead { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.pv-atext {
  margin: 0 0 8px; font-size: 12.5px; line-height: 1.6; color: var(--text-2);
  &.dim { color: var(--text-3); margin: 0; }
}
.pv-visrow {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  border-top: 1px solid var(--border); padding-top: 10px; margin-top: 4px;
}
.pv-vis-label { font-size: 12.5px; color: var(--text-2); }
.pv-zip {
  display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 4px 12px; font-size: 12.5px; font-family: inherit;
  &:not([disabled]) { cursor: pointer; &:hover { border-color: var(--primary); color: var(--primary); } }
  &[disabled] { opacity: .6; cursor: default; }
}
.pv-topics { display: flex; flex-wrap: wrap; gap: 6px; }
.pv-topic {
  border: 1px solid var(--border-2); background: var(--primary-tint); color: var(--primary);
  border-radius: 999px; padding: 1px 10px; font-size: 11.5px; text-decoration: none;
  &:hover { border-color: var(--primary); }
}

@media (max-width: 900px) {
  .pv-body { grid-template-columns: minmax(0, 1fr); }
  .pv-aside { order: -1; }
}
@media (max-width: 768px) {
  .pv-page { padding: 14px 12px 60px; }
  .pv-crumb { font-size: 15px; }
  .pv-seg { max-width: 180px; }
}
</style>
