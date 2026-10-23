import React, { useRef } from 'react';
import MonthSelector from './MonthSelector.jsx';
import MonthlyHours from './MonthlyHours.jsx';
import IssueGroup from './IssueGroup.jsx';
import LegacyHistory from './LegacyHistory.jsx';
import { classNames, availableText, fetchedLabel, getMonth, hours, monthLabel, monthStatus } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function ClientDetail({ dashboard: d }) {
  const monthlySettingsRef = useRef(null);
  const client = d.selectedClient;
  const month = getMonth(client, d.selectedMonth);
  const custom = d.periodMode === 'custom';
  const result = d.customResult;
  const data = (custom ? result : month)?.data;
  const confirmed = (data?.confirmed || []).filter(issue => Number.isFinite(issue.est));
  const planned = (data?.planned || []).filter(issue => Number.isFinite(issue.est));
  const missing = [...(data?.confirmed || []), ...(data?.planned || [])].filter(issue => !Number.isFinite(issue.est));
  const groupKey = client.id + ':' + d.periodMode + ':' + (custom ? d.customRange.from + ':' + d.customRange.to : d.selectedMonth);
  const otherMonths = (client.months || []).filter(item => item.month !== d.selectedMonth).sort((a, b) => a.month.localeCompare(b.month));
  const status = custom
    ? result ? '取得日時 ' + fetchedLabel(result.fetchedAt) : '開始日・終了日を指定して取得してください'
    : month?.synced ? '開始日基準の保存済みデータを表示中' : month ? 'Backlogから対象月の課題を取り込んでください' : '対象月の月次工数・繰越工数を登録してください';
  return <section>
    <header className={cx('detail-head')}><div><h1>{client.name}</h1><p className={cx('meta')}>担当: {client.director || '未設定'} ・ Backlog最終取得 {fetchedLabel(custom ? result?.fetchedAt : month?.fetchedAt)}</p></div>
      <div className={cx('detail-actions')}>
      {custom ? <button className={cx('ghost import-button')} disabled={d.pending} onClick={d.fetchCustom}>↻ この期間で取得</button>
        : month && <button className={cx('ghost import-button')} disabled={d.pending} onClick={() => d.mutate(client, '/months/' + d.selectedMonth + '/fetch', 'POST', {}, '対象月の課題を取得しました。')}>↻ Backlogから取り込み</button>}
      {d.isAdmin && <button className={cx('ghost')} disabled={d.pending} onClick={() => d.openModal(client)}>設定</button>}
      {d.isAdmin && !custom && !month && <button className={cx('primary')} disabled={d.pending} onClick={() => monthlySettingsRef.current?.openSettings()}>月次初期設定</button>}
      </div>
    </header>
    <div className={cx('period-toolbar')}>
    <div className={cx('period-mode')} role="group" aria-label="集計期間の選択"><button aria-pressed={!custom} onClick={() => d.changeMode('month')}>月</button><button aria-pressed={custom} onClick={() => d.changeMode('custom')}>カスタム期間</button></div>
      {custom ? <div className={cx('custom-period-fields')}><label htmlFor="customFrom">開始日<input type="date" id="customFrom" value={d.customRange.from} onChange={event => d.changeRange('from', event.target.value)} /></label><span>〜</span><label htmlFor="customTo">終了日<input type="date" id="customTo" value={d.customRange.to} onChange={event => d.changeRange('to', event.target.value)} /></label></div>
        : <div className={cx('month-selection')}><MonthSelector value={d.selectedMonth} onChange={d.changeMonth} label="詳細の対象月" showLabel={false} /><span className={cx('tag', !month?.synced && 'sample')}>{monthStatus(month)}</span></div>}
    </div>
    {custom ? <section className={cx('current-month custom-summary')} aria-label="カスタム期間の集計"><div className={cx('current-month-heading')}><span className={cx('current-month-label')}>表示対象期間</span><h2>{d.customRange.from || '未指定'} 〜 {d.customRange.to || '未指定'}</h2><p className={cx('muted')}>確認用の集計です。月別データは更新しません。</p></div><dl className={cx('current-month-totals')}><div><dt>確定工数</dt><dd>{result ? hours(result.confirmedHours) + 'h' : '—'}</dd></div><div><dt>予定工数</dt><dd>{result ? hours(result.plannedHours) + 'h' : '—'}</dd></div></dl></section>
      : <>
        {otherMonths.length > 0 && <section className={cx('other-months')} aria-label="ほかの月"><h2>ほかの月</h2><nav className={cx('period-cards')} aria-label="ほかの登録済みの月">{otherMonths.map(item => <button className={cx('period-card')} key={item.month} onClick={() => d.changeMonth(item.month)}><span><b>{monthLabel(item.month)}</b><small>{item.synced ? '取得済み' : '未取得'}</small></span><span>残 {availableText(item, 'remaining')}</span><span className={cx('period-date')}>予定残 {availableText(item, 'plannedRemaining')}</span></button>)}</nav></section>}
        <MonthlyHours ref={monthlySettingsRef} key={client.id + ':' + d.selectedMonth + ':' + client.revision} dashboard={d} month={month} />
      </>}
    <div className={cx('section-title issue-title')}><h2>課題</h2><span>{custom ? '開始日が指定期間内の課題・予定時間で集計' : '開始日が' + monthLabel(d.selectedMonth) + 'の課題・予定時間で集計'}</span></div>
    <IssueGroup spaceUrl={client.spaceUrl} key={groupKey + ":confirmed"} title="確定工数" description={custom ? '完了・処理中・処理済みの予定時間' : '完了・処理中・処理済みの予定時間を残工数から差し引きます'} issues={confirmed} variant="completed" synced={custom ? Boolean(result) : month?.synced} />
    <IssueGroup spaceUrl={client.spaceUrl} key={groupKey + ":planned"} title="予定工数" description={custom ? '未対応の予定時間' : '未対応の予定時間。残工数から差し引いた値が予定残工数です'} issues={planned} variant="not-started" synced={custom ? Boolean(result) : month?.synced} />
    <IssueGroup spaceUrl={client.spaceUrl} key={groupKey + ':missing'} title="工数未入力の課題" description="予定時間が未入力の課題です。Backlogで予定時間を入力し、再取得してください。" issues={missing} variant="missing-hours" synced={custom ? Boolean(result) : month?.synced} defaultOpen={false} showTotal={false} />
    <p className={cx('status-note')}>{custom ? '開始日未設定の課題、種別に「発注」を含む課題は対象外です。この結果はDBに保存されず、月・クライアントの切り替えや再読み込みでクリアされます。' : '開始日未設定の課題、種別に「発注」を含む課題は対象外です。実績時間は集計に使用しません。取得結果は利用者全員で共有されます。'}</p>
    {!custom && <LegacyHistory key={client.id + ':' + d.selectedMonth} client={client} snapshot={d.snapshot} pending={d.historyPending} onLoad={id => d.loadHistory(client, id)} />}
    <p className={cx('status-note')} role="status">{d.operationStatus || status}</p>
  </section>;
}
