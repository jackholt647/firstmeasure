export function isTransientProviderFailure(error: unknown): boolean {
  const e = error as { name?: string; code?: string; Code?: string; statusCode?: number; $metadata?: {httpStatusCode?: number} } | null;
  const status = Number(e?.$metadata?.httpStatusCode ?? e?.statusCode);
  return status === 408 || status === 429 || status >= 500 ||
    [e?.name,e?.Code].some(value => ['SlowDown','TimeoutError','AbortError'].includes(String(value))) ||
    ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','solar_provider_busy'].includes(String(e?.code));
}

export async function fetchSolarWithRetry(url: string | URL, init?: RequestInit, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt=0; ; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
      if (![408,429].includes(response.status) && response.status < 500) return response;
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
