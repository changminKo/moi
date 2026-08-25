import type { ApiErrorBody } from './api-types';
import { readRuntimeConfig } from './runtime-config';

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfter: number | undefined;
  readonly requestId: string;

  constructor(body: ApiErrorBody, status: number) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.retryable = body.retryable;
    this.retryAfter = body.retryAfter;
    this.requestId = body.requestId;
    this.status = status;
  }

  readonly status: number;
}

type RequestOptions = Readonly<{
  idempotencyKey?: string;
  signal?: AbortSignal;
}>;
type ClientOptions = Readonly<{
  origin?: string;
  fetchImpl?: typeof fetch;
  getCsrfToken?: () => string | undefined;
}>;

export type ApiClient = Readonly<{
  request<T>(
    path: string,
    init?: RequestInit,
    options?: RequestOptions,
  ): Promise<T>;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
  getCsrfToken: () => string | undefined;
}>;

let currentCsrfToken: string | undefined;
export function setCsrfToken(token: string | undefined): void {
  currentCsrfToken = token;
}

function isWrite(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

export function createApiClient(options: ClientOptions = {}): ApiClient {
  const config = readRuntimeConfig({
    apiOrigin: options.origin ?? window.location.origin,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const getCsrfToken = options.getCsrfToken ?? (() => currentCsrfToken);

  async function request<T>(
    path: string,
    init: RequestInit = {},
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (init.body !== undefined && !headers['content-type'])
      headers['Content-Type'] = 'application/json';
    if (isWrite(method)) {
      const csrfToken = getCsrfToken();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      if (requestOptions.idempotencyKey)
        headers['Idempotency-Key'] = requestOptions.idempotencyKey;
    }
    const requestInit: RequestInit = {
      ...init,
      method,
      credentials: 'include',
      headers,
    };
    const signal = requestOptions.signal ?? init.signal;
    if (signal !== undefined) requestInit.signal = signal;
    const response = await fetchImpl(
      new URL(path, config.apiOrigin).toString(),
      requestInit,
    );
    const body = await parseJson(response);
    if (!response.ok) {
      const error = body as Partial<ApiErrorBody>;
      throw new ApiError(
        {
          code: typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
          message:
            typeof error.message === 'string'
              ? error.message
              : `Request failed (${response.status})`,
          retryable: error.retryable === true,
          ...(typeof error.retryAfter === 'number'
            ? { retryAfter: error.retryAfter }
            : {}),
          requestId:
            typeof error.requestId === 'string' ? error.requestId : 'unknown',
        },
        response.status,
      );
    }
    return body as T;
  }

  const json =
    (method: string) =>
    <T>(path: string, body?: unknown, requestOptions?: RequestOptions) => {
      const init: RequestInit = { method };
      if (body !== undefined) init.body = JSON.stringify(body);
      return request<T>(path, init, requestOptions);
    };
  return {
    request,
    get: <T>(path: string, requestOptions?: RequestOptions) =>
      request<T>(path, undefined, requestOptions),
    post: json('POST'),
    put: json('PUT'),
    delete: <T>(path: string, requestOptions?: RequestOptions) =>
      request<T>(path, { method: 'DELETE' }, requestOptions),
    getCsrfToken,
  };
}

export const apiClient = createApiClient();
