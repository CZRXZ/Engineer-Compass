<template>
  <el-dialog :model-value="modelValue" @close="emit('close')" :title="team ? '编辑组队' : '新建固定组队'"
    width="520px" append-to-body destroy-on-close>
    <el-form label-position="top">
      <el-form-item label="队伍名称" required>
        <el-input v-model="f.name" maxlength="20" show-word-limit placeholder="如：魔毯底盘组" />
      </el-form-item>
      <el-form-item label="成员（全站搜索用户名/昵称，不含队长本人；最多 30 人）">
        <el-select v-model="f.member_ids" multiple filterable remote :remote-method="search"
          :loading="searching" :reserve-keyword="false" style="width: 100%" placeholder="输入用户名或昵称搜索">
          <el-option v-for="u in options" :key="u.id" :value="u.id"
            :label="u.username ? `${displayName(u)}（@${u.username}）` : displayName(u)">
            <span class="tf-opt">
              <el-avatar :size="20" :src="u.avatar || undefined">{{ displayName(u).charAt(0) }}</el-avatar>
              {{ displayName(u) }} <i v-if="u.username">@{{ u.username }}</i>
            </span>
          </el-option>
        </el-select>
      </el-form-item>
      <p class="tf-hint dim">组队仅用于预约模块，与项目小组无关；已下预约的参与人在下单时固化，之后改队不影响历史预约。</p>
    </el-form>
    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { displayName } from '../../utils/displayName.js';

const props = defineProps({
  modelValue: Boolean,
  project: { type: Object, required: true },
  team: { type: Object, default: null },
});
const emit = defineEmits(['close', 'saved']);

const f = ref({ name: '', member_ids: [] });
const options = ref([]);
const searching = ref(false);
const saving = ref(false);

async function search(q) {
  if (!q) { options.value = []; return; }
  searching.value = true;
  try {
    options.value = (await api.bookingUserSearch(q)).users;
  } finally {
    searching.value = false;
  }
}
watch(() => props.modelValue, async (open) => {
  if (!open) return;
  if (props.team) {
    f.value = { name: props.team.name, member_ids: props.team.members.map((m) => m.user_id) };
    // 回填成员选项（user_name 为建队时的署名快照，直接显示，不再二次组合）
    options.value = props.team.members.map((m) => ({
      id: m.user_id, username: '', nickname: m.user_name, avatar: '',
    }));
  } else {
    f.value = { name: '', member_ids: [] };
    options.value = [];
  }
}, { immediate: true });

async function submit() {
  if (!f.value.name.trim()) return ElMessage.warning('请填写队伍名称');
  if (f.value.member_ids.length > 30) return ElMessage.warning('最多 30 名成员');
  saving.value = true;
  try {
    if (props.team) {
      await api.bookingTeamUpdate(props.team.id, { name: f.value.name.trim(), member_ids: f.value.member_ids });
    } else {
      await api.bookingTeamCreate(props.project.id, { name: f.value.name.trim(), member_ids: f.value.member_ids });
    }
    ElMessage.success('已保存');
    emit('saved');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.tf-opt { display: inline-flex; align-items: center; gap: 6px;
  i { color: var(--text-3); font-style: normal; font-size: 12px; margin-left: 2px; }
  :deep(.el-avatar) { background: var(--primary); font-size: 11px; }
}
.tf-hint { font-size: 12px; margin: 0; }
</style>
