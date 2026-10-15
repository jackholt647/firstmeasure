// Contract for the agent how-to index: short, source-controlled recipes that
// tell an agent how to combine registered capabilities to do a business task.
// See docs/architecture/agent-how-to-index.md.
//
// Entries are data, not prompt text. Only ids and titles reach the system
// prompt; an agent fetches a body with platform_how_to_read. Every id a step
// names in `refs` must be registered (tests/agent-how-to-index.test.ts), so an
// entry cannot quietly outlive the thing it describes.

export type HowToRefs = {
  /** Work automation ids, as in work/automations/catalog.ts. */
  automations?: string[];
  /** Work event names, as in work/events.ts. */
  events?: string[];
  /** Published data exports, written "<provider>.<export>". */
  data?: string[];
  /** Published action ids. */
  actions?: string[];
  /** Custom field types, as in custom_fields/contracts.ts. */
  field_types?: string[];
  /** Agent tools: a shared platform tool name, or "<agent id>.<tool name>" for an agent's own tool. */
  tools?: string[];
};

export type HowToStep = {
  /** A few words naming the step. */
  title: string;
  /** What to do, written for an agent. Name ids exactly. */
  detail: string;
  refs?: HowToRefs;
  /**
   * Set when the step is not built yet: one sentence saying what is missing.
   * A planned step's refs are not checked, and agents are told it is
   * unavailable.
   */
  planned?: string;
};

export type HowToEntry = {
  /** Stable snake_case id. Never reuse or rename one that has shipped. */
  id: string;
  title: string;
  /** One line: the request or situation this entry answers. */
  use_when: string;
  steps: HowToStep[];
  /** Short cautions that apply to the whole entry. */
  notes?: string[];
  /** Extra search words that are not in the title or use_when line. */
  keywords?: string[];
};
