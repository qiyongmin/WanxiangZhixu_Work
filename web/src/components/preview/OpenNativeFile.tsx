import { useState } from 'react';
import { postBinary } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { Icon } from '../icons';

/** Opens on the trusted Windows host, not on the remote browser's device. */
export function OpenNativeFile({ fileId, name }: { fileId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const open = async () => {
    if (busy) return;
    setBusy(true); setErrorText(null);
    try {
      await postBinary('/api/file-hub/open-native',
        new Blob([JSON.stringify({ fileId })], { type: 'application/json' }),
        'application/json');
      // No persistent success popover: the button's hover tooltip already explains the action.
    } catch (error) {
      setErrorText(`无法在 Windows 主机打开文件：${describeError(error)}。可改用下载原件。`);
    } finally {
      setBusy(false);
    }
  };
  return <span className="file-open-location">
    <button type="button" className="material-icon-btn material-native-open" disabled={busy}
      title={`使用 Windows 默认应用打开：${name}（在运行 KB_Work 的 Windows 电脑上）`}
      aria-label={`Windows 打开文件: ${name}`} onClick={() => void open()}>
      <Icon name="open" size={16}/><span>Windows 打开</span>
    </button>
    {errorText ? <span className="file-open-status" role="alert">
      <span>{errorText}</span>
      <button type="button" className="file-open-status-close" aria-label="关闭打开文件错误提示"
        title="关闭提示" onClick={() => setErrorText(null)}>×</button>
    </span> : null}
  </span>;
}
