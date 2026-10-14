// GitHub 风项目路径名（share_post.slug）：纯函数 slugify + 同用户唯一分配。
// database.js 一次性回填与 routes/share.js 发帖共用，规则漂移会让老链接失效。
//
// 规则：保留中文/字母/数字/下划线/连字符；空白与斜杠转 '-'；剥掉 URL 危险字符
// （? # % . 等，特别是 '.' 避免 '.' '..' 这类路径段）；截断 60；空则用 project-{id}。
export function slugify(title) {
  const s = String(title || '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^一-龥A-Za-z0-9_-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s;
}

// 为某用户的帖子分配唯一 slug（同 user_id 唯一；exceptId 排除自身）。
// db 由调用方传入（database.js 迁移期与请求期共用同一 DatabaseSync）。
export function uniquePostSlug(db, userId, title, exceptId = 0) {
  const base = slugify(title) || `project-${exceptId || 'new'}`;
  let slug = base.slice(0, 60);
  for (let n = 2; ; n++) {
    const hit = db.prepare(
      'SELECT id FROM share_post WHERE user_id = ? AND slug = ? AND id != ?'
    ).get(Number(userId), slug, Number(exceptId));
    if (!hit) return slug;
    const suffix = `-${n}`;
    slug = `${base.slice(0, 60 - suffix.length)}${suffix}`;
  }
}
