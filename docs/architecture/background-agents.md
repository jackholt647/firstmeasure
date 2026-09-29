# Background agent decisions

The existing agent architecture remains the execution engine: registered definitions,
shared settings/model configuration, `runAgentTurn` for conversational threads,
`runAgentOnce` for threadless work, and existing scheduled wakeups. Publication tools
refresh the current user context and apply normal service permissions.

`public/v1/agents/background.ts` adds a reusable bounded decision wrapper. A trusted
caller registers a task kind with input/result JSON schemas, timeout and an execute
handler, then calls `runBackgroundTask` with organization, acting user and stable key.
Handlers are analysis-only: reads and proposals, with effects applied separately by
the host. This contract is for trusted handler implementations, not arbitrary modules.

The agents database retains input, principal, state, deadline, claim token, result,
error and audit. Duplicate keys reuse completed results or immediately select the
caller fallback. A deadline aborts the model request and rejects late results. A
crashed running task is marked fallback on a later lookup after its deadline. There
is no user-input state. The caller must define and execute its default behavior.
Never use this wrapper as an unattended approval path for arbitrary business actions.

`runAgentOnce` now accepts `signal`, `maxDurationMs` and `checkLease`. Model requests
combine caller cancellation with the existing request timeout. These options also
bound rounds and tool boundaries; tools should themselves remain bounded. The
wrapper rejects a late result even when an underlying read finishes after abort.
No credentials, providers or model choices are duplicated in this layer.

The first registered consumer is notification rule repair. It uses the existing
notification assistant settings, a restricted read-only tool set and one structured
proposal tool. Notification delivery validates proposed code, checks regression
samples, commits a rule revision and logs the reason. If any stage fails, normal
notification behavior runs with its existing opt-outs and quiet hours.

Tests use isolated local storage and a mocked model response for successful repair.
They cover duplicate task claims, deadline/default behavior, late-result rejection,
rule revision persistence and subsequent execution without another model call.
