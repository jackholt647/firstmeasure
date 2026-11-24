import type { JsonObject } from "../platform/storage.js";
import type { FlowDefinition } from "./contracts.js";

/**
 * The new-lead flow the leads setup makes from its answers (docs/architecture/flows.md, "The leads setup"). It is an
 * ordinary flow: the organization edits it like any other afterwards. The builder only decides the starting shape:
 *
 *  call   Did they answer? → yes: the greeting and the questions, then what's next (appointment, call back, not
 *         interested) · no: did you leave a voicemail, then the no-answer actions (a text, an email, a call back) ·
 *         wrong number: not a lead.
 *  text   the first text (its copy shown), then whether they replied.
 *  email  the first email (its copy shown), then whether they replied.
 *
 * Outcomes route the lead: ready for an appointment starts the sales board, not interested and not a lead mark it lost,
 * no answer and call back leave a follow-up.
 */
export const CONTACT_METHODS = ["call", "text", "email"] as const;
export const NO_ANSWER_ACTIONS = ["text", "email", "retry"] as const;
export type NewLeadAnswers = {
  contact: (typeof CONTACT_METHODS)[number];
  no_answer: Array<(typeof NO_ANSWER_ACTIONS)[number]>;
  questions: Array<{ key: string; label: string; input?: string; options?: Array<{ id: string; label: string }>; saves_to?: string }>;
  board_id?: string;
};

/** Questions offered by the setup, in order. A company adds its own; each is an `ask` block. */
export const SUGGESTED_QUESTIONS: NewLeadAnswers["questions"] = [
  { key: "need", label: "What do you need done?", input: "select", options: [
    { id: "replacement", label: "A replacement" }, { id: "repair", label: "A repair" }, { id: "inspection", label: "An inspection" }, { id: "estimate", label: "Just an estimate" }, { id: "other", label: "Something else" }] },
  { key: "address", label: "What's the address of the job?", input: "address", saves_to: "project.address" },
  { key: "timeline", label: "When are you hoping to get it done?", input: "select", options: [
    { id: "asap", label: "As soon as possible" }, { id: "month", label: "In the next month" }, { id: "later", label: "In a few months" }, { id: "unsure", label: "Not sure yet" }] },
  { key: "insurance", label: "Is this an insurance claim?", input: "yes_no" },
  { key: "found_us", label: "How did you hear about us?", input: "select", options: [
    { id: "search", label: "Online search" }, { id: "referral", label: "A friend or neighbor" }, { id: "social", label: "Social media" }, { id: "sign", label: "A yard sign or truck" }, { id: "other", label: "Other" }] },
  { key: "notes", label: "Anything else we should know?", input: "paragraph" }
];

export const DEFAULT_TEXT = "Hi {{contact.first_name}}, this is {{user.first_name}} with {{organization.name}}. Thanks for reaching out! We tried calling. When's a good time to talk? Reply STOP to opt out.";
export const DEFAULT_FIRST_TEXT = "Hi {{contact.first_name}}, this is {{user.first_name}} with {{organization.name}}. Thanks for reaching out! What can we help you with? Reply STOP to opt out.";
export const DEFAULT_EMAIL_SUBJECT = "Thanks for reaching out to {{organization.name}}";
export const DEFAULT_EMAIL = "Hi {{contact.first_name}},\n\nThanks for reaching out to {{organization.name}}. We tried to call you and would love to hear about your project. Reply to this email or call us back whenever suits you.\n\n{{user.first_name}}";

const sms = (id: string, label: string, copy: string) => ({ id, kind: "action" as const, label, automation: "communications.sendSms.v1",
  input: { to: "{{project.contacts.0.phone}}", text: copy }, preview: copy, explainer: "Sent from your company number when you continue.", when: { match: "all", rules: [{ field: "project.contacts.0.phone", operator: "is_present" }] } });
const email = (id: string, label: string, subject: string, copy: string) => ({ id, kind: "action" as const, label, automation: "communications.sendEmail.v1",
  input: { to: "{{project.contacts.0.email}}", subject, text: copy }, preview: copy, explainer: "Sent from your company email when you continue.", when: { match: "all", rules: [{ field: "project.contacts.0.email", operator: "is_present" }] } });
const followUp = (id: string, title: string, hours: number) => ({ id, kind: "action" as const, label: title, automation: "work.createTodo.v1",
  input: { title, message: "From the new lead call.", due_offset_minutes: hours * 60, assigned_user_ids: ["{{run.started_by}}"] }, preview: `A to-do to ${title.toLowerCase()} in ${hours} hours.`, explainer: "" });

export function newLeadFlow(answers: NewLeadAnswers): FlowDefinition {
  const board = answers.board_id || "";
  const outcomes = [
    { id: "ready", label: "Ready for an appointment", color: "#16a34a", effects: board ? [{ automation: "scopes.activateTemplate.v1", input: { template_id: board, instance_key: "new_lead_flow" }, explainer: "Starts the sales board." }] : [] },
    { id: "call_back", label: "Call back later", color: "#f59e0b", effects: [] },
    { id: "no_answer", label: "No answer", color: "#667085", effects: [] },
    { id: "not_interested", label: "Not interested", color: "#dc2626", effects: [{ automation: "sales.markLost.v1", input: { reason: "not_interested" }, explainer: "Marks the lead lost." }] },
    { id: "not_a_lead", label: "Not a lead", color: "#7a271a", effects: [{ automation: "sales.markLost.v1", input: { reason: "not_a_lead" }, explainer: "Marks the lead lost: a wrong number or spam." }] }
  ];
  // One question per step (Jack, 2026-11-23): short steps read better on a call and use the height of the screen.
  const asked = questionSteps(answers.questions, "next");
  const firstQuestion = asked[0]?.id || "next";
  const nextStep = { id: "next", title: "What's next?", blocks: [
    { id: "say_next", kind: "say" as const, label: "", text: "Thanks, that's everything I need. The next step is to set up a time to come out and take a look. What works for you?" },
    { id: "result", kind: "choice" as const, key: "result", label: "How did it go?", required: true, options: [
      { id: "ready", label: "They want an appointment", outcome: "ready" }, { id: "call_back", label: "Call them back later", to: "call_back" }, { id: "not_interested", label: "Not interested", outcome: "not_interested" }] }
  ], next: null };
  const callBack = { id: "call_back", title: "Call back later", blocks: [followUp("call_back_todo", "Call the lead back", 24), { id: "end_call_back", kind: "outcome" as const, label: "", outcome: "call_back" }], next: null };

  if (answers.contact === "call") {
    const noAnswer = [
      ...(answers.no_answer.includes("text") ? [sms("no_answer_text", "Text them", DEFAULT_TEXT)] : []),
      ...(answers.no_answer.includes("email") ? [email("no_answer_email", "Email them", DEFAULT_EMAIL_SUBJECT, DEFAULT_EMAIL)] : []),
      ...(answers.no_answer.includes("retry") ? [followUp("no_answer_retry", "Try the lead again", 4)] : [])
    ];
    return {
      name: "New lead call", description: "The first call to a new lead: did they answer, what you ask, and where the lead goes next.", icon: "fa-phone-volume", color: "#2563eb",
      kind: "call", audience: "staff", start: "dial", outcomes,
      steps: [
        { id: "dial", title: "Call the lead", blocks: [
          { id: "dial_note", kind: "note", label: "", text: "Call {{contact.name}} at {{contact.phone}}." },
          { id: "answered", kind: "choice", key: "answered", label: "Did they answer?", required: true, options: [
            { id: "yes", label: "They answered", to: "greet" }, { id: "no", label: "No answer", to: "no_answer" }, { id: "wrong", label: "Wrong number", outcome: "not_a_lead" }] }
        ], next: null },
        { id: "greet", title: "They answered", blocks: [
          { id: "say_hello", kind: "say", label: "", text: "Hi, is this {{contact.first_name}}? This is {{user.first_name}} with {{organization.name}}. Thanks for reaching out! Do you have a couple of minutes to tell me about your project?" }
        ], next: firstQuestion },
        ...asked,
        nextStep,
        callBack,
        { id: "no_answer", title: "No answer", blocks: [
          { id: "voicemail", kind: "choice", key: "voicemail", label: "Did you leave a voicemail?", required: true, options: [{ id: "yes", label: "Left a voicemail" }, { id: "no", label: "No voicemail" }] },
          ...noAnswer,
          { id: "end_no_answer", kind: "outcome", label: "", outcome: "no_answer" }
        ], next: null }
      ],
      entry: { new_menu: { enabled: false, label: "Lead", icon: "fa-user-plus", role_ids: [], sort_order: 0 } },
      metadata: { created_from: "leads.setup", contact: answers.contact, no_answer: answers.no_answer }
    } as FlowDefinition;
  }
  const first = answers.contact === "text" ? sms("first_text", "Text the lead", DEFAULT_FIRST_TEXT) : email("first_email", "Email the lead", DEFAULT_EMAIL_SUBJECT, DEFAULT_EMAIL.replace("We tried to call you and would love", "We'd love"));
  return {
    name: answers.contact === "text" ? "New lead text" : "New lead email", description: "The first message to a new lead, what you ask when they reply, and where the lead goes next.",
    icon: answers.contact === "text" ? "fa-comment-sms" : "fa-envelope", color: "#2563eb", kind: "workflow", audience: "staff", start: "send", outcomes,
    steps: [
      { id: "send", title: answers.contact === "text" ? "Text the lead" : "Email the lead", blocks: [first], next: "replied" },
      { id: "replied", title: "Did they reply?", blocks: [
        { id: "reply", kind: "choice", key: "replied", label: "Did they get back to you?", required: true, options: [
          { id: "yes", label: "They replied", to: firstQuestion }, { id: "not_yet", label: "Not yet", to: "call_back" }, { id: "wrong", label: "Wrong person", outcome: "not_a_lead" }] }
      ], next: null },
      ...asked,
      nextStep,
      callBack
    ],
    entry: { new_menu: { enabled: false, label: "Lead", icon: "fa-user-plus", role_ids: [], sort_order: 0 } },
    metadata: { created_from: "leads.setup", contact: answers.contact }
  } as FlowDefinition;
}

/**
 * New › Lead: the flow a person plays to enter a lead by hand. Find or create the contact from what the caller says,
 * make the lead through intake, then the questions, then open it.
 */
export function manualLeadFlow(questions: NewLeadAnswers["questions"]): FlowDefinition {
  const manualAsked = questionSteps(questions.filter((question) => !["address", "name"].includes(question.key)), "done");
  return {
    name: "New lead", description: "Enter a lead by hand: who they are, what they need, then open it.", icon: "fa-user-plus", color: "#2563eb", kind: "workflow", audience: "staff", start: "who", outcomes: [],
    steps: [
      { id: "who", title: "Who is it?", blocks: [
        { id: "name", kind: "ask", key: "name", label: "Name", input: "text", options: [], required: true, placeholder: "" },
        { id: "phone", kind: "ask", key: "phone", label: "Phone", input: "phone", options: [], required: false, placeholder: "" },
        { id: "email", kind: "ask", key: "email", label: "Email", input: "email", options: [], required: false, placeholder: "" },
        { id: "address", kind: "ask", key: "address", label: "Address of the job", input: "address", options: [], required: false, placeholder: "" },
        { id: "contact", kind: "contact", label: "", mode: "find_or_create", from: { name: "answers.name", phone: "answers.phone", email: "answers.email" } },
        { id: "lead", kind: "project", label: "", mode: "create_lead", from: { address: "answers.address" } }
      ], next: manualAsked[0]?.id || "done" },
      ...manualAsked,
      { id: "done", title: "Lead saved", blocks: [
        { id: "saved", kind: "note", label: "", text: "{{contact.name}} is in your new leads." },
        { id: "end", kind: "buttons", label: "", buttons: [{ kind: "open_project", label: "Open the lead", target: "" }, { kind: "restart", label: "Enter another", target: "" }, { kind: "close", label: "Close", target: "" }] }
      ], next: null }
    ],
    entry: { new_menu: { enabled: true, label: "Lead", icon: "fa-user-plus", role_ids: [], sort_order: 0 } },
    metadata: { created_from: "leads.setup" }
  } as FlowDefinition;
}

/** Short step titles for the suggested questions; a company's own question is titled by its words. */
const STEP_TITLES: Record<string, string> = { need: "The job", address: "The address", timeline: "Timing", insurance: "Insurance", found_us: "How they found us", notes: "Anything else", name: "Who it is" };

/** Each question its own step, in order, the last going on to `then`. */
export function questionSteps(questions: NewLeadAnswers["questions"], then: string) {
  return questions.map((question, index) => ({
    id: `ask_${question.key}`,
    title: STEP_TITLES[question.key] || question.label.replace(/\?$/, "").slice(0, 60),
    blocks: [{ id: `q_${index + 1}`, kind: "ask" as const, key: question.key, label: question.label, input: (question.input || "text") as never, options: question.options || [], required: false, placeholder: "",
      ...(question.saves_to ? { saves_to: question.saves_to } : {}) }],
    next: index < questions.length - 1 ? `ask_${questions[index + 1]!.key}` : then
  }));
}

export const asJson = (flow: FlowDefinition) => flow as unknown as JsonObject;
