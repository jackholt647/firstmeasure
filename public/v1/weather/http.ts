import { upstreamUnavailable } from "./errors.js";

export async function fetchText(url: string, timeoutMs: number, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FirstMateWeather/1.0 (weather reports; contact support@1m8.ai)",
        "Accept": "text/csv, application/json, text/plain, */*",
        ...headers
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw upstreamUnavailable(`Upstream request failed with HTTP ${response.status}.`, {
        url,
        status: response.status,
        body: text.slice(0, 1000)
      });
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw upstreamUnavailable("Upstream request timed out.", { url, timeout_ms: timeoutMs });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
