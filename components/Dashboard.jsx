'use client';

import React from 'react';
import useDashboard from '../hooks/useDashboard.js';
import Sidebar from './Sidebar.jsx';
import ClientList from './ClientList.jsx';
import ClientDetail from './ClientDetail.jsx';
import ClientModal from './ClientModal.jsx';
import styles from './Dashboard.module.scss';
import { classNames } from '../lib/format.js';
const cx = classNames(styles);

export default function Dashboard() {
  const dashboard = useDashboard();
  const { settings, pending, notice, selectedClient, modal } = dashboard;
  return <div className={styles.dashboard}>
    <Sidebar dashboard={dashboard} />
    <main className={cx('app')}>
      {notice && <div className={cx('notice', notice.error && 'notice-error')} role={notice.error ? 'alert' : 'status'}>{notice.message}</div>}
      <div className={cx('session-bar')}><span className={cx('user-identity')}>{settings && settings.user.email + (dashboard.isAdmin ? '（管理者）' : '（閲覧・取得）')}</span><button className={cx('ghost')} onClick={dashboard.refresh} disabled={pending}>一覧を更新</button></div>
      {selectedClient ? <>
        <button className={cx('ghost back-button')} onClick={dashboard.backToList}>← クライアント一覧に戻る</button>
        <ClientDetail key={selectedClient.id} dashboard={dashboard} />
      </> : <ClientList dashboard={dashboard} />}
    </main>
    {modal && <ClientModal client={modal.client} spaceUrl={settings?.spaceUrl || ''} pending={pending} onClose={dashboard.closeModal} onSave={dashboard.saveClient} />}
  </div>;
}
