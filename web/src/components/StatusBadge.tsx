import { STATUS_ICONS, STATUS_LABELS } from '../lib/labels';
import type { Status } from '../lib/types';

/** 五个 Status 各有独立图标 + 文字标签，不依赖颜色区分（Req 7.10 / 35.7）。 */
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className="status-badge" data-status={status}>
      <span className="status-icon" aria-hidden="true">
        {STATUS_ICONS[status]}
      </span>
      <span>{STATUS_LABELS[status]}</span>
    </span>
  );
}
