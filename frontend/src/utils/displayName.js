// 三模块（资源预约/经费报销/物料采购）统一署名：真名（昵称）；无真名回退昵称/用户名/快照名。
// 与后端 middleware.js displayNameOf 同口径。对象上的名字段可能叫 nickname / user_name（快照）。
// 昵称已包含真名时（如昵称本身是「张玉磊（284806020）」，信息更全）直接显示昵称，避免双层嵌套。
export const displayName = (u) => {
  if (!u) return '';
  const rn = String(u.real_name || '').trim();
  const nick = String(u.nickname ?? u.user_name ?? u.username ?? '').trim();
  if (!rn) return nick;
  if (!nick || rn === nick || nick.includes(rn)) return nick || rn;
  return `${rn}（${nick}）`;
};
