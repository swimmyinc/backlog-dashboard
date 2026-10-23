import React, { useState } from 'react';
import HoursModal from './HoursModal.jsx';
import { classNames, fetchedLabel, hours, numberInput } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function AdditionalHours({ month, isAdmin, pending, errorMessage, onAdd }) {
  const [value, setValue] = useState('');
  const [memo, setMemo] = useState('');
  const [editing, setEditing] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setSaveFailed(false);
    const saved = await onAdd({ hours: numberInput(value), memo: memo.trim() });
    if (saved) {
      setValue('');
      setMemo('');
      setEditing(false);
    } else setSaveFailed(true);
  }
  return <div className={cx('additions-panel')}>
    {editing && <HoursModal title="追加工数を入力" pending={pending} onClose={() => setEditing(false)}>
      <form onSubmit={submit}>
        <div className={cx('field')}><label htmlFor="additionalHours">追加する工数（h）</label><input type="number" id="additionalHours" min="0.01" max="100000" step="0.01" placeholder="例: 5" required value={value} onChange={event => setValue(event.target.value)} disabled={pending} /></div>
        <div className={cx('field')}><label htmlFor="additionalMemo">メモ（必須）</label><input type="text" id="additionalMemo" maxLength={1000} placeholder="例: 追加改修の見積番号" required value={memo} onChange={event => setMemo(event.target.value)} disabled={pending} /></div>
        {saveFailed && <p className={cx('form-error')}>{errorMessage || '保存できませんでした。再度お試しください。'}</p>}
        <div className={cx('modal-actions')}><button type="button" className={cx('ghost')} disabled={pending} onClick={() => setEditing(false)}>キャンセル</button><button className={cx('primary')} disabled={pending}>＋ 追加工数を記録</button></div>
      </form>
    </HoursModal>}
    <details className={cx('hours-accordion')}><summary>工数追加履歴 <span>{month?.additions.length || 0}件</span></summary>
      <ul className={cx('addition-list')}>{(month?.additions || []).map(item => <li key={item.id}><div><p>{item.memo}</p><small>{fetchedLabel(item.createdAt)}（日本時間）</small></div><b>＋ {hours(item.hours)}h</b></li>)}
        {!month?.additions.length && <li className={cx('muted')}>この月の追加工数はまだありません</li>}
      </ul>
    </details>
    {month && isAdmin && <button className={cx('ghost addition-input-button')} disabled={pending} onClick={() => { setValue(''); setMemo(''); setSaveFailed(false); setEditing(true); }}>追加工数を入力</button>}
  </div>;
}
