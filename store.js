export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function encode(value) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).length > 1000000) {
    throw new HttpError(422, '取得データが大きすぎます。管理者に確認してください。');
  }
  return body;
}

export function createStore(db) {
  if (!db) throw new HttpError(503, '共有データベースの設定が必要です。');
  const query = (sql, ...args) => db.prepare(sql).bind(...args);
  const decode = row => ({ ...JSON.parse(row.body), id: row.id, revision: row.revision });
  // 金額ではなく時間を扱うが、小数の加算誤差を避けるため百分の一時間で集計する。
  const round = value => Math.round(value * 100) / 100;
  function monthView(row, additions, result) {
    const data = result ? JSON.parse(result.data) : { confirmed: [], planned: [] };
    const extraHours = round(additions.reduce((sum, item) => sum + item.hours, 0));
    const capacity = round(row.monthly_hours + row.carry_over_hours + extraHours);
    const confirmedHours = round(data.confirmed.reduce((sum, item) => sum + (item.est ?? 0), 0));
    const plannedHours = round(data.planned.reduce((sum, item) => sum + (item.est ?? 0), 0));
    const remaining = round(capacity - confirmedHours);
    return { month: row.month, monthlyHours: row.monthly_hours, carryOverHours: row.carry_over_hours,
      extraHours, additions, capacity, confirmedHours, plannedHours, remaining,
      plannedRemaining: round(remaining - plannedHours), synced: Boolean(result), data,
      fetchedAt: result?.fetched_at || null, fetchedBy: result?.fetched_by || null };
  }
  async function monthsFor(clientId = null) {
    const where = clientId ? ' WHERE client_id = ?' : '';
    const args = clientId ? [clientId] : [];
    const [months, additions, results] = await db.batch([
      query('SELECT * FROM client_months' + where + ' ORDER BY month DESC', ...args),
      query('SELECT * FROM additional_hours' + where + ' ORDER BY created_at, id', ...args),
      query('SELECT * FROM monthly_results' + where, ...args),
    ]);
    const grouped = new Map();
    for (const row of months.results) {
      if (!grouped.has(row.client_id)) grouped.set(row.client_id, []);
      grouped.get(row.client_id).push(monthView(row,
        additions.results.filter(a => a.client_id === row.client_id && a.month === row.month).map(a => ({ id: a.id, hours: a.hours, memo: a.memo, createdAt: a.created_at, createdBy: a.created_by })),
        results.results.find(r => r.client_id === row.client_id && r.month === row.month)));
    }
    return grouped;
  }
  async function get(id) {
    const [rows, histories] = await db.batch([
      query('SELECT * FROM clients WHERE id = ?', id),
      query('SELECT id, summary FROM history WHERE client_id = ? ORDER BY period_from DESC, period_to DESC', id),
    ]);
    const row = rows.results[0];
    if (!row) throw new HttpError(404, '登録が見つかりません。一覧を更新してください。');
    return { ...decode(row), months: (await monthsFor(id)).get(id) || [], history: histories.results.map(h => ({ ...JSON.parse(h.summary), id: h.id })) };
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
      const months = await monthsFor();
      return rows.results.map(row => ({ ...decode(row), months: months.get(row.id) || [], history: byClient.get(row.id) || [] }));
    },
    async add(body) {
      const id = crypto.randomUUID();
      await write([query('INSERT INTO clients (id, space_url, project_id, body, update_token) VALUES (?, ?, ?, ?, ?)',
        id, body.spaceUrl, body.projectId, encode(body), crypto.randomUUID())]);
      return get(id);
    },
    async update(id, revision, body, { clearHistory = false, clearMonthlyResults = false, snapshot = null } = {}) {
      const token = crypto.randomUUID();
      // 更新番号が一致した更新だけに履歴処理を結び付け、同じトランザクションで確定する。
      const statements = [query('UPDATE clients SET body = ?, space_url = ?, project_id = ?, revision = revision + 1, update_token = ? WHERE id = ? AND revision = ?',
        encode(body), body.spaceUrl, body.projectId, token, id, revision)];
      if (clearHistory) statements.push(query('DELETE FROM history WHERE client_id = ? AND EXISTS (SELECT 1 FROM clients WHERE id = ? AND update_token = ?)', id, id, token));
      if (clearMonthlyResults) statements.push(query('DELETE FROM monthly_results WHERE client_id = ? AND EXISTS (SELECT 1 FROM clients WHERE id = ? AND update_token = ?)', id, id, token));
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
    async saveMonth(id, revision, month, change, email) {
      const token = crypto.randomUUID();
      const now = new Date().toISOString();
      const guard = 'EXISTS (SELECT 1 FROM clients WHERE id = ? AND update_token = ?)';
      const statements = [query('UPDATE clients SET revision = revision + 1, update_token = ? WHERE id = ? AND revision = ?', token, id, revision)];
      if (change.settings) {
        statements.push(query(`INSERT INTO client_months (client_id, month, monthly_hours, carry_over_hours, updated_at, updated_by)
          SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}
          ON CONFLICT(client_id, month) DO UPDATE SET monthly_hours = excluded.monthly_hours, carry_over_hours = excluded.carry_over_hours, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        id, month, change.settings.monthlyHours, change.settings.carryOverHours, now, email, id, token));
      }
      if (change.addition) {
        statements.push(query(`INSERT INTO additional_hours (id, client_id, month, hours, memo, created_at, created_by)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        crypto.randomUUID(), id, month, change.addition.hours, change.addition.memo, now, email, id, token));
      }
      if (change.data) {
        statements.push(query(`INSERT INTO monthly_results (client_id, month, data, fetched_at, fetched_by)
          SELECT ?, ?, ?, ?, ? WHERE ${guard}
          ON CONFLICT(client_id, month) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at, fetched_by = excluded.fetched_by`,
        id, month, encode(change.data), now, email, id, token));
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
