import React, { useEffect, useId, useRef } from 'react';
import { classNames } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function HoursModal({ title, pending, onClose, children }) {
  const titleId = useId();
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.querySelector('input, button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); if (!pending) onClose(); }
    if (event.key !== 'Tab') return;
    const items = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
    if (!items.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
  }
  return <div className={cx('overlay active')} onClick={event => { if (!pending && event.target === event.currentTarget) onClose(); }}>
    <div className={cx('modal')} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog} onKeyDown={onKeyDown}>
      <h3 id={titleId}>{title}</h3>{children}
    </div>
  </div>;
}
