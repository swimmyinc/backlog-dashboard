import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createStore, HttpError } from './store.js';

const PUBLIC_PATHS = new Set(['/', '/index.html', '/index.txt', '/404.html', '/404', '/_not-found', '/_not-found.html', '/_not-found.txt', '/__next.__PAGE__.txt', '/__next._full.txt', '/__next._tree.txt', '/_not-found/__next._not-found.__PAGE__.txt', '/_not-found/__next._full.txt', '/_not-found/__next._tree.txt']);
// Next.jsの公開用チャンクだけを許可し、ソースマップやサーバーファイルを配信しない。
const STATIC_ASSET_PATTERN = /^\/_next\/static\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|gif|svg|webp|ico)$/;
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
  return settings;
}

function monthRange(month) {
  if (typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, '対象月をYYYY-MM形式で指定してください。');
  const [year, number] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: month + '-01', to: month + '-' + last };
}

function validateHours(value, negative = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100000 || (!negative && value < 0)) throw new HttpError(400, '工数は上限100000時間の数値で入力してください。月次・追加工数は0以上です。');
  return Math.round(value * 100) / 100;
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
          // Workersが対応するmanualで転送を止め、別の接続先へキーを送らない。
          redirect: 'manual',
          signal,
        });
      } catch {
        throw new HttpError(502, 'Backlogとの通信に失敗しました。時間をおいて再試行してください。');
      }
      if (response.status >= 300 && response.status < 400) {
        throw new HttpError(502, 'Backlogから転送応答が返されました。管理者に接続先の設定を確認してください。');
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
    const statusNames = ['完了', '処理中', '処理済み', '未対応'];
    const statusIds = statuses.filter(s => statusNames.includes(s.name)).map(s => s.id);
    const typeIds = types.filter(t => typeof t.name === 'string' && !t.name.includes('発注')).map(t => t.id);
    const data = { confirmed: [], planned: [] };
    if (!statusIds.length || !typeIds.length) return data;

    // 開始日で絞り込み、100件ずつ取得する。過大な取得は途中結果を返さず停止する。
    const groups = { '完了': 'confirmed', '処理中': 'confirmed', '処理済み': 'confirmed', '未対応': 'planned' };
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await backlogGet('/issues', {
        'projectId[]': [project.id], 'statusId[]': statusIds, 'issueTypeId[]': typeIds,
        startDateSince: from, startDateUntil: to, count: 100, offset: pageIndex * 100,
      });
      if (!Array.isArray(page)) throw new HttpError(502, 'Backlogの課題一覧を読み取れませんでした。');
      for (const issue of page) {
        const group = groups[issue.status?.name];
        const startDate = typeof issue.startDate === 'string' ? issue.startDate.slice(0, 10) : '';
        if (!group || !typeIds.includes(issue.issueType?.id) || !validDate(startDate) || startDate < from || startDate > to) continue;
        data[group].push({
          issueKey: String(issue.issueKey || ''), summary: String(issue.summary || ''),
          status: issue.status.name, type: String(issue.issueType.name || ''),
          est: Number.isFinite(issue.estimatedHours) ? issue.estimatedHours : null,
          startDate,
        });
      }
      if (page.length < 100) return data;
    }
    throw new HttpError(422, '指定期間の課題数が取得上限を超えています。管理者に確認してください。');
  }

  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const api = url.pathname.startsWith('/api/');
        if (!api && !PUBLIC_PATHS.has(url.pathname) && !STATIC_ASSET_PATTERN.test(url.pathname)) return json({ error: '見つかりません。' }, 404);
        const origin = request.headers.get('Origin');
        if (api && ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site')) {
          throw new HttpError(403, 'このアクセス元からは利用できません。');
        }
        const user = await authenticate(request, env);
        if (url.pathname === '/api/config' && request.method === 'GET') return json({ ...backlogConfig(env), user });
        if (api) {
          const previewMatch = url.pathname.match(/^\/api\/clients\/([a-zA-Z0-9-]+)\/preview$/);
          if (previewMatch) {
            if (request.method !== 'POST') throw new HttpError(405, 'この操作には対応していません。');
            if (url.search) throw new HttpError(400, '取得条件が正しくありません。');
            const body = await readBody(request);
            if (Object.keys(body).some(key => !['from', 'to'].includes(key)) || !validDate(body.from) || !validDate(body.to) || body.from > body.to) throw new HttpError(400, '開始日・終了日を正しい日付で指定してください。');
            const current = await createStore(env.DB).get(previewMatch[1]);
            if (current.spaceUrl !== backlogConfig(env).spaceUrl) throw new HttpError(409, '接続先が変更されています。管理者に登録の更新を依頼してください。');
            const data = await getIssues(current.projectId, body.from, body.to, env);
            if (new TextEncoder().encode(JSON.stringify(data)).length > 1000000) throw new HttpError(422, '取得データが大きすぎます。期間を短くしてください。');
            const sum = list => Math.round(list.reduce((total, item) => total + (item.est ?? 0), 0) * 100) / 100;
            // カスタム期間は確認専用とし、月別設定・取得結果・更新番号を書き換えない。
            return json({ from: body.from, to: body.to, fetchedAt: new Date().toISOString(), confirmedHours: sum(data.confirmed), plannedHours: sum(data.planned), data });
          }
          const match = url.pathname.match(/^\/api\/clients(?:\/([a-zA-Z0-9-]+)(?:\/(history|months)(?:\/([a-zA-Z0-9-]+)(?:\/(fetch|additions))?)?)?)?$/);
          if (!match) throw new HttpError(404, '見つかりません。');
          const [, id, action, key, operation] = match;
          const method = request.method;
          if (url.search) throw new HttpError(400, '取得条件が正しくありません。');
          const store = createStore(env.DB);
          if (method === 'GET' && !action && !id) return json({ clients: await store.list() });
          if (method === 'GET' && action === 'history' && key && !operation) return json(await store.history(id, key));
          const monthly = action === 'months' && key;
          const fetching = monthly && operation === 'fetch' && method === 'POST';
          const adding = monthly && operation === 'additions' && method === 'POST';
          const monthSettings = monthly && !operation && method === 'PUT';
          const registration = !action && ((!id && method === 'POST') || (id && ['PUT', 'DELETE'].includes(method)));
          if (!registration && !fetching && !adding && !monthSettings) throw new HttpError(405, 'この操作には対応していません。');
          if (!fetching && !user.isAdmin) throw new HttpError(403, '登録・編集・削除には管理者権限が必要です。');
          const body = await readBody(request);
          const fields = fetching || method === 'DELETE' ? ['revision'] : adding ? ['revision', 'hours', 'memo'] : monthSettings ? ['revision', 'monthlyHours', 'carryOverHours'] : ['name', 'director', 'projectId', ...(id ? ['revision'] : [])];
          if (Object.keys(body).some(key => !fields.includes(key))) throw new HttpError(400, '指定できない項目が含まれています。');
          if (id && (!Number.isSafeInteger(body.revision) || body.revision < 1)) throw new HttpError(400, '更新番号が正しくありません。');
          if (method === 'DELETE') { await store.remove(id, body.revision); return json({ deleted: true }); }
          const current = id ? await store.get(id) : null;
          if (current && current.revision !== body.revision) throw new HttpError(409, '他の利用者が更新しました。「一覧を更新」してからやり直してください。');
          if (monthly) {
            const { from, to } = monthRange(key);
            if (monthSettings) return json(await store.saveMonth(id, body.revision, key, { settings: { monthlyHours: validateHours(body.monthlyHours), carryOverHours: validateHours(body.carryOverHours, true) } }, user.email));
            if (!current.months.some(m => m.month === key)) throw new HttpError(409, '先に対象月の月次工数と繰越工数を登録してください。');
            if (adding) {
              const hours = validateHours(body.hours);
              if (hours <= 0 || typeof body.memo !== 'string' || !body.memo.trim() || body.memo.trim().length > 1000) throw new HttpError(400, '追加工数は0より大きく、メモは1〜1000文字で入力してください。');
              return json(await store.saveMonth(id, body.revision, key, { addition: { hours, memo: body.memo.trim() } }, user.email));
            }
            const config = backlogConfig(env);
            if (current.spaceUrl !== config.spaceUrl) throw new HttpError(409, '接続先が変更されています。管理者に登録の更新を依頼してください。');
            const data = await getIssues(current.projectId, from, to, env);
            return json(await store.saveMonth(id, body.revision, key, { data }, user.email));
          }
          const config = backlogConfig(env);
          const settings = validateSettings(body);
          settings.projectId = await resolveProject(settings.projectId, env);
          settings.spaceUrl = config.spaceUrl;
          const changed = current && (current.projectId !== settings.projectId || current.spaceUrl !== settings.spaceUrl);
          const { history, months, revision, id: clientId, ...previous } = current || {};
          // 旧設定・旧履歴は移行資料として保全し、新方式の集計には使用しない。
          const saved = { ...previous, ...settings, updatedBy: user.email };
          return json(current ? await store.update(id, body.revision, saved, { clearMonthlyResults: changed }) : await store.add(saved), current ? 200 : 201);
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
