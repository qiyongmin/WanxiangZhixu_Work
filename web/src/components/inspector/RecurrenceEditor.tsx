import { useId } from 'react';
import { validateRepeat } from '../../lib/inspector';
import { L2 } from '../../lib/labels';
import type { RepeatRule } from '../../lib/types';

type Kind = 'none' | RepeatRule['type'];

interface Props {
  value: RepeatRule | null;
  onChange: (next: RepeatRule | null) => void;
  disabled?: boolean;
  /** 服务端返回的字段错误（优先于本地预检）。 */
  error?: string;
}

const KIND_LABELS: Record<Kind, string> = {
  none: L2.repeatNone,
  daily: L2.repeatDaily,
  weekly: L2.repeatWeekly,
  monthly: L2.repeatMonthly,
  interval: L2.repeatInterval,
};

/** 每日 / 每周（1–7 个星期几）/ 每月 / 间隔天数（1–365）；无效参数当场提示。 */
export function RecurrenceEditor({ value, onChange, disabled, error }: Props) {
  const uid = useId();
  const kind: Kind = value ? value.type : 'none';
  const problem = error ?? validateRepeat(value);

  const changeKind = (next: Kind) => {
    if (next === 'none') onChange(null);
    else if (next === 'weekly') onChange({ type: 'weekly', days: value?.type === 'weekly' ? value.days : [1] });
    else if (next === 'interval') onChange({ type: 'interval', days: value?.type === 'interval' ? value.days : 7 });
    else onChange({ type: next });
  };

  const toggleDay = (day: number) => {
    if (value?.type !== 'weekly') return;
    const days = value.days.includes(day) ? value.days.filter((item) => item !== day) : [...value.days, day];
    onChange({ type: 'weekly', days: days.sort((a, b) => a - b) });
  };

  return (
    <div className="recurrence" aria-describedby={problem ? `${uid}-err` : undefined}>
      <label htmlFor={`${uid}-kind`} className="visually-hidden">
        {L2.fieldRepeat}
      </label>
      <select id={`${uid}-kind`} value={kind} disabled={disabled} onChange={(event) => changeKind(event.target.value as Kind)}>
        {(Object.keys(KIND_LABELS) as Kind[]).map((item) => (
          <option key={item} value={item}>
            {KIND_LABELS[item]}
          </option>
        ))}
      </select>
      {value?.type === 'weekly' ? (
        <fieldset className="weekdays" disabled={disabled}>
          <legend className="visually-hidden">{L2.repeatDays}</legend>
          {L2.weekdays.map((label, index) => (
            <label key={label} className="check-row">
              <input type="checkbox" checked={value.days.includes(index + 1)} onChange={() => toggleDay(index + 1)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {value?.type === 'interval' ? (
        <label className="interval">
          <span>{L2.repeatIntervalDays}</span>
          <input
            type="number"
            min={1}
            max={365}
            step={1}
            value={Number.isFinite(value.days) ? value.days : ''}
            disabled={disabled}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => onChange({ type: 'interval', days: event.target.value === '' ? Number.NaN : Number(event.target.value) })}
          />
        </label>
      ) : null}
      {problem ? (
        <p id={`${uid}-err`} className="field-error error-text">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
