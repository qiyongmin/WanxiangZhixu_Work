import { useState } from 'react';
import { post } from '../lib/api';
import { describeError } from '../lib/errors';
import { englishOr } from '../lib/errorMessages';
import { L } from '../lib/labels';
import { invalidate } from '../lib/queryCache';
import type { BackupResult, BackupStatus, MigrationReport } from '../lib/types';

export const CLI_COMMANDS = ['python3 tools/work_backup.py create', 'python3 tools/work_migrate.py apply'] as const;

interface Props {
  backup?: BackupStatus | undefined;
}

type Busy = 'backup' | 'migrate' | null;

/** 数据库未迁移时的全页升级页（Req 33.2）：创建备份 → 执行迁移；失败时库保持不变。 */
export function MigrationGate({ backup }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [created, setCreated] = useState<BackupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const backupOk = created !== null || backup?.ok === true;

  const createBackup = async () => {
    setBusy('backup');
    setError(null);
    try {
      setCreated(await post<BackupResult>('backup-create', {}, { timeoutMs: 130_000 }));
      invalidate('schema');
    } catch (failure) {
      setError(`${L.backupFailed}: ${describeError(failure)}`);
    } finally {
      setBusy(null);
    }
  };

  const migrate = async () => {
    setBusy('migrate');
    setError(null);
    try {
      await post<MigrationReport>('migrate', {}, { timeoutMs: 130_000 });
      setDone(true);
      invalidate('');
    } catch (failure) {
      setError(`${L.migrateFailed}: ${describeError(failure)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="gate" aria-labelledby="gate-title">
      <div className="gate-card">
        <h1 id="gate-title">{L.migrateTitle}</h1>
        <p>{L.migrateIntro}</p>

        <section aria-labelledby="gate-backup">
          <h2 id="gate-backup">{L.migrateBackupStatus}</h2>
          <p>
            {backupOk ? L.migrateBackupOk : L.migrateBackupMissing}
            {!backupOk && englishOr(backup?.reason, '') ? ` (${englishOr(backup?.reason, '')})` : ''}
          </p>
          {created ? (
            <dl className="kv">
              <dt>{L.migrateBackupCreated}</dt>
              <dd />
              <dt>{L.backupPath}</dt>
              <dd>
                <code>{created.path}</code>
              </dd>
              <dt>{L.backupSha}</dt>
              <dd>
                <code>{created.sha256}</code>
              </dd>
            </dl>
          ) : null}
        </section>

        <section aria-labelledby="gate-cli">
          <h2 id="gate-cli">{L.migrateCli}</h2>
          <ul className="cli-list">
            {CLI_COMMANDS.map((command) => (
              <li key={command}>
                <code>{command}</code>
              </li>
            ))}
          </ul>
        </section>

        <div className="gate-actions">
          <button type="button" className="btn" disabled={busy !== null || done} onClick={() => void createBackup()}>
            {busy === 'backup' ? L.working : L.migrateCreateBackup}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null || done}
            onClick={() => void migrate()}
          >
            {busy === 'migrate' ? L.working : L.migrateRun}
          </button>
        </div>

        <div role="status" aria-live="polite">
          {done ? <p>{L.migrateDone}</p> : null}
        </div>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
