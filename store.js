export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function encode(value) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).length > 1000000) {
    throw new HttpError(422, '取得データが大きすぎます。集計期間を短くしてください。');
  }
  return body;
}

export function createStore(db) {
  if (!db) throw new HttpError(503, '共有データベースの設定が必要です。');
  const query = (sql, ...args) => db.prepare(sql).bind(...args);
  const decode = row => ({ ...JSON.parse(row.body), id: row.id, revision: row.revision });
  async function get(id) {
    const [rows, histories] = await db.batch([
      query('SELECT * FROM clients WHERE id = ?', id),
      query('SELECT id, summary FROM history WHERE client_id = ? ORDER BY period_from DESC, period_to DESC', id),
    ]);
    const row = rows.results[0];
    if (!row) throw new HttpError(404, '登録が見つかりません。一覧を更新してください。');
    return { ...decode(row), history: histories.results.map(h => ({ ...JSON.parse(h.summary), id: h.id })) };
  }

  function conflict(result) {
    if (!result.meta.changes) throw new HttpError(409, '他の利用者が更新しました。「一覧を更新」してからやり直してください。');
  }
  async function write(statements) {
    try { return await db.batch(statements); }
    catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: clients.space_url, clients.project_id')) {
        throw new HttpError(409, 'このプロジェクトは登録済みです。');
      }
      throw error;
    }
  }
  return {
    get,
    async list() {
      // 一覧の件数に比例して問い合わせが増えないよう、同じ時点の登録と履歴をまとめて読む。
      const [rows, histories] = await db.batch([
        query('SELECT * FROM clients ORDER BY rowid'),
        query('SELECT id, client_id, summary FROM history ORDER BY period_from DESC, period_to DESC'),
      ]);
      const byClient = new Map();
      for (const row of histories.results) {
        if (!byClient.has(row.client_id)) byClient.set(row.client_id, []);
        byClient.get(row.client_id).push({ ...JSON.parse(row.summary), id: row.id });
      }
      return rows.results.map(row => ({ ...decode(row), history: byClient.get(row.id) || [] }));
    },
    async add(body) {
      const id = crypto.randomUUID();
      await write([query('INSERT INTO clients (id, space_url, project_id, body, update_token) VALUES (?, ?, ?, ?, ?)',
        id, body.spaceUrl, body.projectId, encode(body), crypto.randomUUID())]);
      return get(id);
    },
    async update(id, revision, body, { clearHistory = false, snapshot = null } = {}) {
      const token = crypto.randomUUID();
      // 更新番号が一致した更新だけに履歴処理を結び付け、同じトランザクションで確定する。
      const statements = [query('UPDATE clients SET body = ?, space_url = ?, project_id = ?, revision = revision + 1, update_token = ? WHERE id = ? AND revision = ?',
        encode(body), body.spaceUrl, body.projectId, token, id, revision)];
      if (clearHistory) statements.push(query('DELETE FROM history WHERE client_id = ? AND EXISTS (SELECT 1 FROM clients WHERE id = ? AND update_token = ?)', id, id, token));
      if (snapshot) {
        const { data, ...summary } = snapshot;
        statements.push(query(`INSERT INTO history (id, client_id, period_from, period_to, summary, data)
          SELECT ?, id, ?, ?, ?, ? FROM clients WHERE id = ? AND update_token = ?
          ON CONFLICT(client_id, period_from, period_to) DO UPDATE SET summary = excluded.summary, data = excluded.data`,
        crypto.randomUUID(), snapshot.from, snapshot.to, encode(summary), encode(data), id, token));
      }
      const results = await write(statements);
      conflict(results[0]);
      return get(id);
    },
    async remove(id, revision) {
      conflict(await query('DELETE FROM clients WHERE id = ? AND revision = ?', id, revision).run());
    },
    async history(id, historyId) {
      const row = await query('SELECT * FROM history WHERE client_id = ? AND id = ?', id, historyId).first();
      if (!row) throw new HttpError(404, '履歴が見つかりません。');
      return { ...JSON.parse(row.summary), id: row.id, data: JSON.parse(row.data) };
    },
  };
}
