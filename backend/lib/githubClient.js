// GitHub OAuth 极简客户端（账号绑定 + 一键登录：换 token、拉身份、拉已验证邮箱；不做 token 刷新/仓库操作）
// 配置走 env：GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET，可选 GITHUB_REDIRECT_URI /
//   GITHUB_FRONTEND_ORIGIN（dev 同源回调）/ GITHUB_API_ORIGIN（测试 mock 口子）
// token 不落库（只留前 8 位排障）——身份绑定后不再需要它；失效了用户解绑重绑即可。
const APP_ORIGIN = process.env.GITHUB_API_ORIGIN || 'https://github.com';
const API_ORIGIN = process.env.GITHUB_API_ORIGIN || 'https://api.github.com';
// ⚠️ GITHUB_API_ORIGIN 同时改站点源与 API 源（测试 mock 用）：假服务器必须在同端口伺候
//   POST /login/oauth/access_token、GET /user、GET /user/emails 三条路径。
const FETCH_TIMEOUT_MS = 15000;

export const configured = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
export const clientId = () => process.env.GITHUB_CLIENT_ID || '';
export const webOrigin = () => APP_ORIGIN;

async function postJson(url, body, headers = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.error) {
    throw new Error(json.error_description || json.error || `GitHub HTTP ${resp.status}`);
  }
  return json;
}

// code → access_token（Web application flow）
export async function exchangeCode(code, redirectUri) {
  return postJson(`${APP_ORIGIN}/login/oauth/access_token`, {
    client_id: clientId(),
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    code: String(code || ''),
    redirect_uri: redirectUri,
  });
}

const authHeaders = (accessToken) => ({
  'Authorization': `Bearer ${accessToken}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'Engineer-Compass',
  'X-GitHub-Api-Version': '2022-11-28',
});

// Bearer token → GitHub 用户身份
export async function fetchGithubUser(accessToken) {
  const resp = await fetch(`${API_ORIGIN}/user`, {
    headers: authHeaders(accessToken),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`获取 GitHub 用户信息失败：HTTP ${resp.status}`);
  return resp.json();
}

// Bearer token → 邮箱列表 [{email, primary, verified, visibility}]（一键登录按已验证主邮箱匹配本站账号）
export async function fetchGithubEmails(accessToken) {
  const resp = await fetch(`${API_ORIGIN}/user/emails`, {
    headers: authHeaders(accessToken),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`获取 GitHub 邮箱列表失败：HTTP ${resp.status}`);
  return resp.json();
}
