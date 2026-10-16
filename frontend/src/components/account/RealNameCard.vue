<script setup>
// 实名认证卡：未实名红色警示（三模块硬门禁）；已实名显示真名，可随时修改（无审核）。
import { ref } from 'vue';
import auth from '../../auth.js';
import RealNameDialog from './RealNameDialog.vue';

const dlg = ref(false);
</script>

<template>
  <section class="ac-card">
    <div class="ac-head">
      <span class="ac-icon">🪪</span>
      <div class="ac-titles">
        <h3>实名认证
          <el-tag v-if="auth.user?.real_name" size="small" type="success" plain style="margin-left:8px">已实名</el-tag>
          <el-tag v-else size="small" type="danger" plain style="margin-left:8px">未实名</el-tag>
        </h3>
        <p class="ac-desc">
          <template v-if="auth.user?.real_name">
            <span class="mono">{{ auth.user.real_name }}</span> · 资源预约 / 经费报销 / 物料采购署名使用
          </template>
          <template v-else>
            <span class="rn-warn">资源预约 / 经费报销 / 物料采购需实名后才能使用，请填写真实姓名</span>
          </template>
        </p>
      </div>
      <div class="ac-actions">
        <el-button type="primary" :plain="!!auth.user?.real_name" @click="dlg = true">
          {{ auth.user?.real_name ? '修改' : '去填写' }}
        </el-button>
      </div>
    </div>

    <RealNameDialog v-model="dlg" closable />
  </section>
</template>

<style scoped>
.rn-warn { color: var(--el-color-danger); }
</style>
