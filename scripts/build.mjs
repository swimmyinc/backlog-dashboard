import { copyFile, mkdir, rm } from 'node:fs/promises';

// 公開対象を限定し、秘密情報やサーバーコードを配信しない。
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'style.css', 'script.js']) {
  await copyFile(new URL(file, root), new URL(file, output));
}
console.log('公開用のHTML・CSS・JavaScriptをdistへ出力しました。');
