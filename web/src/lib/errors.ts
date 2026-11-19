// Turns request errors into English messages (ApiError already carries a code-mapped English message).
import { ApiError, NetworkError, TimeoutError } from './api';
import { L } from './labels';

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message || L.errorGeneric;
  if (error instanceof TimeoutError) return L.errorTimeout;
  if (error instanceof NetworkError) return L.errorNetwork;
  return L.errorGeneric;
}
