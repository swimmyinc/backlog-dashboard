import React, { StrictMode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
// D1の通信に使うNode.jsのURL・Fetchは維持し、描画に必要なDOMだけを用意する。
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8787' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react/pure');
const { default: userEvent } = await import('@testing-library/user-event');
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createStore } from '../store.js';
import { createWorker } from '../worker.js';
import Dashboard from '../components/Dashboard.jsx';

let mf, store, env, client, worker, fetchMock;
const sampleIssues = ['完了', '処理中', '処理済み', '未対応'].map((status, index) => ({
  issueKey: 'TEST-' + index, summary: '課題' + index, status: { name: status },
  issueType: { id: 10, name: '保守' }, estimatedHours: 4, actualHours: 100,
  startDate: '2026-08-15T00:00:00Z',
}));
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'ui-test', modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }] }));
  const DB = await mf.getD1Database('DB');
  for (const file of ['0001_initial.sql', '0002_monthly_hours.sql']) {
    const sql = await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8');
    await DB.batch(sql.split(';').filter(part => part.trim()).map(part => DB.prepare(part)));
  }
  env = { DB, LOCAL_DEV: 'true', LOCAL_USER_EMAIL: 'admin@example.test', ADMIN_EMAILS: 'admin@example.test', BACKLOG_SPACE_URL: 'https://example.backlog.com', BACKLOG_API_KEY: 'test-only-secret' };
  store = createStore(DB);
});
afterAll(async () => { await mf?.dispose(); dom.window.close(); });
beforeEach(async () => {
  for (const item of await store.list()) await store.remove(item.id, item.revision);
  client = await store.add({ name: 'テスト顧客', director: '担当A', projectId: '123', spaceUrl: env.BACKLOG_SPACE_URL });
  client = await store.saveMonth(client.id, client.revision, '2026-08', { settings: { monthlyHours: 100, carryOverHours: 10 } }, 'admin');
  worker = createWorker({ fetchImpl: async url => {
    if (url.pathname.endsWith('/statuses')) return Response.json(['未対応', '処理中', '処理済み', '完了'].map((name, id) => ({ name, id })));
    if (url.pathname.endsWith('/issueTypes')) return Response.json([{ id: 10, name: '保守' }]);
    if (url.pathname.endsWith('/issues')) return Response.json(sampleIssues);
    return Response.json({ id: Number(url.pathname.split('/').at(-1)) || 456 });
  } });
  env.LOCAL_USER_EMAIL = 'admin@example.test';
  env.BACKLOG_API_KEY = 'test-only-secret';
  fetchMock = vi.fn((path, init) => worker.fetch(new Request('http://127.0.0.1:8787' + path, init), env));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function openDashboard() {
  render(<StrictMode><Dashboard /></StrictMode>);
  await screen.findByRole('button', { name: '詳細を見る' });
  await selectMonth('一覧の対象月', '2026-08');
}
async function openDetail() {
  await openDashboard();
  await userEvent.click(screen.getByRole('button', { name: '詳細を見る' }));
}
const click = name => userEvent.click(screen.getByRole('button', { name, exact: true }));
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function selectMonth(label, value) {
  await click(label);
  const picker = screen.getByRole('group', { name: '月を選択' });
  const targetYear = Number(value.slice(0, 4));
  let year = Number(picker.querySelector('strong').textContent.replace('年', ''));
  while (year !== targetYear) { await click(year < targetYear ? '翌年' : '前年'); year += year < targetYear ? 1 : -1; }
  await click(value.replace('-', '年') + '月');
}
const savedMonth = async () => (await store.get(client.id)).months.find(item => item.month === '2026-08');
async function fetchMonth() {
  await click('↻ Backlogから取り込み');
  await screen.findByText('対象月の課題を取得しました。');
}

test('React画面から月別設定・追加・取得を行い、予定時間だけで集計する', async () => {
  await openDetail();
  change('月次工数（h）', '100'); change('繰越工数（h）', '10');
  await click('月別設定を更新');
  await screen.findByText('月別工数を保存しました。');
  await userEvent.click(screen.getByText('追加工数を入力', { exact: true }));
  change('追加する工数（h）', '5'); change('メモ（必須）', '<img src=x>追加見積');
  await click('＋ 追加工数を記録');
  await screen.findByText('追加工数を記録しました。');
  await fetchMonth();
  const month = await savedMonth();
  expect(month).toMatchObject({ capacity: 115, confirmedHours: 12, plannedHours: 4, remaining: 103, plannedRemaining: 99, synced: true });
  expect(month.additions).toHaveLength(1);
  expect(within(screen.getByRole('region', { name: '表示中の月' })).getByText('103h')).toBeTruthy();
  expect(document.querySelector('img')).toBeNull();
  expect(fetchMock.mock.calls.some(([, init]) => init.body?.includes('apiKey'))).toBe(false);
  await selectMonth('詳細の対象月', '2026-09');
  expect(screen.getByRole('button', { name: 'この月を登録' })).toBeTruthy();
  await selectMonth('詳細の対象月', '2026-08');
  expect(within(screen.getByRole('region', { name: '表示中の月' })).getByText('103h')).toBeTruthy();
});

test('一般利用者は取得と履歴閲覧ができ、管理入力は表示しない', async () => {
  env.LOCAL_USER_EMAIL = 'member@example.test';
  await openDetail();
  expect(screen.queryByRole('button', { name: '＋ クライアントを追加' })).toBeNull();
  expect(screen.queryByLabelText('月次工数（h）')).toBeNull();
  expect(screen.queryByText('追加工数を入力', { exact: true })).toBeNull();
  expect(screen.getByText('追加履歴', { exact: false })).toBeTruthy();
  await fetchMonth();
  expect((await savedMonth()).fetchedBy).toBe('member@example.test');
});

test('取得失敗では保存値を保ち、エラー表示後に再操作できる', async () => {
  await openDetail();
  await fetchMonth();
  const before = await savedMonth();
  env.BACKLOG_API_KEY = '';
  await click('↻ Backlogから取り込み');
  expect((await screen.findByRole('alert')).textContent).toMatch(/接続設定が未完了/);
  expect(await savedMonth()).toEqual(before);
  expect(screen.getByRole('button', { name: '↻ Backlogから取り込み' }).disabled).toBe(false);
});

test('カスタム期間は課題と確定・予定だけを表示し、月別データを変更しない', async () => {
  await openDetail();
  const before = await store.get(client.id);
  await click('カスタム期間');
  expect(screen.queryByLabelText('月次工数（h）')).toBeNull();
  expect(within(screen.getByRole('main')).queryByText('予定残工数')).toBeNull();
  change('開始日', '2026-08-10'); change('終了日', '2026-09-10');
  await click('↻ この期間で取得');
  const summary = screen.getByRole('region', { name: 'カスタム期間の集計' });
  await within(summary).findByText('12h');
  expect(within(summary).getByText('4h')).toBeTruthy();
  expect(await store.get(client.id)).toEqual(before);
  await click('月');
  expect(screen.getByLabelText('月次工数（h）').value).toBe('100');
  await click('カスタム期間');
  expect(screen.queryByText('12h')).toBeNull();
});

test('カスタム取得中の移動で遅い応答を無視し、二重送信もしない', async () => {
  let complete;
  fetchMock.mockImplementation((path, init) => path.endsWith('/preview') ? new Promise(resolve => { complete = resolve; }) : worker.fetch(new Request('http://127.0.0.1:8787' + path, init), env));
  await openDetail();
  await click('カスタム期間');
  await userEvent.dblClick(screen.getByRole('button', { name: '↻ この期間で取得' }));
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/preview'))).toHaveLength(1);
  await click('月');
  await act(async () => { complete(Response.json({ confirmedHours: 999, plannedHours: 999, data: { confirmed: [], planned: [] } })); });
  expect(screen.getByLabelText('月次工数（h）')).toBeTruthy();
  expect(screen.queryByText('999h')).toBeNull();
  expect(screen.getByRole('button', { name: '一覧を更新' }).disabled).toBe(false);
});

test('表示中の月を除く登録済み月を過去から未来へ並べる', async () => {
  client = await store.saveMonth(client.id, client.revision, '2026-09', { settings: { monthlyHours: 25, carryOverHours: 0 } }, 'admin');
  client = await store.saveMonth(client.id, client.revision, '2026-07', { settings: { monthlyHours: 25, carryOverHours: 0 } }, 'admin');
  await openDetail();
  const other = screen.getByRole('region', { name: 'ほかの月' });
  expect(within(other).getAllByRole('button').map(button => button.textContent.slice(0, 8))).toEqual(['2026年07月', '2026年09月']);
  expect(within(other).queryByText('2026年08月')).toBeNull();
});

test('一覧の検索と担当者絞り込みを維持し、カードに予定残工数を表示しない', async () => {
  await store.add({ name: '別の顧客', director: '担当B', projectId: '456', spaceUrl: env.BACKLOG_SPACE_URL });
  render(<Dashboard />);
  await screen.findByText('担当: 担当B');
  change('クライアント名で検索', '別の');
  expect(screen.getAllByRole('article')).toHaveLength(1);
  change('クライアント名で検索', '');
  change('担当者で絞り込み', '担当A');
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('article').textContent).toContain('テスト顧客');
  expect(screen.getByRole('article').textContent).not.toContain('予定残工数');
});

test('クライアントの登録・編集・削除と確認キャンセルを引き継ぐ', async () => {
  await openDashboard();
  await click('＋ クライアントを追加');
  change('クライアント名', '<img src=x onerror=alert(1)>'); change('担当者', '担当C'); change('プロジェクトID(またはキー)', '456');
  await click('登録する');
  await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>', level: 1 });
  expect(document.querySelector('img')).toBeNull();
  await click('基本情報'); change('クライアント名', '変更後の顧客'); await click('更新する');
  await screen.findByRole('heading', { name: '変更後の顧客', level: 1 });
  await click('基本情報');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await click('クライアントを削除');
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(await store.list()).toHaveLength(2);
  confirm.mockReturnValue(true);
  await click('クライアントを削除');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(await store.list()).toHaveLength(1);
});

test('更新競合では入力を保持してエラーを示し、再読み込みで最新値を取得する', async () => {
  await openDetail();
  await store.saveMonth(client.id, client.revision, '2026-08', { settings: { monthlyHours: 80, carryOverHours: 0 } }, 'other');
  change('月次工数（h）', '200');
  await click('月別設定を更新');
  await screen.findByRole('alert');
  expect(screen.getByLabelText('月次工数（h）').value).toBe('200');
  expect((await savedMonth()).monthlyHours).toBe(80);
  await click('一覧を更新');
  await waitFor(() => expect(screen.getByLabelText('月次工数（h）').value).toBe('80'));
});

test('旧履歴の保存値と旧実績を参照できる', async () => {
  const original = await store.get(client.id);
  const { months, history, id, revision, ...body } = original;
  await store.update(id, revision, body, { snapshot: { from: '2026-07-01', to: '2026-07-31', capacity: 100, est: 3, act: 2, remaining: 95, data: { completed: [{ issueKey: 'OLD-1', summary: '旧課題', status: '完了', type: '保守', est: 3, act: 2 }] } } });
  await openDetail();
  await userEvent.click(screen.getByText('旧方式の設定・履歴（新しい月別集計の対象外）'));
  await userEvent.click(screen.getByRole('button', { name: /2026-07-01 〜 2026-07-31/ }));
  await screen.findByRole('heading', { name: '旧課題' });
  expect(screen.getByRole('link', { name: '旧課題' }).getAttribute('href')).toBe('https://example.backlog.com/view/OLD-1');
  expect(screen.getByText(/旧使用可能 100h/).textContent).toContain('旧残工数 95h');
});

test.each(['月', 'カスタム期間'])('%sで入力済み0時間と未入力を分け、グループを初期状態から開閉する', async mode => {
  const issues = [
    { ...sampleIssues[0], issueKey: 'ZERO-C', summary: '確定の0時間', estimatedHours: 0 },
    { ...sampleIssues[1], issueKey: 'EMPTY-C', summary: '確定の未入力', estimatedHours: null },
    { ...sampleIssues[2], issueKey: 'SET-C', summary: '確定の入力済み', estimatedHours: 3 },
    { ...sampleIssues[3], issueKey: 'ZERO-P', summary: '予定の0時間', estimatedHours: 0 },
    { ...sampleIssues[3], issueKey: 'EMPTY-P', summary: '予定の未入力', estimatedHours: null },
    { ...sampleIssues[3], issueKey: 'SET-P', summary: '予定の入力済み', estimatedHours: 4 },
  ];
  worker = createWorker({ fetchImpl: async url => {
    if (url.pathname.endsWith('/statuses')) return Response.json(['未対応', '処理中', '処理済み', '完了'].map((name, id) => ({ name, id })));
    if (url.pathname.endsWith('/issueTypes')) return Response.json([{ id: 10, name: '保守' }]);
    return Response.json(issues);
  } });
  await openDetail();
  if (mode === 'カスタム期間') {
    await click(mode);
    await click('↻ この期間で取得');
    await within(screen.getByRole('region', { name: 'カスタム期間の集計' })).findByText('3h');
  } else await fetchMonth();
  const confirmed = screen.getByRole('region', { name: '確定工数の課題' });
  const planned = screen.getByRole('region', { name: '予定工数の課題' });
  const missing = screen.getByRole('region', { name: '工数未入力の課題' });
  expect(within(confirmed).getByRole('button').getAttribute('aria-expanded')).toBe('true');
  expect(within(planned).getByRole('button').getAttribute('aria-expanded')).toBe('true');
  expect(within(missing).getByRole('button').getAttribute('aria-expanded')).toBe('false');
  expect(within(confirmed).getAllByRole('listitem')).toHaveLength(2);
  expect(within(planned).getAllByRole('listitem')).toHaveLength(2);
  expect(within(confirmed).getByText('確定の0時間')).toBeTruthy();
  expect(within(planned).getByText('予定の0時間')).toBeTruthy();
  expect(within(confirmed).queryByText('確定の未入力')).toBeNull();
  expect(within(planned).queryByText('予定の未入力')).toBeNull();
  expect(within(missing).queryByRole('list')).toBeNull();
  expect(within(missing).getByRole('button').textContent).toContain('2件');
  expect(within(missing).getByRole('button').textContent).not.toContain('合計');
  await click('工数未入力の課題');
  expect(within(missing).getAllByRole('listitem')).toHaveLength(2);
  expect(within(missing).getAllByText('未入力', { exact: true })).toHaveLength(2);
  await click('確定工数');
  expect(within(confirmed).queryByRole('list')).toBeNull();
  await click('予定工数');
  expect(within(planned).queryByRole('list')).toBeNull();
  within(planned).getByRole('button').focus();
  await userEvent.keyboard('{Enter}');
  expect(within(planned).getAllByRole('listitem')).toHaveLength(2);
  if (mode === '月') {
    await selectMonth('詳細の対象月', '2026-09');
    await selectMonth('詳細の対象月', '2026-08');
  } else {
    change('開始日', '2026-08-02');
  }
  expect(screen.getByRole('button', { name: '確定工数', exact: true }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: '工数未入力の課題', exact: true }).getAttribute('aria-expanded')).toBe('false');
});


test('月選択は入力なしで年またぎの移動と選択、Escape・外側クリックでの終了ができる', async () => {
  await openDetail();
  expect(document.querySelector('input[type="month"]')).toBeNull();
  await selectMonth('詳細の対象月', '2026-12');
  await click('次月');
  expect(screen.getByRole('button', { name: '詳細の対象月' }).textContent).toContain('2027年01月');
  await click('前月');
  expect(screen.getByRole('button', { name: '詳細の対象月' }).textContent).toContain('2026年12月');
  await click('詳細の対象月');
  await click('前年');
  await click('2025年03月');
  expect(screen.getByRole('button', { name: '詳細の対象月' }).textContent).toContain('2025年03月');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '詳細の対象月' }));
  await userEvent.keyboard('{Enter}');
  expect(document.activeElement.getAttribute('aria-label')).toBe('2025年03月');
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('group', { name: '月を選択' })).toBeNull();
  await click('詳細の対象月');
  await userEvent.click(screen.getByRole('heading', { name: 'テスト顧客', level: 1 }));
  expect(screen.queryByRole('group', { name: '月を選択' })).toBeNull();
  expect(screen.getByRole('button', { name: '詳細の対象月' }).textContent).toContain('2025年03月');
});

test.each(['月', 'カスタム期間'])('%sの課題タイトルがBacklogの別タブリンクになり、工数に単位を付ける', async mode => {
  await openDetail();
  if (mode === '月') await fetchMonth();
  else {
    await click(mode);
    await click('↻ この期間で取得');
    await screen.findByRole('link', { name: '課題0' });
  }
  for (let i = 0; i < 4; i++) {
    const link = screen.getByRole('link', { name: '課題' + i });
    expect(link.getAttribute('href')).toBe('https://example.backlog.com/view/TEST-' + i);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const row = link.closest('li');
    expect(row.textContent).toContain('予定時間 4h');
    expect(row.querySelector('input')).toBeNull();
  }
});


test.each([
  ['正の残工数', '2026-08', '2026-09', 10.5, 0, true, '10.5', true],
  ['残工数0', '2026-08', '2026-09', 10, 10, true, '0', true],
  ['負の残工数', '2026-08', '2026-09', 10, 12, true, '0', false],
  ['未取得', '2026-08', '2026-09', 10, 0, false, '0', false],
  ['直前の月なし', '2026-08', '2026-10', 10, 0, true, '0', false],
  ['年またぎ', '2026-12', '2027-01', 20.25, 3, true, '17.25', true],
])('繰越初期値：%s', async (_, previous, target, monthlyHours, confirmed, synced, expected, hint) => {
  client = await store.saveMonth(client.id, client.revision, previous, { settings: { monthlyHours, carryOverHours: 0 } }, 'admin');
  if (synced) client = await store.saveMonth(client.id, client.revision, previous, { data: { confirmed: [{ est: confirmed }], planned: [{ est: 4 }] } }, 'admin');
  const before = await store.get(client.id);
  await openDetail();
  await selectMonth('詳細の対象月', target);
  expect(screen.getByLabelText('繰越工数（h）').value).toBe(expected);
  expect(Boolean(screen.queryByText(/を初期値にしています/))).toBe(hint);
  expect(await store.get(client.id)).toEqual(before);
});

test('繰越初期値を手動で0に変更して保存し、前月が変わっても保存値を維持する', async () => {
  await openDetail();
  await fetchMonth();
  await click('次月');
  expect(screen.getByLabelText('繰越工数（h）').value).toBe('98');
  change('月次工数（h）', '25');
  change('繰越工数（h）', '0');
  await click('この月を登録');
  await screen.findByText('月別工数を保存しました。');
  expect((await store.get(client.id)).months.find(item => item.month === '2026-09').carryOverHours).toBe(0);
  const latest = await store.get(client.id);
  await store.saveMonth(client.id, latest.revision, '2026-08', { settings: { monthlyHours: 200, carryOverHours: 0 } }, 'admin');
  await click('一覧を更新');
  await waitFor(() => expect(screen.getByRole('button', { name: '一覧を更新' }).disabled).toBe(false));
  await click('前月');
  await click('次月');
  expect(screen.getByLabelText('繰越工数（h）').value).toBe('0');
  expect(screen.queryByText(/を初期値にしています/)).toBeNull();
});

test('前月の残工数の初期値をそのまま登録できる', async () => {
  await openDetail();
  await fetchMonth();
  await click('次月');
  change('月次工数（h）', '25');
  await click('この月を登録');
  await screen.findByText('月別工数を保存しました。');
  expect((await store.get(client.id)).months.find(item => item.month === '2026-09')).toMatchObject({ carryOverHours: 98, capacity: 123 });
});


test('成功・エラーの上部通知を閉じても保存データを維持し、次の通知を表示できる', async () => {
  await openDetail();
  await fetchMonth();
  const before = await savedMonth();
  await click('通知を閉じる');
  expect(screen.queryByText('対象月の課題を取得しました。')).toBeNull();
  expect(screen.queryByRole('button', { name: '通知を閉じる' })).toBeNull();
  expect(await savedMonth()).toEqual(before);
  env.BACKLOG_API_KEY = '';
  await click('↻ Backlogから取り込み');
  await screen.findByRole('alert');
  const close = screen.getByRole('button', { name: '通知を閉じる' });
  close.focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(await savedMonth()).toEqual(before);
  env.BACKLOG_API_KEY = 'test-only-secret';
  await fetchMonth();
  expect(screen.getByRole('button', { name: '通知を閉じる' })).toBeTruthy();
});
