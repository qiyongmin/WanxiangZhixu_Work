// 日期工具：本地时区的日期/时间字符串，与后端 `now`/`today` 参数格式一致。
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地今天，`YYYY-MM-DD`。 */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 本地当前时间，`YYYY-MM-DDTHH:MM`。 */
export function localNow(now: Date = new Date()): string {
  return `${localToday(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 逾期：dueDate 早于本地今天且未 Done（Req 9.6）。 */
export function isOverdue(dueDate: string | null, status: string, today: string = localToday()): boolean {
  return dueDate !== null && dueDate !== '' && dueDate < today && status !== 'Done';
}

/** 把后端时间戳显示为本地 `YYYY-MM-DD HH:MM`；无法解析时原样返回。 */
export function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${localToday(parsed)} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/** Whole days between `due` and `today` (positive when due is earlier); 0 when either date is invalid. */
export function daysOverdue(due: string | null, today: string = localToday()): number {
  const a = due ? parseDay(due) : null;
  const b = parseDay(today);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000));
}

/** `YYYY-MM-DD` shifted by whole days (local calendar). */
export function addDays(day: string, delta: number): string {
  const base = parseDay(day);
  if (!base) return day;
  return localToday(new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta));
}

/** Monday of the week containing `day` (weeks run Monday to Sunday). */
export function weekStart(day: string = localToday()): string {
  const base = parseDay(day);
  if (!base) return day;
  const isoWeekday = base.getDay() === 0 ? 7 : base.getDay();
  return addDays(day, 1 - isoWeekday);
}

/** 解析 `YYYY-MM-DD` 为本地日期；非法返回 null。 */
export function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localToday(date) === value ? date : null;
}

/** 本周日（周一起算一周），`YYYY-MM-DD`；与服务端 `week_end` 一致（周日当天即当天）。 */
export function weekEnd(today: string = localToday()): string {
  const base = parseDay(today);
  if (!base) return today;
  const isoWeekday = base.getDay() === 0 ? 7 : base.getDay();
  return localToday(new Date(base.getFullYear(), base.getMonth(), base.getDate() + (7 - isoWeekday)));
}

/** 今天之后、本周日之前（含）才算「本周到期」；今天本身属于「今天到期」。 */
export function isDueThisWeek(dueDate: string | null, status: string, today: string = localToday()): boolean {
  return dueDate !== null && dueDate !== '' && status !== 'Done' && dueDate > today && dueDate <= weekEnd(today);
}

export function isDueToday(dueDate: string | null, status: string, today: string = localToday()): boolean {
  return dueDate === today && status !== 'Done';
}
