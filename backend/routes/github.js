// GitHub 账号 OAuth 绑定（挂载 /api/github；仿 routes/feishu.js 的 oauth 四段）
// 与飞书的差异：只做身份绑定，token 不存全量（只存前缀排障），不做刷新与 OpenAPI 代理。
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { authRequired } from './middleware.js';
import { configured, clientId, exchangeCode, fetchGithubUser } from '../lib/githubClient.js';

const r = Router();

// 回调地址：env 优先，否则按请求 host 推导（与飞书 FEISHU_REDIRECT_URI 同范式）
const redirectUri = (req) =>
  process.env.GITHUB_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/github/oauth/callback`;

// state 内存表（state → {userId, exp}，5 分钟；防 CSRF + 定位绑定到哪个本站账号）
const stateMap = new Map();
const STATE_TTL = 5 * 60 * 1000;
function takeState(st) {
  const ent = st && stateMap.get(st);
  if (!ent) return null;
  stateMap.delete(st);
  return ent.exp > Date.now() ? ent.userId : null;
}

function bindRow(userId) {
  return db.prepare('SELECT github_id, login, avatar_url, profile_url, update_time FROM github_bind WHERE user_id = ?')
    .get(String(userId));
}

// GET /api/github/oauth/status — 当前用户的绑定状态（未配置时 configured=false，前端置灰）
r.get('/oauth/status', authRequired, (req, res) => {
  const b = bindRow(req.user.id);
  res.json({
    configured: configured(),
    bound: !!b,
    github_id: b?.github_id || null,
    login: b?.login || '',
    avatar_url: b?.avatar_url || '',
    profile_url: b?.profile_url || '',
  });
});

// GET /api/github/oauth/auth — 返回授权跳转 URL（弹窗打开；scope 只要身份）
r.get('/oauth/auth', authRequired, (req, res) => {
  if (!configured()) {
    return res.status(400).json({ error: '请先在 backend/.env 配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET' });
  }
  const st = randomBytes(12).toString('hex');
  stateMap.set(st, { userId: req.user.id, exp: Date.now() + STATE_TTL });
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(req),
    state: st,
    scope: 'read:user user:email',
  });
  res.json({ url: `https://github.com/login/oauth/authorize?${params.toString()}` });
});

// GET /api/github/oauth/callback — 换 token、拉身份、upsert 绑定；回执 HTML 通知 opener
r.get('/oauth/callback', async (req, res) => {
  const html = (ok, msg) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>GitHub 授权回调</title>
<style>body{font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;margin:0}
div{text-align:center;background:#161b22;padding:40px 48px;border-radius:16px;max-width:520px;border:1px solid #30363d}
h2{margin:0 0 12px}</style></head><body><div><h2>${ok ? '✅ GitHub 授权成功，已绑定' : '❌ GitHub 授权失败'}</h2>
<p>${msg}</p></div>${ok ? '<script>if (window.opener) window.opener.postMessage({ type: \'github-bound\' }, \'*\');</' + 'script>' : ''}
</body></html>`;
  const { code, state } = req.query;
  if (!code) return res.status(400).send(html(false, '回调缺少 code'));
  const userId = takeState(state);
  if (userId === null) return res.status(400).send(html(false, 'state 校验失败或已过期（防跨站），请重试授权'));
  try {
    const tok = await exchangeCode(code, redirectUri(req));
    if (!tok.access_token) throw new Error('未拿到 access_token');
    const gh = await fetchGithubUser(tok.access_token);
    if (!gh?.id || !gh?.login) throw new Error('GitHub 用户信息不完整');
    // 同一 GitHub 账号不允许绑两个本站账号：先占先得（提示账号归属）
    const other = db.prepare('SELECT user_id FROM github_bind WHERE github_id = ? AND user_id != ?')
      .get(gh.id, String(userId));
    if (other) throw new Error('该 GitHub 账号已绑定其他本站账号，请先在那边解绑');
    db.prepare(
      `INSERT INTO github_bind (user_id, github_id, login, avatar_url, profile_url, token_prefix, update_time)
       VALUES (?,?,?,?,?,?,datetime('now','localtime'))
       ON CONFLICT(user_id) DO UPDATE SET
         github_id = excluded.github_id, login = excluded.login, avatar_url = excluded.avatar_url,
         profile_url = excluded.profile_url, token_prefix = excluded.token_prefix,
         update_time = datetime('now','localtime')`
    ).run(String(userId), gh.id, gh.login, gh.avatar_url || '', gh.html_url || `https://github.com/${gh.login}`,
      String(tok.access_token).slice(0, 8));
    res.send(html(true, `GitHub 用户 <b>@${gh.login}</b> 已绑定到当前账号，可关闭此页`));
  } catch (e) {
    res.status(400).send(html(false, e.message));
  }
});

// POST /api/github/oauth/unbind — 解绑当前账号
r.post('/oauth/unbind', authRequired, (req, res) => {
  db.prepare('DELETE FROM github_bind WHERE user_id = ?').run(String(req.user.id));
  res.json({ message: '已解绑 GitHub 账号' });
});

export default r;
