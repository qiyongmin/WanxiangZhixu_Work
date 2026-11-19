import { useState } from 'react';
import { postBinary } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { Icon } from '../icons';

/** Open only a File Hub canonical file's containing folder on the trusted WSL/Windows host. */
export function OpenStorageLocation({ fileId, name }: { fileId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const open = async () => {
    if (busy) return;
    setBusy(true); setStatus(null);
    try {
      const result = await postBinary<{ requested: boolean; windowsFolder?: string }>(
        '/api/file-hub/open-location',
        new Blob([JSON.stringify({ fileId })], { type: 'application/json' }),
        'application/json',
      );
      setStatus(result.windowsFolder
        ? `已请求打开万象知序存储目录：${result.windowsFolder}`
        : '已向 Windows 请求打开文件所在目录。');
    } catch (error) {
      setStatus(`无法在当前设备打开服务器目录：${describeError(error)}。可以下载原件查看。`);
    } finally {
      setBusy(false);
    }
  };
  return <span className="file-open-location">
    <button type="button" className="material-icon-btn" disabled={busy}
      title={`在存储目录中打开：${name}`}
      aria-label={`Open storage location: ${name}`} onClick={() => void open()}>
      <Icon name="folder" size={17}/>
    </button>
    {status ? <span className="file-open-status" role="status">{status}</span> : null}
  </span>;
}
