export async function requestApi(path, method = 'GET', data) {
  const response = await fetch(path, {
    credentials: 'same-origin', method,
    ...(data !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error('接続を確認できません。画面を再読み込みしてください。'); }
  if (!response.ok) throw new Error(body.error || '操作に失敗しました。');
  return body;
}
