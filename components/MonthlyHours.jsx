import React, { useImperativeHandle, useState } from 'react';
import HoursModal from './HoursModal.jsx';
import AdditionalHours from './AdditionalHours.jsx';
import { classNames, availableText, balClass, hours, monthLabel, numberInput } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function MonthlyHours({ dashboard: d, month, ref }) {
  const client = d.selectedClient;
  const [year, monthNumber] = d.selectedMonth.split('-').map(Number);
  const previousMonthKey = (monthNumber === 1 ? year - 1 : year) + '-' + String(monthNumber === 1 ? 12 : monthNumber - 1).padStart(2, '0');
  const previousMonth = client.months?.find(item => item.month === previousMonthKey);
  const suggestedCarry = !month && previousMonth?.synced && Number.isFinite(previousMonth.remaining) && previousMonth.remaining >= 0
    ? previousMonth.remaining : null;
  const [monthlyHours, setMonthlyHours] = useState(String(month?.monthlyHours ?? ''));
  const [carryHours, setCarryHours] = useState(String(month?.carryOverHours ?? suggestedCarry ?? 0));
  const [editing, setEditing] = useState(d.isAdmin && !month);
  const [saveFailed, setSaveFailed] = useState(false);
  function openSettings() {
    setMonthlyHours(String(month?.monthlyHours ?? ''));
    setCarryHours(String(month?.carryOverHours ?? suggestedCarry ?? 0));
    setSaveFailed(false);
    setEditing(true);
  }
  useImperativeHandle(ref, () => ({ openSettings }));
  const amount = name => availableText(month, name);
  const width = value => Math.max(0, Math.min(100, value / Math.max(month?.capacity || 0, month?.confirmedHours || 0, 1) * 100)) + '%';
  const path = '/months/' + d.selectedMonth;
  return <div className={cx('detail-summary')}>
    <section className={cx('surface balance-panel')} aria-label="工数の内訳">
      <div className={cx('panel-heading')}><span>{monthLabel(d.selectedMonth)} の残工数</span></div>
      <div className={cx('balance-number', balClass(month))}>{month?.synced ? hours(month.remaining) : '—'}<small>h</small></div>
      <div className={cx('capacity-chart')} aria-hidden="true"><div className={cx('capacity-track')}><i className={cx('monthly')} style={{ width: width(month?.monthlyHours || 0) }} /><i className={cx('carry')} style={{ width: width(month?.carryOverHours || 0) }} /><i className={cx('extra')} style={{ width: width(month?.extraHours || 0) }} /></div><div className={cx('consumed-track')}><i style={{ width: width(month?.confirmedHours || 0) }} /></div></div>
      <details className={cx('balance-breakdown')}><summary>内訳を表示</summary>
      <dl className={cx('breakdown')}>
        <div><dt><i className={cx('dot monthly')} />月次工数</dt><dd>{month ? hours(month.monthlyHours) + 'h' : '—'}</dd></div>
        <div><dt><i className={cx('dot carry')} />前月からの繰越工数</dt><dd>{month ? hours(month.carryOverHours) + 'h' : '—'}</dd></div>
        <div><dt><i className={cx('dot extra')} />追加工数</dt><dd>{month ? hours(month.extraHours) + 'h' : '—'}</dd></div>
        <div className={cx('capacity-total')}><dt>使用可能工数</dt><dd>{month ? hours(month.capacity) + 'h' : '—'}</dd></div>
        <div><dt><i className={cx('dot consumed')} />確定工数</dt><dd>{amount('confirmedHours')}</dd></div>
        <div className={cx('total')}><dt>残工数</dt><dd>{amount('remaining')}</dd></div>
        <div><dt>予定工数</dt><dd>{amount('plannedHours')}</dd></div>
        <div className={cx('total')}><dt>予定残工数</dt><dd>{amount('plannedRemaining')}</dd></div>
      </dl>
      </details>
    </section>
    <section className={cx('surface contract-panel')} aria-label="工数設定">
        <div className={cx('panel-heading')}><h3>工数設定</h3>{d.isAdmin && month && <button className={cx('ghost')} disabled={d.pending} onClick={openSettings}>更新</button>}</div>
        <dl className={cx('settings-values')}><div><dt>月次</dt><dd>{month ? hours(month.monthlyHours) + 'h' : '未設定'}</dd></div><div><dt>繰越</dt><dd>{month ? hours(month.carryOverHours) + 'h' : '未設定'}</dd></div><div className={cx('additional-value')}><dt>追加</dt><dd>{month ? hours(month.extraHours) + 'h' : '—'}</dd></div></dl>
        {!d.isAdmin && <p className={cx('muted')}>月別設定の登録・変更は管理者が行います。</p>}
      {editing && <HoursModal title="月次・繰越工数の設定" pending={d.pending} onClose={() => setEditing(false)}>
      <form onSubmit={async event => { event.preventDefault(); setSaveFailed(false); const saved = await d.mutate(client, path, 'PUT', { monthlyHours: numberInput(monthlyHours), carryOverHours: numberInput(carryHours) }, '月別工数を保存しました。'); if (saved) setEditing(false); else setSaveFailed(true); }}>
        <div className={cx('field')}><label htmlFor="monthHours">月次工数（h）</label><input id="monthHours" type="number" min="0" max="100000" step="0.01" required value={monthlyHours} onChange={event => setMonthlyHours(event.target.value)} disabled={d.pending} /></div>
        <div className={cx('field')}><label htmlFor="carryHours">繰越工数（h）</label><input id="carryHours" aria-describedby={suggestedCarry !== null ? "carryHint" : undefined} type="number" min="-100000" max="100000" step="0.01" required value={carryHours} onChange={event => setCarryHours(event.target.value)} disabled={d.pending} />{suggestedCarry !== null && <p id="carryHint" className={cx('muted')}>{monthLabel(previousMonthKey)}の残工数 {hours(suggestedCarry)}h を初期値にしています。変更して登録できます。</p>}</div>
        {saveFailed && <p className={cx('form-error')}>{d.notice?.message || '保存できませんでした。再度お試しください。'}</p>}
        <div className={cx('modal-actions')}><button type="button" className={cx('ghost')} disabled={d.pending} onClick={() => setEditing(false)}>キャンセル</button><button className={cx('primary')} disabled={d.pending}>保存する</button></div>
      </form></HoursModal>}
      <AdditionalHours month={month} isAdmin={d.isAdmin} pending={d.pending} errorMessage={d.notice?.message} onAdd={payload => d.mutate(client, path + '/additions', 'POST', payload, '追加工数を記録しました。')} />
    </section>
  </div>;
}
