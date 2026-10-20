import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createStore, HttpError } from './store.js';

const PUBLIC_PATHS = new Set(['/', '/index.html', '/style.css', '/script.js']);
const PROJECT_PATTERN = /^[A-Za-z0-9_]+$/;

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
  return { spaceUrl: url.origin };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function identity(value, env) {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(value.trim())) throw new HttpError(401, '利用者のメールアドレスを確認できません。');
  const email = value.trim().toLowerCase();
  const admins = String(env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return { email, isAdmin: admins.includes(email) };
}

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'JSON形式で送信してください。');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '入力がありません。');
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new HttpError(413, '入力が長すぎます。'); }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(await new Blob(chunks).text());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, '入力形式が正しくありません。'); }
}

function validateSettings(body) {
  const settings = {};
  for (const key of ['name', 'director', 'projectId']) {
    if (typeof body[key] !== 'string' || body[key].trim().length > 200 || (key !== 'director' && !body[key].trim())) throw new HttpError(400, '名前・担当者・プロジェクトの入力を確認してください。');
    settings[key] = body[key].trim();
  }
  if (!PROJECT_PATTERN.test(settings.projectId)) throw new HttpError(400, 'プロジェクトIDまたはキーが正しくありません。');
  for (const key of ['monthlyHours', 'carryOverHours', 'extraHours']) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || Math.abs(body[key]) > 100000 || (key !== 'carryOverHours' && body[key] < 0)) throw new HttpError(400, '工数は数値で入力してください。契約・追加工数は0以上にしてください。');
    settings[key] = Math.round(body[key] * 100) / 100;
  }
  return settings;
}

function makeSnapshot(client, data, from, to, email) {
  const round = n => Math.round(n * 100) / 100;
  const total = field => round(round(data.completed.reduce((s, i) => s + i[field], 0)) + round(data.inProgress.reduce((s, i) => s + i[field], 0)));
  const est = total('est'), act = total('act');
  const capacity = round(client.monthlyHours + client.carryOverHours + client.extraHours);
  return { from, to, fetchedAt: new Date().toISOString(), fetchedBy: email, est, act, capacity, remaining: round(capacity - est - act), data };
}

// 通信関数と公開鍵取得を差し替え、実キーなしで認証・取得を検証できるようにする。
export function createWorker({ fetchImpl = fetch, jwksFactory = createRemoteJWKSet } = {}) {
  const keySets = new Map();

  async function authenticate(request, env) {
    const url = new URL(request.url);
    // 開発コマンドで明示した場合のみ、ループバック上の認証を省略する。
    if (env.LOCAL_DEV === 'true' && url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return identity(env.LOCAL_USER_EMAIL, env);
    }

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
      const { payload } = await jwtVerify(token, keySets.get(issuer), {
        issuer,
        audience: env.ACCESS_AUD,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'email'],
      });
      return identity(payload.email, env);
    } catch {
      throw new HttpError(401, '認証を確認できません。画面を再読み込みしてください。');
    }
  }

  function backlogReader(env) {
    const config = backlogConfig(env);
    if (typeof env.BACKLOG_API_KEY !== 'string' || !env.BACKLOG_API_KEY.trim()) {
      throw new HttpError(503, 'Backlogへの接続設定が未完了です。管理者に確認してください。');
    }
    const signal = AbortSignal.timeout(30000);
    return async function backlogGet(path, params = {}) {
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

  }

  async function resolveProject(key, env) {
    const project = await backlogReader(env)(`/projects/${encodeURIComponent(key)}`);
    if (!Number.isSafeInteger(project.id) || project.id <= 0) {
      throw new HttpError(502, 'Backlogのプロジェクト情報が正しくありません。');
    }
    return String(project.id);
  }

  async function getIssues(projectId, from, to, env) {
    const backlogGet = backlogReader(env);
    const project = { id: projectId };
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
        const api = url.pathname.startsWith('/api/');
        if (!api && !PUBLIC_PATHS.has(url.pathname)) return json({ error: '見つかりません。' }, 404);
        const origin = request.headers.get('Origin');
        if (api && ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site')) {
          throw new HttpError(403, 'このアクセス元からは利用できません。');
        }
        const user = await authenticate(request, env);
        if (url.pathname === '/api/config' && request.method === 'GET') return json({ ...backlogConfig(env), user });
        if (api) {
          const match = url.pathname.match(/^\/api\/clients(?:\/([a-zA-Z0-9-]+)(?:\/(fetch|history)(?:\/([a-zA-Z0-9-]+))?)?)?$/);
          if (!match) throw new HttpError(404, '見つかりません。');
          const [, id, action, historyId] = match;
          const method = request.method;
          if (url.search) throw new HttpError(400, '取得条件が正しくありません。');
          const store = createStore(env.DB);
          if (method === 'GET' && !action && !id) return json({ clients: await store.list() });
          if (method === 'GET' && action === 'history' && historyId) return json(await store.history(id, historyId));
          const registration = (!id && method === 'POST') || (id && !action && ['PUT', 'DELETE'].includes(method));
          const fetching = id && action === 'fetch' && !historyId && method === 'POST';
          if (!registration && !fetching) throw new HttpError(405, 'この操作には対応していません。');
          if (registration && !user.isAdmin) throw new HttpError(403, '登録・編集・削除には管理者権限が必要です。');
          const body = await readBody(request);
          const fields = fetching ? ['revision', 'from', 'to'] : method === 'DELETE' ? ['revision'] :
            ['name', 'director', 'projectId', 'monthlyHours', 'carryOverHours', 'extraHours', ...(id ? ['revision'] : [])];
          if (Object.keys(body).some(key => !fields.includes(key))) throw new HttpError(400, '指定できない項目が含まれています。');
          if (id && (!Number.isSafeInteger(body.revision) || body.revision < 1)) throw new HttpError(400, '更新番号が正しくありません。');
          if (method === 'DELETE') { await store.remove(id, body.revision); return json({ deleted: true }); }
          const current = id ? await store.get(id) : null;
          if (current && current.revision !== body.revision) throw new HttpError(409, '他の利用者が更新しました。「一覧を更新」してからやり直してください。');
          const config = backlogConfig(env);
          if (fetching) {
            if (current.spaceUrl !== config.spaceUrl) throw new HttpError(409, '接続先が変更されています。管理者に登録の更新を依頼してください。');
            if (!validDate(body.from) || !validDate(body.to) || body.from > body.to) throw new HttpError(400, '集計期間をYYYY-MM-DD形式で、開始日から終了日の順に指定してください。');
            const data = await getIssues(current.projectId, body.from, body.to, env);
            const { history, revision, id: clientId, ...saved } = current;
            const snapshot = makeSnapshot(saved, data, body.from, body.to, user.email);
            return json(await store.update(id, body.revision, { ...saved, data, from: body.from, to: body.to, synced: true, updatedBy: user.email }, { snapshot }));
          }
          const settings = validateSettings(body);
          settings.projectId = await resolveProject(settings.projectId, env);
          settings.spaceUrl = config.spaceUrl;
          const changed = current && (current.projectId !== settings.projectId || current.spaceUrl !== settings.spaceUrl);
          const { history, revision, id: clientId, ...previous } = current || {};
          const today = new Date().toISOString().slice(0, 10);
          const saved = { from: today.slice(0, 8) + '01', to: today, ...previous, ...settings, updatedBy: user.email };
          if (!current || changed) { saved.data = null; saved.synced = false; }
          return json(current ? await store.update(id, body.revision, saved, { clearHistory: changed }) : await store.add(saved), current ? 200 : 201);
        }
        if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'この操作には対応していません。');
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
