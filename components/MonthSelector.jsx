import React, { useEffect, useId, useRef, useState } from 'react';
import { classNames, monthLabel } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

export default function MonthSelector({ value, onChange, label, showLabel = true }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(0);
  const root = useRef(null);
  const trigger = useRef(null);
  const selected = useRef(null);
  const id = useId();
  const valid = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value);
  const [currentYear, currentMonth] = valid ? value.split('-').map(Number) : [0, 0];
  useEffect(() => {
    if (!open) return;
    selected.current?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function choose(month) {
    onChange(month);
    setOpen(false);
    trigger.current?.focus();
  }
  function move(offset) {
    const index = currentYear * 12 + currentMonth - 1 + offset;
    choose(Math.floor(index / 12) + '-' + String(index % 12 + 1).padStart(2, '0'));
  }
  return <div className={cx('month-selector')} ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    {showLabel && <span className={cx('month-selector-label')}>対象月</span>}
    <div className={cx('month-controls')}>
      <button type="button" aria-label="前月" disabled={!valid || value === '1000-01'} onClick={() => move(-1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg></button>
      <button type="button" ref={trigger} className={cx('month-trigger')} aria-label={label} aria-expanded={open} aria-controls={id} disabled={!valid} onClick={() => { setYear(currentYear); setOpen(!open); }}>{monthLabel(value)} <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg></button>
      <button type="button" aria-label="次月" disabled={!valid || value === '9999-12'} onClick={() => move(1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg></button>
    </div>
    {open && <div id={id} role="group" aria-label="月を選択" className={cx('month-popover')}>
      <div className={cx('month-year')}><button type="button" aria-label="前年" disabled={year <= 1000} onClick={() => setYear(year - 1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg></button><strong aria-live="polite">{year}年</strong><button type="button" aria-label="翌年" disabled={year >= 9999} onClick={() => setYear(year + 1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg></button></div>
      <div className={cx('month-grid')}>{Array.from({ length: 12 }, (_, index) => {
        const month = year + '-' + String(index + 1).padStart(2, '0');
        return <button type="button" key={index} ref={index + 1 === currentMonth ? selected : null} aria-label={monthLabel(month)} aria-pressed={month === value} onClick={() => choose(month)}>{index + 1}月</button>;
      })}</div>
    </div>}
  </div>;
}
