import { createRemoteJWKSet, jwtVerify } from 'jose';

const PUBLIC_PATHS = new Set(['/', '/index.html', '/style.css', '/script.js']);
const PROJECT_PATTERN = /^[A-Za-z0-9_]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function backlogConfig(env) {
  let url;
  try {
    url = new URL(env.BACKLOG_SPACE_URL);
  } catch {
    throw new HttpError(503, '管理者によるBacklog接続先の設定が必要です。');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9-]+\.(backlog\.com|backlog\.jp|backlogtool\.com)$/.test(url.hostname)) {
    throw new HttpError(503, 'Backlog接続先の設定が正しくありません。');
  }
  const projects = [...new Set(String(env.BACKLOG_ALLOWED_PROJECTS || '')
    .split(',').map(value => value.trim()).filter(Boolean))];
  if (!projects.length || projects.some(value => !PROJECT_PATTERN.test(value))) {
    throw new HttpError(503, '管理者による許可プロジェクトの設定が必要です。');
  }
  return { spaceUrl: url.origin, projects };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// 通信関数と公開鍵取得を差し替え、実キーなしで認証・取得を検証できるようにする。
export function createWorker({ fetchImpl = fetch, jwksFactory = createRemoteJWKSet } = {}) {
  const keySets = new Map();

  async function authenticate(request, env) {
    const url = new URL(request.url);
    // 開発コマンドで明示した場合のみ、ループバック上の認証を省略する。
    if (env.LOCAL_DEV === 'true' && url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return;

    const issuer = String(env.ACCESS_TEAM_DOMAIN || '').replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !env.ACCESS_AUD) {
      throw new HttpError(503, '管理者によるアクセス認証の設定が必要です。');
    }
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new HttpError(401, 'ログインが必要です。画面を再読み込みしてください。');
    try {
      if (!keySets.has(issuer)) {
        keySets.set(issuer, jwksFactory(new URL(`${issuer}/cdn-cgi/access/certs`)));
      }
      await jwtVerify(token, keySets.get(issuer), {
        issuer,
        audience: env.ACCESS_AUD,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub'],
      });
    } catch {
      throw new HttpError(401, '認証を確認できません。画面を再読み込みしてください。');
    }
  }

  async function getIssues(url, env) {
    const config = backlogConfig(env);
    const allowedParams = new Set(['projectId', 'from', 'to']);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key) || url.searchParams.getAll(key).length !== 1) {
        throw new HttpError(400, '取得条件が正しくありません。');
      }
    }
    const projectKey = url.searchParams.get('projectId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!PROJECT_PATTERN.test(projectKey || '') || !config.projects.includes(projectKey)) {
      throw new HttpError(403, 'このプロジェクトは取得対象に登録されていません。');
    }
    if (!validDate(from) || !validDate(to) || from > to) {
      throw new HttpError(400, '集計期間をYYYY-MM-DD形式で、開始日から終了日の順に指定してください。');
    }
    if (typeof env.BACKLOG_API_KEY !== 'string' || !env.BACKLOG_API_KEY.trim()) {
      throw new HttpError(503, 'Backlogへの接続設定が未完了です。管理者に確認してください。');
    }

    const signal = AbortSignal.timeout(30000);
    async function backlogGet(path, params = {}) {
      // 接続先とキーはサーバー設定だけを使い、ブラウザ指定のURLへ転送しない。
      const target = new URL(`/api/v2${path}`, config.spaceUrl);
      for (const [key, values] of Object.entries(params)) {
        for (const value of [].concat(values)) target.searchParams.append(key, value);
      }
      let response;
      try {
        response = await fetchImpl(target, {
          headers: { 'Backlog-API-Key': env.BACKLOG_API_KEY, Accept: 'application/json' },
          redirect: 'error',
          signal,
        });
      } catch {
        throw new HttpError(502, 'Backlogとの通信に失敗しました。時間をおいて再試行してください。');
      }
      if (!response.ok) {
        if (response.status === 429) {
          throw new HttpError(429, 'Backlogの取得回数制限に達しました。時間をおいて再試行してください。');
        }
        // 上流のエラー本文やURLには認証情報が含まれる可能性があるため返さない。
        throw new HttpError(502, 'Backlogから取得できませんでした。管理者に接続設定・権限を確認してください。');
      }
      try {
        return await response.json();
      } catch {
        throw new HttpError(502, 'Backlogの応答を読み取れませんでした。');
      }
    }

    const project = await backlogGet(`/projects/${encodeURIComponent(projectKey)}`);
    if (!Number.isSafeInteger(project.id) || project.id <= 0) {
      throw new HttpError(502, 'Backlogのプロジェクト情報が正しくありません。');
    }
    const [statuses, types] = await Promise.all([
      backlogGet(`/projects/${project.id}/statuses`),
      backlogGet(`/projects/${project.id}/issueTypes`),
    ]);
    if (!Array.isArray(statuses) || !Array.isArray(types)) {
      throw new HttpError(502, 'Backlogの課題設定を読み取れませんでした。');
    }
    const statusNames = ['完了', '処理中', '未対応'];
    const statusIds = statuses.filter(s => statusNames.includes(s.name)).map(s => s.id);
    const typeIds = types.filter(t => typeof t.name === 'string' && !t.name.includes('発注')).map(t => t.id);
    const data = { completed: [], inProgress: [], notStarted: [] };
    if (!statusIds.length || !typeIds.length) return data;

    // 更新日で絞り込み、100件ずつ取得する。過大な取得は途中結果を返さず停止する。
    const groups = { '完了': 'completed', '処理中': 'inProgress', '未対応': 'notStarted' };
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await backlogGet('/issues', {
        'projectId[]': [project.id], 'statusId[]': statusIds, 'issueTypeId[]': typeIds,
        updatedSince: from, updatedUntil: to, count: 100, offset: pageIndex * 100,
      });
      if (!Array.isArray(page)) throw new HttpError(502, 'Backlogの課題一覧を読み取れませんでした。');
      for (const issue of page) {
        const group = groups[issue.status?.name];
        if (!group || !typeIds.includes(issue.issueType?.id)) continue;
        data[group].push({
          issueKey: String(issue.issueKey || ''), summary: String(issue.summary || ''),
          status: issue.status.name, type: String(issue.issueType.name || ''),
          est: Number.isFinite(issue.estimatedHours) ? issue.estimatedHours : 0,
          act: Number.isFinite(issue.actualHours) ? issue.actualHours : 0,
        });
      }
      if (page.length < 100) return data;
    }
    throw new HttpError(422, '取得件数が多すぎます。集計期間を短くしてください。');
  }

  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const api = ['/api/config', '/api/backlog/issues'].includes(url.pathname);
        if (!api && !PUBLIC_PATHS.has(url.pathname)) return json({ error: '見つかりません。' }, 404);
        if (request.method !== 'GET' && !(request.method === 'HEAD' && !api)) {
          return json({ error: 'この操作には対応していません。' }, 405);
        }
        // クロスサイトのブラウザからの呼び出しを拒否し、CORS許可は付けない。
        const origin = request.headers.get('Origin');
        if (api && ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site')) {
          throw new HttpError(403, 'このアクセス元からは利用できません。');
        }
        await authenticate(request, env);
        if (url.pathname === '/api/config') return json(backlogConfig(env));
        if (url.pathname === '/api/backlog/issues') return json(await getIssues(url, env));
        const asset = await env.ASSETS.fetch(request);
        const response = new Response(asset.body, asset);
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('Referrer-Policy', 'same-origin');
        return response;
      } catch (error) {
        // 未知の例外にも秘密情報を含めず、詳細をログへ書き出さない。
        return json({ error: error instanceof HttpError ? error.message : '処理に失敗しました。管理者に確認してください。' },
          error instanceof HttpError ? error.status : 500);
      }
    },
  };
}

export default createWorker();
