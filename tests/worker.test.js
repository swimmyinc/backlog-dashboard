import test, { before, after } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createStore } from '../store.js';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createWorker } from '../worker.js';

const localEnv = {
  LOCAL_DEV: 'true',
  BACKLOG_API_KEY: 'test-only-secret-value',
  BACKLOG_SPACE_URL: 'https://example.backlog.com',
  LOCAL_USER_EMAIL: 'admin@example.test', ADMIN_EMAILS: 'admin@example.test',
};
let mf;
let client;
let query;
const settings = { name: '確認用', director: '', projectId: '123', spaceUrl: localEnv.BACKLOG_SPACE_URL, monthlyHours: 100, carryOverHours: 0, extraHours: 0, from: '2026-08-01', to: '2026-08-31', synced: false, data: null };
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'test', modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }] }));
  localEnv.DB = await mf.getD1Database('DB');
  productionEnv.DB = localEnv.DB;
  const sql = (await Promise.all(['0001_initial.sql', '0002_monthly_hours.sql'].map(name => readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')))).join('\n');
  await localEnv.DB.batch(sql.split(';').filter(s => s.trim()).map(s => localEnv.DB.prepare(s)));
  client = await createStore(localEnv.DB).add(settings);
  client = await createStore(localEnv.DB).saveMonth(client.id, client.revision, '2026-08', { settings: { monthlyHours: 100, carryOverHours: 0 } }, 'admin@example.test');
  query = '/api/clients/' + client.id + '/months/2026-08/fetch';
});
after(async () => { await mf?.dispose(); });
const payloadRequest = (path, method, body, headers = {}) => new Request('http://127.0.0.1:8787' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const request = (path = query, init) => path === query && !init?.method ? payloadRequest(path, 'POST', { revision: client.revision }, init?.headers) : new Request('http://127.0.0.1:8787' + path, init);
async function fetchClient(worker, env = localEnv) {
  client = await createStore(localEnv.DB).get(client.id);
  return worker.fetch(request(), env);
}
const productionEnv = {
  ...localEnv, LOCAL_DEV: undefined,
  ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'dashboard-audience',
};
const statuses = [
  { id: 1, name: '未対応' }, { id: 2, name: '処理中' },
  { id: 3, name: '完了' }, { id: 4, name: '確認待ち' }, { id: 5, name: '処理済み' },
];
const types = [{ id: 10, name: '保守' }, { id: 11, name: '追加発注' }];
const issue = (status = '完了', overrides = {}) => ({
  issueKey: 'TEST-1', summary: '課題の表示確認', status: { name: status },
  issueType: types[0], estimatedHours: 4, actualHours: 2, startDate: '2026-08-15T00:00:00Z',
  privateField: '画面に不要な情報', ...overrides,
});

function fixtureWorker(pages = [[issue()]], options = {}) {
  const calls = [];
  const worker = createWorker({
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.pathname === '/api/v2/projects/456') return Response.json({ id: 456 });
      if (url.pathname === '/api/v2/projects/456/statuses') return Response.json(statuses);
      if (url.pathname === '/api/v2/projects/456/issueTypes') return Response.json(types);
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
    issue('完了'), issue('処理中'), issue('処理済み'), issue('未対応'), issue('確認待ち'),
    issue('完了', { startDate: null }), issue('完了', { startDate: '2026-07-31T00:00:00Z' }), issue('完了', { startDate: '2026-09-01T00:00:00Z' }),
    issue('完了', { issueType: types[1] }),
  ]]);
  const response = await fetchClient(worker);
  assert.equal(response.status, 200);
  const body = (await response.json()).months.find(m => m.month === '2026-08').data;
  assert.equal(body.confirmed.length, 3);
  assert.equal(body.planned.length, 1);
  assert.deepEqual(body.confirmed[0], {
    issueKey: 'TEST-1', summary: '課題の表示確認', status: '完了', type: '保守', est: 4, startDate: '2026-08-15',
  });
  for (const { url, init } of calls) {
    assert.equal(url.origin, localEnv.BACKLOG_SPACE_URL);
    assert.equal(url.searchParams.has('apiKey'), false);
    assert.equal(init.headers['Backlog-API-Key'], localEnv.BACKLOG_API_KEY);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.Cookie, undefined);
  }
  const params = calls.at(-1).url.searchParams;
  assert.deepEqual(params.getAll('statusId[]'), ['1', '2', '3', '5']);
  assert.deepEqual(params.getAll('issueTypeId[]'), ['10']);
  assert.deepEqual(params.getAll('projectId[]'), ['123']);
  assert.equal(params.get('startDateSince'), '2026-08-01');
  assert.equal(params.get('startDateUntil'), '2026-08-31');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(JSON.stringify(body).includes(localEnv.BACKLOG_API_KEY), false);
});

test('課題を100件ずつページングし、工数未入力はnullで保持する', async () => {
  const { worker, calls } = fixtureWorker([Array.from({ length: 100 }, () => issue()), [issue('未対応', { estimatedHours: null, actualHours: null })]]);
  const response = await fetchClient(worker);
  const body = (await response.json()).months.find(m => m.month === '2026-08').data;
  assert.equal(body.confirmed.length, 100);
  assert.equal(body.planned[0].est, null);
  assert.equal(Object.hasOwn(body.planned[0], 'act'), false);
  assert.deepEqual(calls.filter(c => c.url.pathname.endsWith('/issues')).map(c => c.url.searchParams.get('offset')), ['0', '100']);
});

test('設定APIは接続先と認証済みの利用者権限だけ返す', async () => {
  const { worker, calls } = fixtureWorker();
  const response = await worker.fetch(request('/api/config'), localEnv);
  assert.deepEqual(await response.json(), { spaceUrl: localEnv.BACKLOG_SPACE_URL, user: { email: 'admin@example.test', isAdmin: true } });
  assert.equal(calls.length, 0);
});

test('不正な日付・追加項目・未登録プロジェクトはBacklogへ送信しない', async () => {
  const { worker, calls } = fixtureWorker();
  client = await createStore(localEnv.DB).get(client.id);
  for (const extra of [{ from: '2026-02-30' }, { from: '2026-09-01' }, { from: 'invalid' }, { spaceUrl: 'https://evil.test' }, { apiKey: 'override' }, { projectId: 'OTHER' }]) {
    const res = await worker.fetch(payloadRequest(query, 'POST', { revision: client.revision, from: '2026-08-01', to: '2026-08-31', ...extra }), localEnv);
    assert.equal(res.status, 400);
  }
  assert.equal((await worker.fetch(payloadRequest('/api/clients/unknown/fetch', 'POST', { revision: 1, from: '2026-08-01', to: '2026-08-31' }), localEnv)).status, 404);
  assert.equal((await worker.fetch(request('/api/backlog/issues?projectId=OTHER'), localEnv)).status, 404);
  assert.equal(calls.length, 0);
});

test('設定不足とBacklog以外の接続先を拒否する', async () => {
  const { worker, calls } = fixtureWorker();
  const badConfigs = [
    { BACKLOG_API_KEY: '' },
    ...['http://example.backlog.com', 'https://example.backlog.com.evil.test',
      'https://example.backlog.com/path', 'https://user:pass@example.backlog.com',
      'https://example.backlog.com:8443', 'https://example.backlog.com?x=1', ''].map(BACKLOG_SPACE_URL => ({ BACKLOG_SPACE_URL })),
  ];
  for (const config of badConfigs) assert.equal((await fetchClient(worker, { ...localEnv, ...config })).status, 503);
  assert.equal(calls.length, 0);
});

test('接続エラー・上流エラー・リダイレクト・レート制限でキーや応答本文を露出しない', async () => {
  for (const code of [302, 401, 403, 429, 500, 'network', 'json']) {
    const worker = createWorker({ fetchImpl: async () => {
      if (code === 'network') throw new Error(localEnv.BACKLOG_API_KEY);
      if (code === 'json') return new Response(localEnv.BACKLOG_API_KEY);
      return new Response(localEnv.BACKLOG_API_KEY, { status: code });
    } });
    const response = await fetchClient(worker);
    assert.equal(response.status, code === 429 ? 429 : 502);
    assert.equal((await response.text()).includes(localEnv.BACKLOG_API_KEY), false);
  }
});

test('実Workersランタイムで通信設定を受け付け、転送先へキーを送らない', async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'request-validation', modules: true, compatibilityDate: '2026-10-09',
      script: `export default {
        async fetch(request) {
          const { url, init } = await request.json();
          try {
            const upstream = new Request(url, { ...init, signal: AbortSignal.timeout(30000) });
            return Response.json({ redirect: upstream.redirect });
          } catch {
            return new Response("通信設定が非対応です", { status: 500 });
          }
        }
      }`,
    }],
  }));
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      let calls = 0;
      const worker = createWorker({
        fetchImpl: async (url, init) => {
          calls++;
          assert.equal(url.origin, localEnv.BACKLOG_SPACE_URL);
          // 実際の通信オプションをworkerdのRequestで検証し、Nodeだけでは通る不具合を検出する。
          const { signal, ...options } = init;
          const validation = await runtime.dispatchFetch('http://localhost', {
            method: 'POST',
            body: JSON.stringify({ url: String(url), init: options }),
          });
          assert.equal(validation.status, 200);
          assert.equal((await validation.json()).redirect, 'manual');
          return new Response(localEnv.BACKLOG_API_KEY, {
            status,
            headers: { Location: 'https://unexpected.example/secret-destination' },
          });
        },
      });
      const response = await worker.fetch(payloadRequest('/api/clients', 'POST', {
        name: '転送拒否確認', director: '', projectId: 'REDIRECT',
      }), localEnv);
      assert.equal(response.status, 502);
      const body = await response.text();
      assert.match(body, /転送応答/);
      assert.equal(body.includes(localEnv.BACKLOG_API_KEY), false);
      assert.equal(body.includes('unexpected.example'), false);
      assert.equal(calls, 1);
    }
  } finally {
    await runtime.dispose();
  }
});

test('取得上限では不完全な集計を成功として返さない', async () => {
  const page = Array.from({ length: 100 }, () => issue());
  const { worker } = fixtureWorker(Array(100).fill(page));
  const response = await fetchClient(worker);
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
  async function token({ issuer = productionEnv.ACCESS_TEAM_DOMAIN, aud = productionEnv.ACCESS_AUD, expires = '5m', key = privateKey, email = 'admin@example.test' } = {}) {
    return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt()
      .setSubject('test-user').setIssuer(issuer).setAudience(aud).setExpirationTime(expires).sign(key);
  }
  const remote = jwt => new Request('https://dashboard.example.com/api/config', { headers: { 'Cf-Access-Jwt-Assertion': jwt } });
  for (const jwt of ['invalid', await token({ issuer: 'https://other.cloudflareaccess.com' }),
    await token({ aud: 'other-app' }), await token({ expires: '-1m' }), await token({ key: otherKey.privateKey })]) {
    assert.equal((await worker.fetch(remote(jwt), productionEnv)).status, 401);
  }
  assert.equal(calls.length, 0);
  assert.equal((await worker.fetch(remote(await token()), productionEnv)).status, 200);
  assert.equal(certsUrl, 'https://team.cloudflareaccess.com/cdn-cgi/access/certs');
  assert.equal((await worker.fetch(remote(await token({ email: null })), productionEnv)).status, 401);
  const memberRequest = remote(await token({ email: 'member@example.test' }));
  memberRequest.headers.set('Cf-Access-Authenticated-User-Email', 'admin@example.test');
  const member = await (await worker.fetch(memberRequest, productionEnv)).json();
  assert.equal(member.user.isAdmin, false);
  const admin = await (await worker.fetch(remote(await token()), productionEnv)).json();
  assert.equal(admin.user.isAdmin, true);

});

test('他サイトからの呼び出しや更新操作は拒否する', async () => {
  const { worker, calls } = fixtureWorker();
  assert.equal((await worker.fetch(request(query, { headers: { Origin: 'https://other.example' } }), localEnv)).status, 403);
  assert.equal((await worker.fetch(request(query, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), localEnv)).status, 403);
  assert.equal((await worker.fetch(request(query, { method: 'PUT' }), localEnv)).status, 405);
  assert.equal(calls.length, 0);
});

test('公開対象以外を配信せず、静的ファイルにも本番認証を適用する', async () => {
  let assetCalls = 0;
  const env = { ...localEnv, ASSETS: { fetch: async () => { assetCalls++; return new Response('<html>確認</html>', { headers: { 'Content-Type': 'text/html' } }); } } };
  const { worker } = fixtureWorker();
  for (const path of ['/.env', '/.env.example', '/worker.js', '/package.json', '/wrangler.jsonc', '/api/unknown', '/_next/server/app/page.js', '/_next/static/chunks/app.js.map', '/_next/static/.env', '/_next/static/chunks/%2eenv.js']) {
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

test('Next.jsの静的出力だけを配信し、秘密情報とソースを混入させない', async () => {
  const root = new URL('../', import.meta.url);
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root });
  const files = await readdir(new URL('dist/', root), { recursive: true });
  assert.ok(files.includes('index.html'));
  assert.ok(files.some(file => file.startsWith('_next/static/') && file.endsWith('.js')));
  assert.ok(files.some(file => file.startsWith('_next/static/') && file.endsWith('.css')));
  assert.ok(!files.some(file => /(^|\/)(?:\.env|worker\.js|store\.js|package\.json|wrangler\.jsonc)|\.map$/.test(file)));
  assert.equal(execFileSync('git', ['check-ignore', '.env'], { cwd: root, encoding: 'utf8' }).trim(), '.env');
  const { worker } = fixtureWorker();
  const env = { ...localEnv, ASSETS: { fetch: async () => new Response('公開用データ') } };
  for (const file of files.filter(file => /\.(?:html|js|css|txt)$/.test(file))) {
    const response = await worker.fetch(request('/' + file), env);
    assert.equal(response.status, 200, file);
    const content = await readFile(new URL('dist/' + file, root), 'utf8');
    assert.equal(content.includes('BACKLOG_API_KEY'), false, file);
    assert.equal(content.includes(localEnv.BACKLOG_API_KEY), false, file);
  }
});

test('対象月・月別工数・追加メモを検証し、不正な登録を保存しない', async () => {
  const { worker, calls } = fixtureWorker();
  const c = await createStore(localEnv.DB).get(client.id);
  const base = '/api/clients/' + c.id + '/months/';
  for (const month of ['2026-13', '2026-00', 'invalid']) {
    assert.equal((await worker.fetch(payloadRequest(base + month, 'PUT', { revision: c.revision, monthlyHours: 10, carryOverHours: 0 }), localEnv)).status, 400);
  }
  for (const values of [{monthlyHours:-1,carryOverHours:0}, {monthlyHours:null,carryOverHours:0}, {monthlyHours:10,carryOverHours:100001}]) {
    assert.equal((await worker.fetch(payloadRequest(base + '2026-09', 'PUT', { revision:c.revision,...values }), localEnv)).status, 400);
  }
  for (const addition of [{hours:0,memo:'見積'}, {hours:1,memo:''}, {hours:1,memo:'x'.repeat(1001)}]) {
    assert.equal((await worker.fetch(payloadRequest(base + '2026-08/additions', 'POST', {revision:c.revision,...addition}), localEnv)).status, 400);
  }
  assert.equal((await worker.fetch(payloadRequest(base + '2026-09/fetch', 'POST', { revision:c.revision }), localEnv)).status, 409);
  assert.equal(calls.length, 0);
});

test('状態変更は予定から確定へ移し、予定残工数を維持する', async () => {
  const first = fixtureWorker([[issue('未対応', {estimatedHours:3,actualHours:999})]]).worker;
  const before = (await (await fetchClient(first)).json()).months.find(m => m.month === '2026-08');
  for (const status of ['処理中', '処理済み', '完了']) {
    const next = fixtureWorker([[issue(status, {estimatedHours:3,actualHours:999})]]).worker;
    const after = (await (await fetchClient(next)).json()).months.find(m => m.month === '2026-08');
    assert.equal(after.remaining, before.remaining - 3);
    assert.equal(after.plannedRemaining, before.plannedRemaining);
    assert.equal(after.plannedHours, 0);
    assert.equal(after.confirmedHours, 3);
  }
});

test('閏月の末日を含め、翌月の開始日は集計しない', async () => {
  const store = createStore(localEnv.DB);
  let c = await store.get(client.id);
  c = await store.saveMonth(c.id, c.revision, '2028-02', {settings:{monthlyHours:10,carryOverHours:0}}, 'admin');
  const {worker,calls} = fixtureWorker([[issue('処理済み',{startDate:'2028-02-29T00:00:00Z',estimatedHours:2}),issue('未対応',{startDate:'2028-03-01T00:00:00Z',estimatedHours:7})]]);
  const response = await worker.fetch(payloadRequest('/api/clients/'+c.id+'/months/2028-02/fetch','POST',{revision:c.revision}),localEnv);
  assert.equal(response.status,200);
  const month = (await response.json()).months.find(m=>m.month==='2028-02');
  assert.equal(month.confirmedHours,2);
  assert.equal(month.plannedHours,0);
  assert.equal(month.remaining,8);
  assert.equal(calls.at(-1).url.searchParams.get('startDateUntil'),'2028-02-29');
});

test('一般利用者のカスタム集計は月をまたぎ、DBと更新番号を変更しない', async () => {
  const store = createStore(localEnv.DB);
  const before = await store.get(client.id);
  const {worker,calls} = fixtureWorker([[
    issue('完了',{startDate:'2030-01-31T00:00:00Z',estimatedHours:3,actualHours:999}),
    issue('処理済み',{startDate:'2030-02-01T00:00:00Z',estimatedHours:2}),
    issue('未対応',{startDate:'2030-02-15T00:00:00Z',estimatedHours:4}),
    issue('完了',{startDate:'2030-02-16T00:00:00Z'}),
    issue('処理中',{startDate:null}),
  ]]);
  const response = await worker.fetch(payloadRequest('/api/clients/'+client.id+'/preview','POST',{from:'2030-01-31',to:'2030-02-15'}),{...localEnv,LOCAL_USER_EMAIL:'member@example.test'});
  assert.equal(response.status,200);
  const result = await response.json();
  assert.equal(result.confirmedHours,5);
  assert.equal(result.plannedHours,4);
  assert.equal(result.data.confirmed.length,2);
  assert.equal(result.from,'2030-01-31');
  assert.equal(result.to,'2030-02-15');
  assert.equal(Object.hasOwn(result,'remaining'),false);
  assert.equal(calls.at(-1).url.searchParams.get('startDateSince'),'2030-01-31');
  assert.equal(calls.at(-1).url.searchParams.get('startDateUntil'),'2030-02-15');
  assert.deepEqual(await store.get(client.id),before);
});

test('カスタム取得の不正日付・未登録クライアント・余分な入力を拒否する', async () => {
  const {worker,calls} = fixtureWorker();
  const path='/api/clients/'+client.id+'/preview';
  for (const body of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-09-01',to:'2026-08-01'},{from:'',to:''},{from:'2026-08-01',to:'2026-08-31',projectId:'OTHER'}]) {
    assert.equal((await worker.fetch(payloadRequest(path,'POST',body),localEnv)).status,400);
  }
  assert.equal((await worker.fetch(request(path),localEnv)).status,405);
  assert.equal((await worker.fetch(payloadRequest('/api/clients/unknown/preview','POST',{from:'2026-08-01',to:'2026-08-31'}),localEnv)).status,404);
  assert.equal(calls.length,0);
});


test('Next.jsのチャンクにもAccess認証と許可メソッドを適用する', async () => {
  let assetCalls = 0;
  const assetPath = '/_next/static/chunks/dashboard-123.js';
  const env = { ...localEnv, ASSETS: { fetch: async () => { assetCalls++; return new Response('確認'); } } };
  const { worker } = fixtureWorker();
  assert.equal((await worker.fetch(new Request('https://dashboard.example.com' + assetPath), { ...env, ...productionEnv })).status, 401);
  assert.equal(assetCalls, 0);
  assert.equal((await worker.fetch(request(assetPath, { method: 'POST' }), env)).status, 405);
  assert.equal(assetCalls, 0);
  assert.equal((await worker.fetch(request(assetPath), env)).status, 200);
  assert.equal(assetCalls, 1);
});

test('未入力と入力済み0時間を区別して保存し、月別・カスタムの集計値を維持する', async () => {
  const { worker } = fixtureWorker([[
    issue('完了', { estimatedHours: null }),
    issue('処理済み', { estimatedHours: 0 }),
    issue('処理中', { estimatedHours: 3 }),
    issue('未対応', { estimatedHours: null }),
    issue('未対応', { estimatedHours: 0 }),
    issue('未対応', { estimatedHours: 4 }),
  ]]);
  const response = await fetchClient(worker);
  assert.equal(response.status, 200);
  const month = (await response.json()).months.find(item => item.month === '2026-08');
  assert.deepEqual(month.data.confirmed.map(item => item.est), [null, 0, 3]);
  assert.deepEqual(month.data.planned.map(item => item.est), [null, 0, 4]);
  assert.equal(month.confirmedHours, 3);
  assert.equal(month.plannedHours, 4);
  assert.equal(month.remaining, month.capacity - 3);
  assert.equal(month.plannedRemaining, month.capacity - 7);
  const saved = await createStore(localEnv.DB).get(client.id);
  assert.equal(saved.months.find(item => item.month === '2026-08').data.confirmed[0].est, null);
  const preview = await worker.fetch(payloadRequest('/api/clients/' + client.id + '/preview', 'POST', { from: '2026-08-01', to: '2026-08-31' }), localEnv);
  const result = await preview.json();
  assert.equal(result.confirmedHours, 3);
  assert.equal(result.plannedHours, 4);
  assert.deepEqual(result.data.confirmed.map(item => item.est), [null, 0, 3]);
  assert.deepEqual(await createStore(localEnv.DB).get(client.id), saved);
});
