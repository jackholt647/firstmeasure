export async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "FirstMate-CodeReports/1.0" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function sourceNow() {
  return new Date().toISOString();
}
