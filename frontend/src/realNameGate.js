// 实名硬门禁全局状态：全站路由守卫（登录即拦，含首页）与 api 层 403(need_real_name) 都可打开不可关闭弹窗。
// pendingTo 仅 booking/purchase 硬取消导航时记录目标路由，填名成功后由 App.vue 跳转；其余页面原地关闭。
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
