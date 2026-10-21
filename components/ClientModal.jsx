import React, { useEffect, useRef, useState } from 'react';
import { classNames } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function ClientModal({ client, spaceUrl, pending, onClose, onSave }) {
  const [name, setName] = useState(client?.name || '');
  const [director, setDirector] = useState(client?.director || '');
  const [projectId, setProjectId] = useState(client?.projectId || '');
  const [error, setError] = useState('');
  const dialog = useRef(null);
  const nameInput = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    nameInput.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  async function save(remove = false) {
    setError('');
    try { await onSave({ name: name.trim(), director: director.trim(), projectId: projectId.trim() }, remove); }
    catch (err) { setError(err.message); }
  }
  function onKeyDown(event) {
    if (event.key === 'Escape' && !pending) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const items = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
    if (!items.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
  }
  return <div className={cx('overlay active')} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={cx('modal')} role="dialog" aria-modal="true" aria-labelledby="clientModalTitle" ref={dialog} onKeyDown={onKeyDown}>
      <h3 id="clientModalTitle">{client ? 'クライアント基本情報' : 'クライアントを追加'}</h3>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className={cx('field')}><label htmlFor="inputName">クライアント名</label><input type="text" id="inputName" placeholder="例: NIPPN" required value={name} onChange={event => setName(event.target.value)} disabled={pending} ref={nameInput} /></div>
        <div className={cx('field')}><label htmlFor="inputDirector">担当者</label><input type="text" id="inputDirector" placeholder="例: 佐藤" value={director} onChange={event => setDirector(event.target.value)} disabled={pending} /></div>
        <div className={cx('field')}><label htmlFor="inputSpaceUrl">Backlog スペースURL</label><input type="text" id="inputSpaceUrl" value={spaceUrl} readOnly /></div>
        <div className={cx('field-row')}><div className={cx('field')}><label htmlFor="inputProjectId">プロジェクトID(またはキー)</label><input type="text" id="inputProjectId" placeholder="例: 481033 または YOURMEAL" required value={projectId} onChange={event => setProjectId(event.target.value)} disabled={pending} /></div></div>
        {error && <p className={cx('form-error')} role="alert">{error}</p>}
        <div className={cx('modal-actions registration-actions')}>
          {client && <button className={cx('ghost delete-button')} type="button" disabled={pending} onClick={() => save(true)}>クライアントを削除</button>}
          <div><button className={cx('ghost')} type="button" disabled={pending} onClick={onClose}>キャンセル</button><button className={cx('primary')} disabled={pending}>{client ? '更新する' : '登録する'}</button></div>
        </div>
      </form>
      <p className={cx('status-note')}>工数は登録後に対象月ごとに設定します。プロジェクト変更時は新方式の取得結果をクリアし、月別設定・追加明細・旧履歴を保持します。</p>
    </div>
  </div>;
}
