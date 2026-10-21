export const round = value => Math.round(value * 100) / 100;
export const hours = value => Number(value || 0).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
export const monthLabel = month => month ? month.replace('-', '年') + '月' : '対象月';
export const currentMonth = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(new Date());
export const getMonth = (client, month) => (client?.months || []).find(item => item.month === month);
export const availableText = (month, field) => month?.synced ? hours(month[field]) + 'h' : '—';
export const remainingRate = month => month?.capacity > 0 ? Math.max(0, Math.min(100, month.remaining / month.capacity * 100)) : 0;
export const balClass = month => !month ? '' : month.remaining <= 0 ? 'bal-zero' : month.remaining < month.capacity * .2 ? 'bal-low' : 'bal-ok';
export const statusClass = status => status === '完了' ? 'st-完了' : ['処理中', '処理済み'].includes(status) ? 'st-処理中' : 'st-未対応';
export const monthStatus = month => month?.synced ? '取得済み' : month ? '未取得' : '月未登録';
export const numberInput = value => value.trim() === '' ? null : Number(value);
export const classNames = styles => (...names) => names.filter(Boolean).flatMap(name => name.split(/\s+/)).map(name => styles[name] || name).join(' ');
export function fetchedLabel(value) {
  if (!value) return '未取得';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未取得' : date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function monthRange(month) {
  const [year, value] = month.split('-').map(Number);
  return { from: month + '-01', to: month + '-' + new Date(Date.UTC(year, value, 0)).getUTCDate() };
}
