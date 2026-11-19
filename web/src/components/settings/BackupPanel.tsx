import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { L, L4 } from '../../lib/labels';
import { adminApi } from '../../lib/phase4';
import { invalidate } from '../../lib/queryCache';
import type { AcceptanceCheck, BackupVerifyReport, CheckStatus } from '../../lib/types';
import { englishOr } from '../../lib/errorMessages';

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: L4.checkPass,
  fail: L4.checkFail,
  pending: L4.checkPending,
};

/** Human-readable names for checks still needed to verify backups and Work data. */
export function checkLabel(name: string, serverLabel: string): string {
  return L4.checkNames[name] ?? englishOr(serverLabel, name);
}
export function categoryLabel(category: string, serverLabel: string): string {
  return L4.categoryNames[category] ?? englishOr(serverLabel, category);
}

export function VerifyTable({ report }: { report: BackupVerifyReport }) {
  return (
    <div className="verify-report">
      <p role="status" className={report.passed ? undefined : 'error-text'}>
        {report.passed ? L4.backupVerifyPassed : L4.backupVerifyFailed}
      </p>
      {report.rows.length > 0 ? (
        <table className="agent-table">
          <thead><tr>
            <th scope="col">{L4.backupCategory}</th>
            <th scope="col">{L4.backupSource}</th>
            <th scope="col">{L4.backupRestored}</th>
            <th scope="col">{L4.backupResult}</th>
          </tr></thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.category} data-category={row.category}>
                <th scope="row">{categoryLabel(row.category, row.label)}</th>
                <td>{row.source}</td><td>{row.restored}</td>
                <td>{row.match ? L4.backupMatch : L4.backupMismatch}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {report.failures.length ? (
        <div role="alert"><p className="error-text">{L4.backupFailedCategories}</p>
          <ul>{report.failures.map((item) => (
            <li key={`${item.category}:${item.reason}`}>
              <strong>{categoryLabel(item.category, item.label)}</strong>: {englishOr(item.reason, L4.reasonFallback)}
            </li>
          ))}</ul>
        </div>
      ) : null}
    </div>
  );
}

export function Checklist({ checks }: { checks: AcceptanceCheck[] }) {
  return (
    <ul className="checklist" aria-label={L4.checklist}>
      {checks.map((check) => (
        <li key={check.name} data-check={check.name} data-status={check.status}>
          <span className="check-status">{STATUS_LABEL[check.status]}</span>{' '}
          <strong>{checkLabel(check.name, check.label)}</strong>
          {check.status !== 'pass' && check.detail ? <p className="muted">{englishOr(check.detail, L4.checkDetailFallback)}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** The V1/V2 Shell switch and UI rollback have been retired.
 * Backup, integrity, export and business Revision recovery remain intact. */
export function BackupPanel() {
  const [busy, setBusy] = useState<'backup' | 'verify' | 'check' | null>(null);
  const [created, setCreated] = useState<{ path: string; sha256: string } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [report, setReport] = useState<BackupVerifyReport | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const createBackup = async () => {
    setBusy('backup'); setBackupError(null); setCreated(null);
    try { setCreated(await adminApi.backup()); invalidate('schema'); }
    catch (error) { setBackupError(`${L4.backupFailedPrefix}: ${describeError(error)}`); }
    finally { setBusy(null); }
  };
  const verifyBackup = async () => {
    setBusy('verify'); setVerifyError(null); setReport(null);
    try { setReport(await adminApi.verify()); }
    catch (error) { setVerifyError(`${L4.backupVerifyFailed}: ${describeError(error)}`); }
    finally { setBusy(null); }
  };
  return (
    <>
      <section aria-labelledby="settings-backup" className="settings-group">
        <h2 id="settings-backup">{L4.backupHeading}</h2>
        <div className="button-row">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void createBackup()}>
            {busy === 'backup' ? L.working : L4.backupCreate}
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void verifyBackup()}>
            {busy === 'verify' ? L4.backupVerifyRunning : L4.backupVerify}
          </button>
        </div>
        {created ? (
          <dl className="kv" data-testid="backup-created">
            <dt>{L4.backupCreated}</dt><dd/>
            <dt>{L.backupPath}</dt><dd><code>{created.path}</code></dd>
            <dt>{L.backupSha}</dt><dd><code>{created.sha256}</code></dd>
          </dl>
        ) : null}
        {backupError ? <p className="error-text" role="alert">{backupError}</p> : null}
        {report ? <VerifyTable report={report}/> : null}
        {verifyError ? <p className="error-text" role="alert">{verifyError}</p> : null}
        <h3>{L4.exportHeading}</h3>
        <p><a className="btn" href="/api/work-hub/export" download="work-hub-snapshot.zip">{L4.exportLink}</a></p>
      </section>
    </>
  );
}
