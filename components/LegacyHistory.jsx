import React, { useEffect, useRef } from 'react';
import { IssueList } from './IssueGroup.jsx';
import { classNames, hours } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function LegacyHistory({ client, snapshot, pending, onLoad }) {
  const details = useRef(null);
  useEffect(() => { if (snapshot && details.current) details.current.open = true; }, [snapshot]);
  if (!(client.history || []).length && client.monthlyHours === undefined) return null;
  return <details className={cx('legacy-section')} ref={details}>
    <summary>旧方式の設定・履歴（新しい月別集計の対象外）</summary>
    <p className={cx('status-note')}>旧履歴は更新日基準・想定と実績の両方を控除した保存値です。新しい月別工数へは自動移行していません。</p>
    {client.monthlyHours !== undefined && <p className={cx('muted')}>旧設定：月次 {hours(client.monthlyHours)}h ／ 繰越 {hours(client.carryOverHours)}h ／ 追加 {hours(client.extraHours)}h</p>}
    <div className={cx('period-cards')}>{(client.history || []).map(item => <button className={cx('period-card')} key={item.id} disabled={pending} onClick={() => onLoad(item.id)}><b>{item.from} 〜 {item.to}</b><span>旧残工数 {hours(item.remaining)}h</span></button>)}</div>
    {snapshot && <><h3>旧履歴 {snapshot.from} 〜 {snapshot.to}</h3><p className={cx('muted')}>旧使用可能 {hours(snapshot.capacity)}h ／ 旧想定 {hours(snapshot.est)}h ／ 旧実績 {hours(snapshot.act)}h ／ 旧残工数 {hours(snapshot.remaining)}h</p><IssueList spaceUrl={client.spaceUrl} issues={Object.values(snapshot.data || {}).flat()} legacy /></>}
  </details>;
}
