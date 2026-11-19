// Backend error strings are Chinese. The Shell never displays them: known error codes map to English
// messages here, unknown codes fall back to a generic English message that includes the code.

const MESSAGES: Record<string, string> = {
  revision_conflict: 'This item was changed elsewhere. Your draft is kept.',
  depth_exceeded: 'Nesting is limited to 4 levels.',
  hierarchy_cycle: 'That move would put a node inside its own descendants.',
  multiple_parents: 'A node can have only one parent.',
  section_rule_violation: 'This change violates the Section rule.',
  rule_violations: 'Existing data violates this rule.',
  migration_required: 'The database must be upgraded first.',
  backup_required: 'A recent backup is required first.',
  node_not_found: 'Node not found.',
  parent_deleted: 'The parent node was deleted.',
  parent_required: 'Choose a parent node.',
  has_children: 'This node still has child nodes.',
  has_nodes: 'This Section still contains nodes.',
  summary_too_long: 'Summary is too long (max 5000 characters).',
  invalid_summary: 'Summary is not valid.',
  invalid_markdown: 'Markdown is not valid.',
  payload_too_large: 'The request is too large.',
  note_too_large: 'A note is too large.',
  notes_too_large: 'Notes are too large.',
  markdown_too_large: 'The Markdown content is too large.',
  report_too_large: 'The report is too large.',
  too_many_notes: 'Too many notes (max 50).',
  note_html_invalid: 'Note content contains elements that are not allowed.',
  invalid_request: 'The request is not valid.',
  invalid_body: 'The request is not valid.',
  invalid_state: 'This action is not available in the current state.',
  invalid_parent: 'That parent is not allowed here.',
  invalid_title: 'The title is not valid.',
  invalid_id: 'The identifier is not valid.',
  invalid_ids: 'The identifiers are not valid.',
  invalid_path: 'The path is not valid.',
  invalid_changes: 'The proposed changes are not valid.',
  invalid_enabled: 'The value must be on or off.',
  link_exists: 'This link already exists.',
  link_not_found: 'Link not found.',
  link_scheme_unsupported: 'Only http and https links are supported.',
  link_self: 'A node cannot link to itself.',
  link_target_deleted: 'The link target was deleted.',
  link_relation: 'The relation is not valid.',
  ambiguous_path: 'The path matches more than one node.',
  locator_conflict: 'Give only one node locator.',
  locator_required: 'A node locator is required.',
  actor_invalid: 'The actor is not valid.',
  base_revision_required: 'A base revision is required.',
  duplicate_title: 'That title is already in use.',
  file_hub_unavailable: 'File Hub is not available.',
  file_not_found: 'File not found.',
  material_not_found: 'Material not found.',
  human_owned_field: 'This field can only be changed by a person.',
  modified_since: 'This item was modified after the Agent write.',
  not_unconfirmed: 'This write has already been handled.',
  proposal_closed: 'This proposal has already been handled.',
  proposal_expired: 'The target changed, so this proposal expired.',
  proposal_not_found: 'Proposal not found.',
  approval_failed: 'The proposal could not be approved.',
  acceptance_failed: 'The acceptance checks did not pass.',
  reminder_changed: 'The reminder was changed. Refresh and try again.',
  rollback_target_invalid: 'The rollback target is not valid.',
  section_kind_mismatch: 'That Section does not accept this kind of item.',
  section_limit: 'The Section limit (20) has been reached.',
  section_mismatch: 'The Section does not match the parent.',
  section_not_found: 'Section not found.',
  target_unavailable: 'The target is no longer available.',
  write_not_found: 'Write not found.',
  unknown_endpoint: 'The server does not support this action. Restart the backend and try again.',
  internal_error: 'Unexpected server error.',
  bad_response: 'The server returned an unexpected response.',
};

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;

export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/** English message for an API error code; unknown codes get a generic message with the code. */
export function messageForCode(code: string, status = 0): string {
  const known = MESSAGES[code];
  if (known) return known;
  if (code.startsWith('invalid_')) return 'The request is not valid.';
  if (code.startsWith('link_')) return 'The link could not be saved.';
  if (code === 'unknown_error' || code === '') return status > 0 ? `Request failed (${status})` : 'Request failed';
  return `Request failed (${code})`;
}

/** Keeps messages that are already English; anything with CJK text is replaced by the code-based message. */
export function safeMessage(message: string, code: string, status = 0): string {
  const mapped = MESSAGES[code];
  if (mapped) return mapped;
  return message !== '' && !hasCjk(message) ? message : messageForCode(code, status);
}

/** Per-field validation reasons (400 `details.fields[].reason`) in English. */
export function localizeReason(reason: string): string {
  if (!hasCjk(reason)) return reason;
  const range = /(\d+)\s*\u5230\s*(\d+)\s*\u4e2a\u5b57\u7b26/.exec(reason);
  if (range) return `Must be ${range[1]}–${range[2]} characters`;
  const atMost = /\u4e0d\u80fd\u8d85\u8fc7\s*(\d+)\s*\u4e2a\u5b57\u7b26/.exec(reason);
  if (atMost) return `Must be at most ${atMost[1]} characters`;
  if (/\u5fc5\u586b|\u4e0d\u80fd\u4e3a\u7a7a|\u975e\u7a7a/.test(reason)) return 'Required';
  if (/\u6b63\u6574\u6570/.test(reason)) return 'Must be a positive integer';
  if (/\u5b57\u7b26\u4e32|\u6587\u672c/.test(reason)) return 'Must be text';
  if (/\u65e5\u671f/.test(reason)) return 'Not a valid date';
  if (/\u65e5\u671f/.test(reason)) return 'Not a valid date';
  if (/\u4e0d\u652f\u6301/.test(reason)) return 'Not supported';
  if (/\u4e0d\u4e00\u81f4|\u4e0d\u5339\u914d/.test(reason)) return 'Does not match';
  return 'Invalid value';
}

/** Backend-provided display text (check details, reasons) is shown only when it is already English. */
export function englishOr(text: string | null | undefined, fallback: string): string {
  return text && !hasCjk(text) ? text : fallback;
}
