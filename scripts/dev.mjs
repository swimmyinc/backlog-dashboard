import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const gatewayPort = Number(process.env.PORT || 8787);
const nextPort = Number(process.env.NEXT_DEV_PORT || 3000);
const apiPort = Number(process.env.API_DEV_PORT || 8789);
if ([gatewayPort, nextPort, apiPort].some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set([gatewayPort, nextPort, apiPort]).size !== 3) {
  throw new Error('開発用ポートには異なる1024〜65535の整数を指定してください。');
}
const wrangler = root + 'node_modules/wrangler/bin/wrangler.js';
const runtimeEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' };
const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'backlog-dashboard', '--local'], { cwd: root, stdio: 'inherit', env: runtimeEnv });
if (migration.error) throw migration.error;
if (migration.status !== 0) process.exit(migration.status || 1);

// 開発APIは既存のローカルD1を使う。Next.jsの配信は手前のゲートウェイへ分離する。
const original = JSON.parse(await readFile(root + 'wrangler.jsonc', 'utf8'));
const { build, assets, ...config } = original;
await mkdir(root + '.wrangler/dev-assets', { recursive: true });
await writeFile(root + '.wrangler/dev.config.json', JSON.stringify({
  ...config, main: root + 'worker.js',
  assets: { ...assets, directory: root + '.wrangler/dev-assets' },
  d1_databases: original.d1_databases.map(database => ({ ...database, migrations_dir: root + database.migrations_dir })),
}, null, 2));
const children = [];
let closing = false;
let server;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  server?.close();
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  const timer = setTimeout(() => process.exit(code), 1500);
  timer.unref();
  process.exitCode = code;
}
function start(args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: runtimeEnv });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!closing) stop(code || 1); });
}
start([wrangler, 'dev', '--config', root + '.wrangler/dev.config.json', '--env-file', root + '.env', '--local', '--var', 'LOCAL_DEV:true', '--ip', '127.0.0.1', '--port', String(apiPort), '--persist-to', root + '.wrangler/state', '--inspector-port', '0']);
start([root + 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(nextPort)]);

function upstream(request) {
  const api = request.url.startsWith('/api/');
  const port = api ? apiPort : nextPort;
  const headers = { ...request.headers, host: '127.0.0.1:' + port };
  // 同一オリジンの要求だけを転送先のOriginへ置換する。異なるOriginはWorkerが拒否する。
  if (headers.origin === 'http://' + request.headers.host) headers.origin = 'http://127.0.0.1:' + port;
  return { hostname: '127.0.0.1', port, path: request.url, method: request.method, headers };
}
function allowedHost(request) {
  return ['127.0.0.1:' + gatewayPort, 'localhost:' + gatewayPort].includes(request.headers.host);
}
server = http.createServer((request, response) => {
  if (!allowedHost(request)) { response.writeHead(403); response.end('許可されていないホストです。'); return; }
  const proxy = http.request(upstream(request), result => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  proxy.on('error', () => { if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('開発サーバーを準備中です。少し待って再読み込みしてください。'); });
  request.on('aborted', () => proxy.destroy());
  request.pipe(proxy);
});
// Next.jsの変更通知を転送し、ReactとSCSSの編集を再読み込みなしで反映する。
server.on('upgrade', (request, socket, head) => {
  if (!allowedHost(request) || request.url.startsWith('/api/') || (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host)) { socket.destroy(); return; }
  const proxy = http.request(upstream(request));
  proxy.on('upgrade', (response, target, targetHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
    if (head.length) target.write(head);
    if (targetHead.length) socket.write(targetHead);
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.pipe(target).pipe(socket);
  });
  proxy.on('error', () => socket.destroy());
  proxy.end();
});
server.on('error', error => { console.error(error.message); stop(1); });
server.listen(gatewayPort, '127.0.0.1', () => console.log('開発画面 http://127.0.0.1:' + gatewayPort));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
