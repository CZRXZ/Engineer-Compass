// 冒烟用的「假 GitHub」：一个本地 http 服务，同端口伺候 OAuth 三条路径（GITHUB_API_ORIGIN 整体指过来）：
//   POST /login/oauth/access_token  code → token
//   GET  /user                      Bearer → 固定身份
//   GET  /user/emails              Bearer → 固定邮箱列表
//
// code 夹具（token 即 tok_<code>）：
//   bound   已绑账号身份（先由绑定用例占用，登录走 bind 命中分支）
//   mail    真实邮箱 autobind@x.dev（本站预置同邮箱账号 → 一键登录自动绑定）
//   taken   与 mail 同邮箱、不同 github_id（该账号已绑 mail → 必须拒绝，防账号被夺）
//   new     全新邮箱（匹配不上 → 自动建新号）
//   noreply 只有 @users.noreply 邮箱（建号但 email 落 NULL）
//   banned  真实邮箱 banned@x.dev（本站账号已封禁 → 拒绝且不建会话）
//   xss     换码返回含 <script> 的 error_description（验证回调页转义，不渲原文）
//   其余 code 按 GitHub 真实口径回 error JSON（HTTP 200 + error/error_description）
import { createServer } from 'node:http';

export const FIXTURES = {
  bound: { id: 1001, login: 'gh-bound', name: '绑定君', email: 'bound@x.dev' },
  mail: { id: 1002, login: 'gh-mail', name: '邮箱君', email: 'autobind@x.dev' },
  taken: { id: 1005, login: 'gh-taken', name: '抢号君', email: 'autobind@x.dev' },
  new: { id: 1003, login: 'gh-new', name: '新来的 Octo', email: 'brand-new@x.dev' },
  noreply: { id: 1004, login: 'gh-noreply', name: '无邮箱君', email: null },
  banned: { id: 1006, login: 'gh-banned', name: '封禁君', email: 'banned@x.dev' },
};

export function startFakeGithub(port) {
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const bearer = () => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const byToken = (tok) => Object.entries(FIXTURES).find(([k]) => `tok_${k}` === tok)?.[1] || null;

    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      await new Promise((done) => req.on('end', done));
      const body = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      const key = String(body.code || '');
      if (FIXTURES[key]) {
        return send(200, { access_token: `tok_${key}`, token_type: 'bearer', scope: 'read:user user:email' });
      }
      if (key === 'xss') {
        return send(200, { error: 'bad_verification_code', error_description: '<script>alert(1)</script>' });
      }
      return send(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
    }

    if (req.method === 'GET' && url.pathname === '/user') {
      const f = byToken(bearer());
      if (!f) return send(401, { message: 'Bad credentials' });
      return send(200, {
        id: f.id, login: f.login, name: f.name,
        avatar_url: `https://fake-gh.invalid/u/${f.id}.png`,
        html_url: `http://127.0.0.1:${port}/${f.login}`,
      });
    }

    if (req.method === 'GET' && url.pathname === '/user/emails') {
      const f = byToken(bearer());
      if (!f) return send(401, { message: 'Bad credentials' });
      if (!f.email) {
        return send(200, [{ email: `${f.id}+${f.login}@users.noreply.github.com`, primary: true, verified: true, visibility: null }]);
      }
      return send(200, [{ email: f.email, primary: true, verified: true, visibility: 'public' }]);
    }

    send(404, { error: 'fake github: no such path', path: url.pathname });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}
