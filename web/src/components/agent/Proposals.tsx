import { useState } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { formatTimestamp } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import { L, L3 } from '../../lib/labels';
import { invalidateTaskData } from '../../lib/nodeData';
import { invalidate, useQuery } from '../../lib/queryCache';
import { nodePath } from '../../lib/router';
import type { ProposalDTO } from '../../lib/types';
import { useAnnounce } from '../announce';
import { AppLink } from '../AppLink';

const KEY = 'proposals:pending';

const show = (value: unknown): string => (value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value));

/** 批准 / 拒绝失败的提示：过期、已处理、违反规则（含具体规则原因）。 */
export function decisionMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'proposal_expired') return L3.proposalExpired;
    if (error.code === 'proposal_closed') return L3.proposalClosed;
    if (error.status === 400 || error.status === 422) {
      const reasons = error.fields.map((item) => item.reason).filter(Boolean);
      return `${L3.proposalViolation}: ${[error.message, ...reasons.filter((r) => r !== error.message)].join('; ')}`;
    }
  }
  return `${L.opFailed}: ${describeError(error)}`;
}

function Diff({ proposal }: { proposal: ProposalDTO }) {
  const before = proposal.before ?? {};
  const after = proposal.after ?? {};
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  return (
    <table className="agent-table proposal-diff">
      <thead>
        <tr>
          <th scope="col">{L3.proposalField}</th>
          <th scope="col">{L3.proposalBefore}</th>
          <th scope="col">{L3.proposalAfter}</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr key={key}>
            <th scope="row">{key}</th>
            <td className="diff-before">{show(before[key])}</td>
            <td className="diff-after">{show(after[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProposalCard({ proposal, onDone }: { proposal: ProposalDTO; onDone: (notice?: string) => void }) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const decide = async (action: 'proposal-approve' | 'proposal-reject') => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await post(action, { id: proposal.id });
      announce(action === 'proposal-approve' ? L3.proposalApproved : L3.proposalRejected);
      invalidateTaskData();
      invalidate('agent-writes');
      onDone();
    } catch (error) {
      const text = decisionMessage(error);
      setMessage(text);
      announce(text);
      // 过期 / 已处理的提案不再是 pending，列表刷新后会消失，所以把原因同时显示在页面顶部。
      if (error instanceof ApiError && (error.code === 'proposal_expired' || error.code === 'proposal_closed')) onDone(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="proposal-card" data-proposal-id={proposal.id}>
      <header className="proposal-head">
        <h2>
          {proposal.nodePath ? <AppLink to={nodePath(proposal.nodeId)}>{proposal.nodePath}</AppLink> : proposal.nodeId}
        </h2>
        <span className="muted">
          {L3.proposalProposer}: {proposal.proposer ?? '—'} · {formatTimestamp(proposal.createdAt)}
        </span>
        {proposal.stale ? <span className="flag flag-overdue">{L3.proposalStale}</span> : null}
      </header>
      <Diff proposal={proposal} />
      <p>
        <strong>{L3.proposalRationale}: </strong>
        {proposal.rationale}
      </p>
      {proposal.evidence.length > 0 ? (
        <div>
          <strong>{L3.proposalEvidence}: </strong>
          <ul>
            {proposal.evidence.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="error-text">
          {message}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('proposal-approve')}>
          {L3.proposalApprove}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void decide('proposal-reject')}>
          {L3.proposalReject}
        </button>
      </div>
    </article>
  );
}

/** Proposals（`/proposals`）：只列 pending，按提交时间倒序。 */
export function Proposals() {
  const query = useQuery<ProposalDTO[]>(KEY, (signal) => get<ProposalDTO[]>('change-proposals', { status: 'pending' }, { signal }), {
    staleMs: 0,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const reload = (message?: string) => {
    setNotice(message ?? null);
    void query.refetch();
  };
  const rows = (query.data ?? []).filter((item) => item.status === 'pending');
  return (
    <section className="page proposals" aria-labelledby="page-title">
      <h1 id="page-title">{L3.proposalsHeading}</h1>
      {notice ? (
        <p role="alert" className="error-text proposal-notice">
          {notice}
        </p>
      ) : null}
      {query.status === 'error' && !query.data ? (
        <div className="error-bar" role="alert">
          <span>{describeError(query.error)}</span>
          <button type="button" className="btn" onClick={() => reload()}>
            {L.retry}
          </button>
        </div>
      ) : null}
      {!query.data && query.status !== 'error' ? (
        <p className="muted" role="status">
          {L.loading}
        </p>
      ) : null}
      {query.data && rows.length === 0 ? <p className="muted">{L3.proposalsEmpty}</p> : null}
      {rows.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} onDone={reload} />
      ))}
    </section>
  );
}
