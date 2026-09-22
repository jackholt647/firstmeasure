import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_TERMINOLOGY_MODEL = "gpt-test";
process.env.TERMINOLOGY_AI_DISABLED = "0";

test("terminology agent drops model changes outside the supplied catalog", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-openai-key");
    return new Response(JSON.stringify({
      id: "resp_test",
      model: "gpt-test",
      output_text: JSON.stringify({
        message: "I prepared one draft.",
        changes: [
          { key: "money.receipt", value: "Purchase document" },
          { key: "not.allowed", value: "Ignored" }
        ],
        focus_keys: ["money.receipt", "not.allowed"]
      })
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const { runTerminologyAgent } = await import("../platform/terminology_agent.js");
    const result = await runTerminologyAgent("Rename receipt", [
      { key: "money.receipt", label: "Receipt singular", section: "Money", value: "Receipt" }
    ]);
    assert.deepEqual(result.changes, [{ key: "money.receipt", value: "Purchase document" }]);
    assert.deepEqual(result.focus_keys, ["money.receipt"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
