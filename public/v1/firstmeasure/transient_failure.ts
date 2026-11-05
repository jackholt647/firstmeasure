// Failures that a later attempt can be expected to get past: provider throttling and outages, network
// transport drops, and this host's own database pool or connection running short under load (FM-338:
// "timeout exceeded when trying to connect" from pg-pool during a burst of orders was treated as a
// permanent imagery failure, and those orders reached the drafting queue without map assets).
const TRANSIENT_NAMES = new Set(['SlowDown','TimeoutError','AbortError','RequestTimeout','ServiceUnavailable','InternalError','ThrottlingException']);
const TRANSIENT_CODES = new Set([
  'ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','EPIPE','ENETUNREACH','EHOSTUNREACH','ECONNABORTED',
  'UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_CLOSED',
  'solar_provider_busy',
  // PostgreSQL: too many connections, shutdown/restart, cannot connect now, serialization failure, deadlock.
  '53300','57P01','57P02','57P03','40001','40P01'
]);
const TRANSIENT_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /Connection terminated/i,
  /connection error and is not queryable/i
];

export function isTransientProviderFailure(error: unknown, depth = 0): boolean {
  const e = error as { name?: string; code?: string | number; Code?: string; statusCode?: number; message?: string; cause?: unknown; $metadata?: {httpStatusCode?: number} } | null;
  if (!e || typeof e !== 'object') return false;
  const status = Number(e.$metadata?.httpStatusCode ?? e.statusCode);
  const code = String(e.code ?? '');
  if (status === 408 || status === 429 || status >= 500) return true;
  if ([e.name, e.Code].some(value => TRANSIENT_NAMES.has(String(value)))) return true;
  if (TRANSIENT_CODES.has(code) || code.startsWith('08')) return true; // 08xxx: PostgreSQL connection exception
  if (TRANSIENT_MESSAGES.some(pattern => pattern.test(String(e.message ?? '')))) return true;
  // fetch() wraps transport failures in TypeError('fetch failed' / 'terminated') with the reason in `cause`.
  return depth < 3 && e.cause != null && e.cause !== error && isTransientProviderFailure(e.cause, depth + 1);
}

export function isTransientHttpStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

export async function fetchSolarWithRetry(url: string | URL, init?: RequestInit, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt=0; ; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
      if (!isTransientHttpStatus(response.status)) return response;
      if (attempt >= 2) return response;
      await response.body?.cancel();
      throw Object.assign(new Error('Solar provider is temporarily unavailable.'), {code:'solar_provider_busy',statusCode:503});
    } catch (error) {
      const transient = isTransientProviderFailure(error) || error instanceof TypeError;
      if (!transient) throw error;
      if (attempt >= 2) throw Object.assign(new Error('Solar provider transport failed; retry later.'), {code:'solar_provider_busy',statusCode:503});
      await sleep(250 * 2 ** attempt + Math.floor(Math.random()*250));
    }
  }
}
