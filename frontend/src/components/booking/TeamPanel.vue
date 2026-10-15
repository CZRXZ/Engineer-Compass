<template>
  <div class="tp-wrap">
    <div class="tp-bar">
      <span class="dim tp-hint">固定组队在预约模块内自建，队长可直接带整队下单，下单时成员快照固化。</span>
      <el-button type="primary" size="small" @click="create">＋ 新建组队</el-button>
    </div>
    <div v-loading="loading" class="tp-grid">
      <article v-for="t in teams" :key="t.id" class="tm-card card">
        <div class="tm-head">
          <b>👥 {{ t.name }}</b>
          <el-tag size="small" type="info" effect="plain">队长 {{ t.owner_name }}</el-tag>
        </div>
        <div class="tm-members">
          <el-tag v-for="m in t.members" :key="m.user_id" size="small" class="tm-member">{{ m.user_name }}</el-tag>
          <span v-if="!t.members.length" class="dim">暂无成员</span>
        </div>
        <div class="tm-actions">
          <el-button v-if="t.canManage" link type="primary" size="small" @click="edit(t)">编辑成员/改名</el-button>
          <el-button v-if="t.canManage" link type="danger" size="small" @click="remove(t)">删除</el-button>
        </div>
      </article>
      <div v-if="!loading && !teams.length" class="empty-wrap"><el-empty description="还没有固定组队" :image-size="80" /></div>
    </div>
    <TeamFormDialog v-if="formOpen" :model-value="formOpen" :project="project" :team="editing"
      @close="formOpen = false" @saved="onSaved" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import TeamFormDialog from './TeamFormDialog.vue';

const props = defineProps({ project: { type: Object, required: true } });

const teams = ref([]);
const loading = ref(false);
const formOpen = ref(false);
const editing = ref(null);

async function load() {
  loading.value = true;
  try {
    teams.value = (await api.bookingTeams(props.project.id)).teams;
  } finally {
    loading.value = false;
  }
}
function create() { editing.value = null; formOpen.value = true; }
function edit(t) { editing.value = t; formOpen.value = true; }
function onSaved() { formOpen.value = false; load(); }
async function remove(t) {
  try {
    await ElMessageBox.confirm(`删除组队「${t.name}」？历史预约保留（仅解除关联）。`, '删除组队', { type: 'warning' });
  } catch { return; }
  try {
    await api.bookingTeamDelete(t.id);
    ElMessage.success('已删除');
    load();
  } catch (e) { ElMessage.error(e.message); }
}
onMounted(load);
defineExpose({ reload: load });
</script>

<style lang="scss" scoped>
.tp-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.tp-hint { font-size: 12.5px; }
.tp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.tm-card { padding: 14px 16px; margin-bottom: 0; display: flex; flex-direction: column; gap: 10px; } // grid 间距走 gap，抵消全局 .card margin
.tm-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tm-members { display: flex; flex-wrap: wrap; gap: 6px; min-height: 24px; }
.tm-member { border-radius: 999px; }
.tm-actions { border-top: 1px dashed var(--border-2); padding-top: 6px; }
</style>
