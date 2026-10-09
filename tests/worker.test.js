import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createWorker } from '../worker.js';

const localEnv = {
  LOCAL_DEV: 'true',
  BACKLOG_API_KEY: 'test-only-secret-value',
  BACKLOG_SPACE_URL: 'https://example.backlog.com',
  BACKLOG_ALLOWED_PROJECTS: 'TEST, 123',
};
const query = '/api/backlog/issues?projectId=TEST&from=2026-08-01&to=2026-08-31';
const request = (path = query, init) => new Request('http://127.0.0.1:8787' + path, init);
const productionEnv = {
  ...localEnv, LOCAL_DEV: undefined,
  ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'dashboard-audience',
};
const statuses = [
  { id: 1, name: '未対応' }, { id: 2, name: '処理中' },
  { id: 3, name: '完了' }, { id: 4, name: '確認待ち' },
];
const types = [{ id: 10, name: '保守' }, { id: 11, name: '追加発注' }];
const issue = (status = '完了', overrides = {}) => ({
  issueKey: 'TEST-1', summary: '課題の表示確認', status: { name: status },
  issueType: types[0], estimatedHours: 4, actualHours: 2,
  privateField: '画面に不要な情報', ...overrides,
});

function fixtureWorker(pages = [[issue()]], options = {}) {
  const calls = [];
  const worker = createWorker({
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.pathname === '/api/v2/projects/TEST' || url.pathname === '/api/v2/projects/123') return Response.json({ id: 123 });
      if (url.pathname === '/api/v2/projects/123/statuses') return Response.json(statuses);
      if (url.pathname === '/api/v2/projects/123/issueTypes') return Response.json(types);
      if (url.pathname === '/api/v2/issues') return Response.json(pages[Number(url.searchParams.get('offset')) / 100] || []);
      throw new Error('想定外のURL: ' + url);
    },
  });
  return { worker, calls };
}

test('固定接続先へヘッダー認証し、分類・期間・発注除外と必要項目だけを維持する', async () => {
  const { worker, calls } = fixtureWorker([[
    issue('完了'), issue('処理中'), issue('未対応'), issue('確認待ち'),
    issue('完了', { issueType: types[1] }),
  ]]);
  const response = await worker.fetch(request(), localEnv);
  assert.equal(response.status, 200);
  const body = await response.json();
  for (const group of ['completed', 'inProgress', 'notStarted']) assert.equal(body[group].length, 1);
  assert.deepEqual(body.completed[0], {
    issueKey: 'TEST-1', summary: '課題の表示確認', status: '完了', type: '保守', est: 4, act: 2,
  });
  for (const { url, init } of calls) {
    assert.equal(url.origin, localEnv.BACKLOG_SPACE_URL);
    assert.equal(url.searchParams.has('apiKey'), false);
    assert.equal(init.headers['Backlog-API-Key'], localEnv.BACKLOG_API_KEY);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.Cookie, undefined);
  }
  const params = calls.at(-1).url.searchParams;
  assert.deepEqual(params.getAll('statusId[]'), ['1', '2', '3']);
  assert.deepEqual(params.getAll('issueTypeId[]'), ['10']);
  assert.deepEqual(params.getAll('projectId[]'), ['123']);
  assert.equal(params.get('updatedSince'), '2026-08-01');
  assert.equal(params.get('updatedUntil'), '2026-08-31');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(JSON.stringify(body).includes(localEnv.BACKLOG_API_KEY), false);
});

test('課題を100件ずつページングし、工数未設定は0にする', async () => {
  const { worker, calls } = fixtureWorker([Array.from({ length: 100 }, () => issue()), [issue('未対応', { estimatedHours: null, actualHours: null })]]);
  const response = await worker.fetch(request(), localEnv);
  const body = await response.json();
  assert.equal(body.completed.length, 100);
  assert.equal(body.notStarted[0].est, 0);
  assert.equal(body.notStarted[0].act, 0);
  assert.deepEqual(calls.filter(c => c.url.pathname.endsWith('/issues')).map(c => c.url.searchParams.get('offset')), ['0', '100']);
});

test('設定APIは接続先と許可プロジェクトのみ返す', async () => {
  const { worker, calls } = fixtureWorker();
  const response = await worker.fetch(request('/api/config'), localEnv);
  assert.deepEqual(await response.json(), { spaceUrl: localEnv.BACKLOG_SPACE_URL, projects: ['TEST', '123'] });
  assert.equal(calls.length, 0);
});

test('不正なプロジェクト・日付・追加パラメーターはBacklogへ送信しない', async () => {
  const { worker, calls } = fixtureWorker();
  const cases = [
    [query.replace('TEST', 'OTHER'), 403],
    [query.replace('TEST', '..%2Fusers'), 403],
    [query.replace('2026-08-01', '2026-02-30'), 400],
    [query.replace('2026-08-01', '2026-09-01'), 400],
    [query.replace('2026-08-01', 'invalid'), 400],
    [query + '&spaceUrl=https://attacker.example', 400],
    [query + '&apiKey=override', 400],
    [query + '&projectId=OTHER', 400],
  ];
  for (const [path, expected] of cases) assert.equal((await worker.fetch(request(path), localEnv)).status, expected, path);
  assert.equal(calls.length, 0);
});

test('設定不足とBacklog以外の接続先を拒否する', async () => {
  const { worker, calls } = fixtureWorker();
  const badConfigs = [
    { BACKLOG_API_KEY: '' }, { BACKLOG_ALLOWED_PROJECTS: '' }, { BACKLOG_ALLOWED_PROJECTS: '*' },
    ...['http://example.backlog.com', 'https://example.backlog.com.evil.test',
      'https://example.backlog.com/path', 'https://user:pass@example.backlog.com',
      'https://example.backlog.com:8443', 'https://example.backlog.com?x=1', ''].map(BACKLOG_SPACE_URL => ({ BACKLOG_SPACE_URL })),
  ];
  for (const config of badConfigs) assert.equal((await worker.fetch(request(), { ...localEnv, ...config })).status, 503);
  assert.equal(calls.length, 0);
});

test('接続エラー・上流エラー・リダイレクト・レート制限でキーや応答本文を露出しない', async () => {
  for (const code of [302, 401, 403, 429, 500, 'network', 'json']) {
    const worker = createWorker({ fetchImpl: async () => {
      if (code === 'network') throw new Error(localEnv.BACKLOG_API_KEY);
      if (code === 'json') return new Response(localEnv.BACKLOG_API_KEY);
      return new Response(localEnv.BACKLOG_API_KEY, { status: code });
    } });
    const response = await worker.fetch(request(), localEnv);
    assert.equal(response.status, code === 429 ? 429 : 502);
    assert.equal((await response.text()).includes(localEnv.BACKLOG_API_KEY), false);
  }
});

test('取得上限では不完全な集計を成功として返さない', async () => {
  const page = Array.from({ length: 100 }, () => issue());
  const { worker } = fixtureWorker(Array(100).fill(page));
  const response = await worker.fetch(request(), localEnv);
  assert.equal(response.status, 422);
});

test('本番はAccess未設定・未認証で閉じ、ローカル省略フラグも公開ホストでは無効', async () => {
  const { worker, calls } = fixtureWorker();
  const remote = new Request('https://dashboard.example.com' + query);
  assert.equal((await worker.fetch(remote, localEnv)).status, 503);
  assert.equal((await worker.fetch(remote, productionEnv)).status, 401);
  assert.equal((await worker.fetch(remote, { ...productionEnv, LOCAL_DEV: 'true' })).status, 401);
  assert.equal((await worker.fetch(request(), { ...localEnv, LOCAL_DEV: undefined })).status, 503);
  assert.equal(calls.length, 0);
});

test('Accessの署名・発行元・対象・有効期限を検証し、正常なJWTだけで取得できる', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const otherKey = await generateKeyPair('RS256');
  let certsUrl;
  const { worker, calls } = fixtureWorker(undefined, {
    jwksFactory: url => {
      certsUrl = url.href;
      return createLocalJWKSet({ keys: [publicJwk] });
    },
  });
  async function token({ issuer = productionEnv.ACCESS_TEAM_DOMAIN, aud = productionEnv.ACCESS_AUD, expires = '5m', key = privateKey } = {}) {
    return new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuedAt()
      .setSubject('test-user').setIssuer(issuer).setAudience(aud).setExpirationTime(expires).sign(key);
  }
  const remote = jwt => new Request('https://dashboard.example.com' + query, { headers: { 'Cf-Access-Jwt-Assertion': jwt } });
  for (const jwt of ['invalid', await token({ issuer: 'https://other.cloudflareaccess.com' }),
    await token({ aud: 'other-app' }), await token({ expires: '-1m' }), await token({ key: otherKey.privateKey })]) {
    assert.equal((await worker.fetch(remote(jwt), productionEnv)).status, 401);
  }
  assert.equal(calls.length, 0);
  assert.equal((await worker.fetch(remote(await token()), productionEnv)).status, 200);
  assert.equal(certsUrl, 'https://team.cloudflareaccess.com/cdn-cgi/access/certs');
});

test('他サイトからの呼び出しや更新操作は拒否する', async () => {
  const { worker, calls } = fixtureWorker();
  assert.equal((await worker.fetch(request(query, { headers: { Origin: 'https://other.example' } }), localEnv)).status, 403);
  assert.equal((await worker.fetch(request(query, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), localEnv)).status, 403);
  assert.equal((await worker.fetch(request(query, { method: 'POST' }), localEnv)).status, 405);
  assert.equal(calls.length, 0);
});

test('公開対象以外を配信せず、静的ファイルにも本番認証を適用する', async () => {
  let assetCalls = 0;
  const env = { ...localEnv, ASSETS: { fetch: async () => { assetCalls++; return new Response('<html>確認</html>', { headers: { 'Content-Type': 'text/html' } }); } } };
  const { worker } = fixtureWorker();
  for (const path of ['/.env', '/.env.example', '/worker.js', '/package.json', '/wrangler.jsonc', '/api/unknown']) {
    assert.equal((await worker.fetch(request(path), env)).status, 404);
  }
  assert.equal(assetCalls, 0);
  assert.equal((await worker.fetch(new Request('https://dashboard.example.com/'), { ...env, ...productionEnv })).status, 401);
  // 外部ページからの通常の画面遷移は、取得APIのクロスサイト制限と区別する。
  const response = await worker.fetch(request('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html>確認</html>');
  assert.equal(response.headers.get('Content-Type'), 'text/html');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(assetCalls, 1);
});

test('ビルド出力は公開用3ファイルだけで、.envはGit管理対象外', async () => {
  const root = new URL('../', import.meta.url);
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root });
  assert.deepEqual((await readdir(new URL('dist/', root))).sort(), ['index.html', 'script.js', 'style.css']);
  for (const file of ['index.html', 'script.js', 'style.css']) {
    assert.equal(await readFile(new URL('dist/' + file, root), 'utf8'), await readFile(new URL(file, root), 'utf8'));
  }
  assert.equal(execFileSync('git', ['check-ignore', '.env'], { cwd: root, encoding: 'utf8' }).trim(), '.env');
  const html = await readFile(new URL('index.html', root), 'utf8');
  const js = await readFile(new URL('script.js', root), 'utf8');
  assert.equal(html.includes('inputApiKey'), false);
  assert.equal(js.includes('BACKLOG_API_KEY'), false);
  assert.equal(js.includes('client.apiKey'), false);
});

// ブラウザ描画の代替ではなく、画面のイベントと取得APIとの接続を検証する。
async function loadFrontend(fetchImpl) {
  const elements = new Map();
  class Element {
    constructor() {
      this.value = ''; this.textContent = ''; this.style = {}; this.events = {};
      this.classList = { add() {}, remove() {} };
    }
    set innerHTML(value) {
      this.html = value;
      for (const match of value.matchAll(/id="([^"]+)"[^>]*?(?:value="([^"]*)")?[^>]*>/g)) {
        const element = new Element();
        element.id = match[1];
        element.value = match[2] || '';
        elements.set(element.id, element);
      }
    }
    get innerHTML() { return this.html || ''; }
    addEventListener(name, listener) { this.events[name] = listener; }
    querySelectorAll() { return []; }
    prepend(element) { elements.set(element.id, element); }
    remove() { elements.delete(this.id); }
  }
  const app = new Element();
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  app.innerHTML = html;
  const context = createContext({
    document: {
      getElementById: id => elements.get(id) || null,
      createElement: () => new Element(), querySelector: () => app,
    },
    fetch: fetchImpl, URLSearchParams, window: { scrollTo() {} },
    alert: message => { throw new Error(message); }, confirm: () => true,
    console, setTimeout, clearTimeout,
  });
  await runInContext(await readFile(new URL('../script.js', import.meta.url), 'utf8'), context);
  return { context, elements };
}

test('画面の登録からWorker取得・集計・履歴まで、キーを含めず連携する', async () => {
  const { worker } = fixtureWorker([[issue('完了'), issue('処理中'), issue('未対応')]]);
  const requests = [];
  const { context, elements } = await loadFrontend(async (path, init) => {
    requests.push({ path, init });
    return worker.fetch(request(path), localEnv);
  });
  assert.equal(elements.get('btnAddClient').disabled, false);
  elements.get('btnAddClient').events.click();
  elements.get('inputName').value = '<img src=x onerror=alert(1)>';
  elements.get('inputProjectId').value = 'TEST';
  elements.get('inputMonthly').value = '100';
  elements.get('btnSaveClient').events.click();
  elements.get('detailFrom').value = '2026-08-01';
  elements.get('detailTo').value = '2026-08-31';
  await elements.get('btnFetch').events.click();
  const state = JSON.parse(runInContext('JSON.stringify({ client: clients[0], totals: getClientTotals(clients[0]) })', context));
  assert.equal(state.client.synced, true);
  assert.equal(state.client.history.length, 1);
  assert.equal(state.totals.est, 8);
  assert.equal(state.totals.act, 4);
  assert.equal(state.totals.remaining, 88);
  assert.equal(state.totals.notStarted.count, 1);
  assert.equal(Object.hasOwn(state.client, 'apiKey'), false);
  assert.equal(requests.length, 2);
  const params = new URL(requests[1].path, 'http://localhost').searchParams;
  assert.deepEqual([...params.keys()], ['projectId', 'from', 'to']);
  assert.equal(elements.get('detailSection').innerHTML.includes('<img src=x'), false);
  assert.ok(elements.get('detailSection').innerHTML.includes('&lt;img'));
  assert.match(elements.get('fetchStatus').textContent, /実データを取得/);
  const stripped = runInContext('clientForStorage({ ...clients[0], apiKey: "old-secret" })', context);
  assert.equal(Object.hasOwn(stripped, 'apiKey'), false);
});

test('キー未設定時は画面に取得失敗を表示し、履歴に成功として記録しない', async () => {
  const { worker } = fixtureWorker();
  const { context, elements } = await loadFrontend(path => worker.fetch(request(path), { ...localEnv, BACKLOG_API_KEY: '' }));
  elements.get('btnAddClient').events.click();
  elements.get('inputName').value = '確認用';
  elements.get('inputProjectId').value = 'TEST';
  elements.get('btnSaveClient').events.click();
  elements.get('detailFrom').value = '2026-08-01';
  elements.get('detailTo').value = '2026-08-31';
  await elements.get('btnFetch').events.click();
  assert.match(elements.get('fetchStatus').textContent, /接続設定が未完了/);
  assert.equal(elements.get('btnFetch').disabled, false);
  assert.equal(runInContext('clients[0].synced', context), false);
  assert.equal(runInContext('clients[0].history.length', context), 0);
});
