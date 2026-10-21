import React, { useRef, useState } from 'react';
import { classNames, fetchedLabel, hours, numberInput } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function AdditionalHours({ month, isAdmin, pending, onAdd }) {
  const [value, setValue] = useState('');
  const [memo, setMemo] = useState('');
  const inputDetails = useRef(null);
  async function submit(event) {
    event.preventDefault();
    const saved = await onAdd({ hours: numberInput(value), memo: memo.trim() });
    if (saved) {
      setValue('');
      setMemo('');
      if (inputDetails.current) inputDetails.current.open = false;
    }
  }
  return <section className={cx('additions-panel')} aria-label="追加工数の設定">
    <div className={cx('panel-heading')}><h3>追加工数</h3><b>合計 {month ? hours(month.extraHours) + 'h' : '—'}</b></div>
    {month && isAdmin && <details className={cx('hours-accordion addition-input-accordion')} ref={inputDetails}>
      <summary><span className={cx('addition-toggle-icon')} aria-hidden="true" />追加工数を入力</summary>
      <form className={cx('addition-form')} onSubmit={submit}>
        <div className={cx('field')}><label htmlFor="additionalHours">追加する工数（h）</label><input type="number" id="additionalHours" min="0.01" max="100000" step="0.01" placeholder="例: 5" required value={value} onChange={event => setValue(event.target.value)} disabled={pending} /></div>
        <div className={cx('field')}><label htmlFor="additionalMemo">メモ（必須）</label><input type="text" id="additionalMemo" maxLength={1000} placeholder="例: 追加改修の見積番号" required value={memo} onChange={event => setMemo(event.target.value)} disabled={pending} /></div>
        <button className={cx('primary')} disabled={pending}>＋ 追加工数を記録</button>
      </form>
    </details>}
    <details className={cx('hours-accordion')}><summary>追加履歴 <span>{month?.additions.length || 0}件</span></summary>
      <ul className={cx('addition-list')}>{(month?.additions || []).map(item => <li key={item.id}><div><p>{item.memo}</p><small>{fetchedLabel(item.createdAt)}（日本時間）</small></div><b>＋ {hours(item.hours)}h</b></li>)}
        {!month?.additions.length && <li className={cx('muted')}>この月の追加工数はまだありません</li>}
      </ul>
    </details>
  </section>;
}
