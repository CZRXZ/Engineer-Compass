<template>
  <el-dialog :model-value="modelValue" @close="emit('close')" :title="resource ? '编辑资源' : '添加资源'"
    width="520px" append-to-body destroy-on-close>
    <el-form label-position="top">
      <el-form-item label="资源类型" required>
        <el-radio-group v-model="f.kind" :disabled="!!resource">
          <el-radio-button v-for="k in KINDS" :key="k.key" :value="k.key">{{ k.icon }} {{ k.label }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="名称" required>
        <el-input v-model="f.name" maxlength="30" show-word-limit :placeholder="meta.space ? '如：工程训练中心 301' : '如：大疆 RoboMaster S1'" />
      </el-form-item>
      <el-form-item label="位置">
        <el-input v-model="f.location" maxlength="60" :placeholder="meta.space ? '楼栋/房间号' : '存放位置'" />
      </el-form-item>

      <!-- 空间：容量 + 设备参数 -->
      <template v-if="meta.space">
        <el-form-item label="可容纳人数" required>
          <el-input-number v-model="f.capacity" :min="1" :max="9999" :disabled="!!resource" />
          <span class="rf-hint">同一时段独占，预约人数不能超过容量</span>
        </el-form-item>
        <el-form-item label="室内设备（可选，回车添加，如投影仪、白板、通风橱）">
          <el-select v-model="f.equipment" multiple filterable allow-create default-first-option
            :reserve-keyword="false" style="width: 100%" placeholder="输入设备名后回车">
            <el-option v-for="e in f.equipment" :key="e" :value="e" :label="e" />
          </el-select>
        </el-form-item>
      </template>

      <!-- 物品：库存 + 单位 + 规格 -->
      <template v-else>
        <el-form-item label="库存数量" required>
          <el-input-number v-model="f.quantity" :min="1" :max="9999" />
          <el-input v-model="f.unit" maxlength="8" style="width: 96px; margin-left: 10px" placeholder="单位（件/台）" />
          <span class="rf-hint">按数量库存共享，借完为止</span>
        </el-form-item>
        <el-form-item label="规格型号（可选）">
          <el-input v-model="f.spec" maxlength="40" placeholder="如：STM32F407 开发板" />
        </el-form-item>
      </template>

      <el-form-item label="审批方式（该资源独立生效）">
        <el-radio-group v-model="f.approve_mode">
          <el-radio value="approval">需审批</el-radio>
          <el-radio value="first_come">先到先得</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { KINDS, KIND_MAP } from '../../utils/booking.js';

const props = defineProps({
  modelValue: Boolean,
  project: { type: Object, required: true },
  resource: { type: Object, default: null },
});
const emit = defineEmits(['close', 'saved']);

const empty = () => ({
  kind: 'space', name: '', location: '', capacity: 30, quantity: 1,
  unit: '', spec: '', equipment: [], approve_mode: props.project.default_approve_mode || 'approval',
});
const f = ref(empty());
const saving = ref(false);
const meta = computed(() => KIND_MAP[f.value.kind]);

watch(() => props.modelValue, (v) => {
  if (!v) return;
  if (props.resource) {
    f.value = {
      kind: props.resource.kind, name: props.resource.name, location: props.resource.location,
      capacity: props.resource.capacity ?? 30, quantity: props.resource.quantity ?? 1,
      unit: props.resource.unit || '', spec: props.resource.spec || '',
      equipment: props.resource.params?.equipment || [],
      approve_mode: props.resource.approve_mode,
    };
  } else {
    f.value = empty();
  }
}, { immediate: true });

async function submit() {
  if (!f.value.name.trim()) return ElMessage.warning('请填写资源名称');
  const isSpace = meta.value.space;
  if (isSpace && !(f.value.capacity >= 1)) return ElMessage.warning('请填写可容纳人数');
  if (!isSpace && !(f.value.quantity >= 1)) return ElMessage.warning('请填写库存数量');
  const body = {
    kind: f.value.kind, name: f.value.name.trim(), location: f.value.location, approve_mode: f.value.approve_mode,
    ...(isSpace
      ? { capacity: f.value.capacity, equipment: f.value.equipment }
      : { quantity: f.value.quantity, unit: f.value.unit, spec: f.value.spec }),
  };
  saving.value = true;
  try {
    if (props.resource) {
      // 编辑时 kind/容量库存之外字段按类型提交；容量库存变更后端有占用复检
      const editBody = { name: body.name, location: body.location, approve_mode: body.approve_mode };
      if (isSpace) editBody.capacity = body.capacity, editBody.equipment = body.equipment;
      else editBody.quantity = body.quantity, editBody.unit = body.unit, editBody.spec = body.spec;
      await api.bookingResourceUpdate(props.resource.id, editBody);
      ElMessage.success('已保存');
    } else {
      await api.bookingResourceCreate(props.project.id, body);
      ElMessage.success('资源已添加');
    }
    emit('saved');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.rf-hint { margin-left: 12px; font-size: 12px; color: var(--text-3); }
</style>
