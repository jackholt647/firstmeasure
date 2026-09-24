# Global FirstMate assistant

The assistant in the portal top bar is agent id `assistant`. Its declaration is
`agent/definition.ts`; all conversation execution, storage, publication tools,
permission rechecks and loop limits are in the shared `agents/` runtime. The
default model is `gpt-6-luna` at medium reasoning effort. Environment model
overrides remain available for testing and rollback.

Read [the architecture guide](../../../docs/architecture/global-assistant.md)
before changing instruction ownership, memory, tool access or authorization.
