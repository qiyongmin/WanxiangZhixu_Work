import { useState } from 'react';
import { L3 } from '../../lib/labels';
import { AppLink } from '../AppLink';
import { AgentActivity } from './AgentActivity';
import { AgentJournal } from './AgentJournal';
import { ProviderConnections } from './ProviderConnections';

interface Endpoint {
  method: 'GET' | 'POST';
  route: string;
  purpose: string;
  required: string;
}

interface CliCommand {
  name: string;
  params: string;
  example: string;
}

const API = '/api/work-hub/agent/';

/** Static documentation: mirrors GET_ROUTES / POST_ROUTES in tools/work_hub_agent.py. */
export const ENDPOINTS: Endpoint[] = [
  { method: 'GET', route: 'node', purpose: 'Read a node', required: 'one of node | nodeId | nodePath' },
  { method: 'GET', route: 'children', purpose: 'List child nodes', required: 'one of node | nodeId | nodePath' },
  { method: 'GET', route: 'search', purpose: 'Search nodes', required: 'q' },
  { method: 'GET', route: 'proposal', purpose: 'Read the state of a Change_Proposal', required: 'id' },
  { method: 'POST', route: 'note', purpose: 'Add a Note (unconfirmed)', required: 'actor, node locator, baseRevision, title, markdown or html' },
  { method: 'POST', route: 'material', purpose: 'Attach a file or link (unconfirmed)', required: 'actor, node locator, baseRevision, type, url or fileId' },
  { method: 'POST', route: 'report', purpose: 'Upload a Markdown / HTML report (unconfirmed)', required: 'actor, node locator, baseRevision, title, format, content' },
  { method: 'POST', route: 'summary', purpose: 'Replace the Summary_Block (unconfirmed)', required: 'actor, node locator, baseRevision, markdown' },
  { method: 'POST', route: 'task', purpose: 'Add a Task (always Planned)', required: 'actor, parent, title' },
  { method: 'POST', route: 'proposal', purpose: 'Submit a Change_Proposal (person-only fields)', required: 'actor, node locator, baseRevision, changes, rationale' },
];

export const CLI_COMMANDS: CliCommand[] = [
  { name: 'node', params: '--node', example: 'python3 tools/kbw.py node --node "Section/Item"' },
  { name: 'children', params: '--node [--limit] [--offset]', example: 'python3 tools/kbw.py children --node "Section/Item"' },
  { name: 'search', params: '--query [--limit] [--offset] [--section]', example: 'python3 tools/kbw.py search --query "milestone"' },
  { name: 'add-note', params: '--actor --node --title (--markdown | --markdown-file | --html-file) [--base-revision]', example: 'python3 tools/kbw.py add-note --actor agent:kiro --node "Section/Item" --title "Weekly report" --markdown-file note.md' },
  { name: 'add-material', params: '--actor --node --type (link | file) [--title] [--url | --file-id]', example: 'python3 tools/kbw.py add-material --actor agent:kiro --node "Section/Item" --type link --url https://example.com' },
  { name: 'upload-report', params: '--actor --node --title --file [--format]', example: 'python3 tools/kbw.py upload-report --actor agent:kiro --node "Section/Item" --title "Analysis report" --file report.md' },
  { name: 'set-summary', params: '--actor --node (--markdown | --markdown-file)', example: 'python3 tools/kbw.py set-summary --actor agent:kiro --node "Section/Item" --markdown-file summary.md' },
  { name: 'add-task', params: '--actor --parent --title [--description] [--priority] [--tag]', example: 'python3 tools/kbw.py add-task --actor agent:kiro --parent "Section/Item" --title "Follow up on review"' },
  { name: 'propose', params: '--actor --node --changes --rationale [--evidence]', example: "python3 tools/kbw.py propose --actor agent:kiro --node \"Section/Item\" --changes '{\"status\":\"Blocked\"}' --rationale \"Waiting on dependency\"" },
  { name: 'proposal-status', params: '--id', example: 'python3 tools/kbw.py proposal-status --id proposal-…' },
];

/** Agent Access groups connections, all local activity, and on-demand Work Agent review. */
export function AgentAccess({section='connections'}:{section?:'connections'|'activities'}) {
  const [fullWorkHistory,setFullWorkHistory]=useState(false);
  return (
    <section className="page agent-access" aria-labelledby="page-title">
      <div className="agent-access-heading"><span className="agent-access-eyebrow">AGENT PLATFORM</span>
        <h1 id="page-title">{L3.accessHeading}</h1>
        <p className="muted">Manage Agent connections and review local Work/AI Resources audit events.</p>
      </div>
      <nav className="agent-access-tabs" aria-label="Agent Access sections">
        <AppLink to="/agent/access" className={section==='connections'?'is-active':''}>
          Connections &amp; API
        </AppLink>
        <AppLink to="/agent/access?tab=activities" className={section==='activities'?'is-active':''}>
          Agent Activities
        </AppLink>
      </nav>
      {section==='connections'?<>
      <ProviderConnections />
      <div className="agent-access-reference-head"><h2>Reference &amp; maintenance</h2><p className="muted">Technical details stay available on demand, instead of taking over the first screen.</p></div>
      <details className="agent-access-disclosure" aria-labelledby="access-api">
        <summary><h2 id="access-api">{L3.accessApi}</h2><span className="muted">Work Hub API endpoints</span></summary>
        <table className="agent-table">
          <thead>
            <tr>
              <th scope="col">{L3.accessName}</th>
              <th scope="col">{L3.accessPurpose}</th>
              <th scope="col">{L3.accessParams}</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((item) => (
              <tr key={`${item.method}-${item.route}`}>
                <td>
                  <code>
                    {item.method} {API}
                    {item.route}
                  </code>
                </td>
                <td>{item.purpose}</td>
                <td>{item.required}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details className="agent-access-disclosure" aria-labelledby="access-cli">
        <summary><h2 id="access-cli">{L3.accessCli}</h2><span className="muted">Local CLI usage</span></summary>
        <table className="agent-table">
          <thead>
            <tr>
              <th scope="col">{L3.accessName}</th>
              <th scope="col">{L3.accessParams}</th>
              <th scope="col">{L3.accessExample}</th>
            </tr>
          </thead>
          <tbody>
            {CLI_COMMANDS.map((item) => (
              <tr key={item.name}>
                <td>
                  <code>{item.name}</code>
                </td>
                <td>{item.params}</td>
                <td>
                  <code className="cli-example">{item.example}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="agent-access-resource-link">
        <strong>Project Skills</strong>
        <p className="muted">All Skills, including original Project Skills, are managed locally in AI Resources.</p>
        <AppLink to="/resources/skills" className="btn"><span>Open Skills Library</span></AppLink>
      </div>


      </> : <>
        <AgentJournal onManageWrites={()=>setFullWorkHistory(current=>!current)}/>
        {fullWorkHistory && <AgentActivity embedded/>}
      </>}
    </section>
  );
}
