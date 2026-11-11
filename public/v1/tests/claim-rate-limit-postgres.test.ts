import assert from "node:assert/strict";
import test from "node:test";

// FM-387: the claim limit shared by every process on every host. Runs through tests/run-embedded-postgres.mjs.
const url = String(process.env.TEST_POSTGRES_URL ?? "");

test("the PostgreSQL claim limit matches the reference and is shared between processes", { skip: !url }, async () => {
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = url;
  const limit = await import("../firstmeasure/claim-rate-limit.js");
  const database = await import("../src/database/postgres.js");
  try {
    const warnings: unknown[] = [];
    const log = { warn: (object: unknown) => warnings.push(object) } as any;

    // A burst, a repeat burst right after its block (one minute), a script still looping (one minute),
    // a pause of over a minute (short again),
    // and a slow steady clicker: the store answers exactly as the reference step does.
    const times: number[] = [];
    for (let index = 0; index < 15; index += 1) times.push(1_000 + index * 50);
    for (let index = 0; index < 15; index += 1) times.push(6_600 + index * 50);
    for (let index = 0; index < 12; index += 1) times.push(70_000 + index * 50);
    for (let index = 0; index < 12; index += 1) times.push(200_000 + index * 50);
    for (let index = 0; index < 40; index += 1) times.push(400_000 + index * 600);
    const blocks: number[] = [];
    let state: import("../firstmeasure/claim-rate-limit.js").ClaimLimitState = { attempts: [], blockedUntil: 0 };
    for (const now of times) {
      const expected = limit.stepClaimLimit(state, now);
      state = expected.state;
      if (expected.started) blocks.push(expected.started.blockMs);
      // A fresh process each time: nothing remembered locally, so every answer comes from the store.
      limit.resetClaimRateLimits();
      const actual = await limit.recordClaimAttempt("Looper@Example.test", log, now);
      assert.equal(actual.allowed, expected.allowed, `allowed at ${now}`);
      assert.deepEqual(actual.started, expected.started, `block start at ${now}`);
      if (!expected.allowed) assert.equal(actual.blockedUntil, expected.state.blockedUntil, `block end at ${now}`);
    }
    assert.deepEqual(blocks, [limit.SHORT_BLOCK_MS, limit.LONG_BLOCK_MS, limit.LONG_BLOCK_MS, limit.SHORT_BLOCK_MS]);
    assert.equal(warnings.length, blocks.length, "one warning per block");

    // Concurrent attempts from many processes: exactly ten get through and one starts the block.
    limit.resetClaimRateLimits();
    const results = await Promise.all(Array.from({ length: 25 }, () => limit.recordClaimAttempt("racer@example.test", undefined, 1_000_000)));
    assert.equal(results.filter((result) => result.allowed).length, limit.CLAIM_LIMIT);
    assert.equal(results.filter((result) => result.started).length, 1);
  } finally {
    await database.closePostgresPools();
  }
});
