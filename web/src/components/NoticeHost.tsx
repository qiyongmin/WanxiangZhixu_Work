import { L2 } from '../lib/labels';
import { dismissNotice, useNotices } from '../lib/notice';

/** 右下角提示（toast）：role=status，可手动关闭，6 秒后自动消失。 */
export function NoticeHost() {
  const notices = useNotices();
  if (notices.length === 0) return null;
  return (
    <div className="notice-host" role="status" aria-live="polite" aria-label={L2.noticeLabel}>
      {notices.map((notice) => (
        <div className="notice" key={notice.id}>
          <span>{notice.text}</span>
          <button type="button" className="btn btn-icon" aria-label={L2.dismiss} onClick={() => dismissNotice(notice.id)}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}
    </div>
  );
}
