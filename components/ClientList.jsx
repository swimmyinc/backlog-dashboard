import React from 'react';
import MonthSelector from './MonthSelector.jsx';
import { classNames, availableText, balClass, getMonth, hours, monthLabel, monthStatus, remainingRate } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function ClientList({ dashboard: d }) {
  const directors = [...new Set(d.clients.map(client => client.director).filter(Boolean))].sort();
  const director = directors.includes(d.filterDirector) ? d.filterDirector : '';
  const synced = d.clients.map(client => getMonth(client, d.selectedMonth)).filter(month => month?.synced);
  const list = d.clients.filter(client => (!d.filterText || client.name.toLowerCase().includes(d.filterText.toLowerCase())) && (!director || client.director === director));
  return <>
    <header className={cx('top')}><div className={cx('brand')}><h1>クライアント一覧</h1><p className={cx('sub')}>対象月のクライアント別の残工数・確定工数・予定工数を確認できます。各クライアントの詳細画面で、月別工数の設定やBacklog課題の取り込みを行えます。</p></div></header>
    <div className={cx('overview-stats')}>
      <div><span>登録クライアント</span><strong>{d.clients.length}<small>件</small></strong></div>
      <div><span>{monthLabel(d.selectedMonth)} 取得済み</span><strong>{synced.length}<small>件</small></strong></div>
      <div><span>残工数が20%未満</span><strong>{synced.filter(month => month.remaining <= 0 || month.remaining < month.capacity * .2).length}<small>件</small></strong></div>
    </div>
    <div className={cx('toolbar')}><div className={cx('filters')}>
      <MonthSelector value={d.selectedMonth} onChange={d.changeMonth} label="一覧の対象月" />
      <input type="text" aria-label="クライアント名で検索" placeholder="クライアント名で検索" value={d.filterText} onChange={event => d.setFilterText(event.target.value)} />
      <select aria-label="担当者で絞り込み" value={director} onChange={event => d.setFilterDirector(event.target.value)}><option value="">すべての担当者</option>{directors.map(name => <option key={name}>{name}</option>)}</select>
    </div></div>
    <div className={cx('client-grid')}>{list.map(client => {
      const month = getMonth(client, d.selectedMonth);
      return <article key={client.id} className={cx('stub')}>
        <div className={cx('stub-head')}><span className={cx('name')}>{client.name}</span><span className={cx('tag', !month?.synced && 'sample')}>{monthStatus(month)}</span></div>
        <div className={cx('stub-note')}><span>Project #{client.projectId}</span><span>担当: {client.director || '未設定'}</span></div>
        <div className={cx('stub-balance')}><span className={cx('num', balClass(month))}>{month?.synced ? hours(month.remaining) : '—'}</span><span className={cx('unit')}>h 残</span></div>
        <div className={cx('card-track')}><i style={{ width: (month?.synced ? remainingRate(month) : 0) + '%' }} /></div>
        <div className={cx('stub-meta')}><span>確定工数 <b>{availableText(month, 'confirmedHours')}</b></span><span>予定工数 <b>{availableText(month, 'plannedHours')}</b></span></div>
        <div className={cx('stub-actions')}><button className={cx('ghost')} onClick={() => d.openDetail(client.id)}>詳細を見る</button>{d.isAdmin && <button className={cx('ghost')} disabled={d.pending} onClick={() => d.openModal(client)}>基本情報</button>}</div>
      </article>;
    })}</div>
    {d.settings && !list.length && <div className={cx('empty')}>{d.clients.length ? '条件に一致するクライアントがありません。' : d.isAdmin ? '「＋ クライアントを追加」から登録してください。' : '登録済みのクライアントがありません。管理者に登録を依頼してください。'}</div>}
  </>;
}
