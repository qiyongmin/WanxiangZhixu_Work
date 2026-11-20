import { useState } from 'react';
import { postBinary } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { Icon } from '../icons';

/** Open only a File Hub canonical file's containing folder on the trusted WSL/Windows host. */
export function OpenStorageLocation({ fileId, name }: { fileId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const open = async () => {
    if (busy) return;
    setBusy(true); setErrorText(null);
    try {
      await postBinary('/api/file-hub/open-location',
        new Blob([JSON.stringify({ fileId })], { type: 'application/json' }),
        'application/json',
      );
      // Successful open needs no persistent popover; hover title explains this action.
    } catch (error) {
      setErrorText(`无法在 Windows 主机打开文件所在目录：${describeError(error)}。可以下载原件查看。`);
    } finally {
      setBusy(false);
    }
  };
  return <span className="file-open-location">
    <button type="button" className="material-icon-btn" disabled={busy}
      title={`在运行 KB_Work 的 Windows 电脑上打开所在目录：${name}`}
      aria-label={`Open storage location: ${name}`} onClick={() => void open()}>
      <Icon name="folder" size={17}/>
    </button>
    {errorText ? <span className="file-open-status" role="alert">
      <span>{errorText}</span>
      <button type="button" className="file-open-status-close" aria-label="关闭打开目录错误提示"
        title="关闭提示" onClick={() => setErrorText(null)}>×</button>
    </span> : null}
  </span>;
}
