import React, { useId, useState } from 'react';
import { classNames, hours, round, statusClass } from '../lib/format.js';
import styles from './Dashboard.module.scss';
const cx = classNames(styles);

function issueUrl(spaceUrl, key) {
  try {
    const url = new URL(spaceUrl);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.(backlog\.com|backlog\.jp|backlogtool\.com)$/.test(url.hostname) || !key) return null;
    return url.origin + '/view/' + encodeURIComponent(key);
  } catch { return null; }
}

export function IssueList({ issues = [], synced = true, legacy = false, spaceUrl }) {
  if (!synced || !issues.length) return <div className={cx('issue-empty')}>{synced ? '該当する課題はありません' : 'Backlogから課題を取得してください'}</div>;
  return <ul className={cx('issue-list')}>{issues.map((issue, index) => <li className={cx('issue-row')} key={issue.issueKey + '-' + index}>
    <div className={cx('issue-description')}><h4>{issueUrl(spaceUrl, issue.issueKey) ? <a href={issueUrl(spaceUrl, issue.issueKey)} target="_blank" rel="noopener noreferrer" title="Backlogで開く（別タブ）">{issue.summary}<span className={cx('issue-external')} aria-hidden="true">↗</span></a> : issue.summary}</h4><p><span>{issue.issueKey}</span><span>・</span>{issue.type}{issue.startDate ? ' ・ 開始日 ' + issue.startDate : ''}</p></div>
    <div className={cx('issue-metrics')}><span className={cx('badge-status', statusClass(issue.status))}>{issue.status}</span><span className={cx('metric')}>予定時間 <b className={cx(!Number.isFinite(issue.est) && 'metric-missing')}>{Number.isFinite(issue.est) ? <>{hours(issue.est)}<small>h</small></> : '未入力'}</b></span>{legacy && <span className={cx('metric')}>旧実績 <b>{hours(issue.act)}<small>h</small></b></span>}</div>
  </li>)}</ul>;
}
export default function IssueGroup({ title, description, issues = [], variant, synced, defaultOpen = true, showTotal = true, spaceUrl }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const total = round(issues.reduce((sum, issue) => sum + (issue.est ?? 0), 0));
  return <section className={cx('issue-group', variant)} aria-label={title.endsWith('の課題') ? title : title + 'の課題'}>
    <h3 className={cx('issue-group-heading')}>
      <button type="button" className={cx('issue-group-head')} aria-label={title} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
        <span className={cx('issue-group-text')}><span className={cx('issue-group-name')}>{title}</span><span className={cx('issue-group-description')}>{description}</span></span>
        <span className={cx('issue-group-summary')}>{synced ? issues.length + '件' + (showTotal ? ' ・ 合計 ' + hours(total) + 'h' : '') : '未取得'}</span>
        <span className={cx('issue-group-arrow')} aria-hidden="true" />
      </button>
    </h3>
    <div id={bodyId} hidden={!open}><IssueList spaceUrl={spaceUrl} issues={issues} synced={Boolean(synced)} /></div>
  </section>;
}
