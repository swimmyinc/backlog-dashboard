import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const result = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/next/dist/bin/next', root)), 'build'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

// Next.jsの公開出力だけを配信先へコピーし、ソースと秘密情報を混入させない。
const source = new URL('out/', root);
const output = new URL('dist/', root);
const files = await readdir(source, { recursive: true, withFileTypes: true });
for (const entry of files) {
  if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name.endsWith('.map')) throw new Error('公開出力に許可していないファイルが含まれています。');
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
console.log('Next.jsの静的出力をdistへ出力しました。');
