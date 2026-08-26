import { env } from "../src/config/env.js";

export async function generateGeminiSummary(input: {
  headline: string;
  findings: unknown[];
  records: unknown[];
  limitations: string[];
}, timeoutMs: number): Promise<string | null> {
  if (!env.geminiApiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: [
              "Write a concise non-certified forensic weather report summary for a roofing/customer report.",
              "Do not claim meteorologist certification. Mention limitations and source uncertainty plainly.",
              JSON.stringify(input).slice(0, 80_000)
            ].join("\n\n")
          }]
        }]
      })
    });
    if (!response.ok) return null;
    const json = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
