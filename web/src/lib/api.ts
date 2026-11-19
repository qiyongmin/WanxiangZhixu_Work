// 与 /api/work-hub 通信：统一解析 {ok,data} / {ok:false,error,code,details}（设计 5、6.4）。
import { localizeReason, safeMessage } from './errorMessages';
import type { CurrentNodeView, FieldProblem } from './types';

export const API_ROUTE = '/api/work-hub';
export const DEFAULT_TIMEOUT_MS = 5000;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly current: CurrentNodeView | undefined;
  readonly currentRevision: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    current?: CurrentNodeView,
    currentRevision?: number,
  ) {
    // The backend message is Chinese: only a code-based (or already English) message is exposed.
    super(safeMessage(message, code, status));
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.current = current;
    this.currentRevision = currentRevision;
  }

  /** 400 校验失败时逐项列出的字段原因。 */
  get fields(): FieldProblem[] {
    const raw = this.details?.fields;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (item): item is FieldProblem =>
          typeof item === 'object' && item !== null && typeof (item as FieldProblem).field === 'string',
      )
      .map((item) => ({ ...item, reason: localizeReason(typeof item.reason === 'string' ? item.reason : '') }));
  }
}

export class TimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class NetworkError extends Error {
  constructor(message = 'Network error') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type Params = Record<string, string | number | boolean | null | undefined>;

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function send<T>(url: string, init: RequestInit, options: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const external = options.signal;
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new TimeoutError();
      if (isAbort(error)) throw error;
      throw new NetworkError();
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (timedOut) throw new TimeoutError();
      if (isAbort(error)) throw error;
      payload = null;
    }
    return unwrap<T>(response.status, payload);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

export function unwrap<T>(status: number, payload: unknown): T {
  const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
  if (body && body.ok === true && status >= 200 && status < 300) return body.data as T;
  if (body && body.ok === false) {
    throw new ApiError(
      status,
      typeof body.code === 'string' ? body.code : 'unknown_error',
      typeof body.error === 'string' ? body.error : '',
      typeof body.details === 'object' && body.details !== null ? (body.details as Record<string, unknown>) : undefined,
      typeof body.current === 'object' && body.current !== null ? (body.current as CurrentNodeView) : undefined,
      typeof body.currentRevision === 'number' ? body.currentRevision : undefined,
    );
  }
  throw new ApiError(status, 'bad_response', '');
}

export function get<T>(view: string, params: Params = {}, options: RequestOptions = {}): Promise<T> {
  const query = new URLSearchParams({ view });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  return send<T>(`${API_ROUTE}?${query.toString()}`, { method: 'GET', headers: { Accept: 'application/json' } }, options);
}

export function post<T>(action: string, body: object = {}, options: RequestOptions = {}): Promise<T> {
  return send<T>(
    API_ROUTE,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, action }),
    },
    options,
  );
}

/** 读取任意同源 `{ok,data}` JSON 端点（File Hub 文本预览等）。 */
export function getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  return send<T>(url, { method: 'GET', headers: { Accept: 'application/json' } }, options);
}

/** 二进制上传（Note 图片、File Hub 上传）：返回 {ok,data} 信封中的 data。 */
export function postBinary<T>(url: string, body: Blob, contentType: string, options: RequestOptions = {}): Promise<T> {
  return send<T>(
    url,
    { method: 'POST', headers: { 'Content-Type': contentType, Accept: 'application/json' }, body },
    { timeoutMs: 60_000, ...options },
  );
}

/** File Hub 的 JSON 动作（例如创建文件夹）。 */
export function postFileHub<T>(body: object, options: RequestOptions = {}): Promise<T> {
  return send<T>(
    '/api/file-hub',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
    options,
  );
}

/** 请求是否因数据库尚未迁移而被拒绝（MigrationGate 触发条件）。 */
export function isMigrationRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'migration_required';
}
