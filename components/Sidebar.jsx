import React from 'react';
import { classNames, getMonth, hours, remainingRate } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function Sidebar({ dashboard: d }) {
  return <aside className={cx('sidebar')}>
    <a className={cx('brand')} href="#" onClick={event => { event.preventDefault(); d.backToList(); }}><span className={cx('brand-icon')} aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></span>工数集計</a>
    <button className={cx('sidebar-home')} onClick={d.backToList}>▦ クライアント一覧</button>
    <p className={cx('sidebar-label')}>クライアント</p>
    <nav className={cx('sidebar-clients')} aria-label="クライアント">
      {d.clients.map(client => {
        const month = getMonth(client, d.selectedMonth);
        return <button key={client.id} className={cx('sidebar-client', client.id === d.selectedClientId && 'selected')} aria-current={client.id === d.selectedClientId ? 'page' : undefined} onClick={() => d.openDetail(client.id)}>
          <span><b>{client.name}</b><small>{month?.synced ? '残 ' + hours(month.remaining) + 'h' : month ? '未取得' : '月未登録'}</small></span>
          <span className={cx('side-track')}><i style={{ width: (month?.synced ? remainingRate(month) : 0) + '%' }} /></span>
        </button>;
      })}
      {d.settings && !d.clients.length && <p className={cx('sidebar-empty')}>登録済みのクライアントはありません</p>}
    </nav>
    {d.isAdmin && <button className={cx('sidebar-add')} onClick={() => d.openModal()} disabled={d.pending}>＋ クライアントを追加</button>}
    <div className={cx('sidebar-footer')}>工数管理ダッシュボード<span>© 2026 YUKINO</span></div>
  </aside>;
}
