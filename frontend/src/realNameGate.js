// 实名硬门禁全局状态：路由守卫与 api 层 403(need_real_name) 都可以打开不可关闭弹窗。
// pendingTo 记录被拦时想去的路由，填名成功后由 App.vue 跳转。
import { reactive } from 'vue';

export const realNameGate = reactive({
  open: false,
  pendingTo: null,
});

export function openGate(to = null) {
  if (to) realNameGate.pendingTo = to;
  realNameGate.open = true;
}

export function closeGate() {
  realNameGate.open = false;
  realNameGate.pendingTo = null;
}
