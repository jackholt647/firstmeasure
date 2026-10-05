import { formDefinitionSchema, type FormDefinition } from "./contracts.js";

/**
 * Starting points for new forms. A template is only seed content: once created,
 * a form is edited block by block and has no tie to its template. Industry
 * packs add entries here; nothing else in the forms module is industry-aware.
 */

export type FormTemplate = {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: "General" | "Scheduling" | "Estimates";
  industry?: string;
  /** lead_forms capability flags the template's blocks need. */
  requires: string[];
  build: () => unknown;
};

const contact = (overrides: Record<string, unknown> = {}) => ({ id: "contact", kind: "contact", param: "contact", ...overrides });
const consent = (label: string) => ({ id: "consent", kind: "consent", param: "consent", label, required: true });
const choice = (value: string, label: string, description = "") => ({ value, label, description });

const TEMPLATES: FormTemplate[] = [
  {
    id: "blank",
    name: "Blank form",
    description: "Start with contact details and build the rest yourself.",
    icon: "fa-file",
    category: "General",
    requires: ["contact_form"],
    build: () => ({
      template: "blank",
      presentation: { headline: "Get in touch", submit_label: "Send" },
      steps: [{ id: "details", title: "Your details", items: [contact()] }]
    })
  },
  {
    id: "contact",
    name: "Contact form",
    description: "Name, phone, email and a message. Creates a new lead.",
    icon: "fa-address-card",
    category: "General",
    requires: ["contact_form"],
    build: () => ({
      template: "contact",
      presentation: {
        headline: "Tell us how we can help",
        subheadline: "Send us a note and we will follow up with the right next step.",
        submit_label: "Send request",
        fine_print: "By submitting, you agree to be contacted about your request.",
        layout: "page",
        progress: "none",
        success: { title: "Request received", body: "Thanks for reaching out. We will follow up shortly." }
      },
      steps: [{
        id: "details",
        items: [
          contact({ fields: { name: { enabled: true, required: true }, email: { enabled: true, required: true }, phone: { enabled: true, required: false } } }),
          { id: "address", kind: "address", param: "address", label: "Address", placeholder: "Street, city, state" },
          { id: "message", kind: "paragraph", param: "message", label: "How can we help?", placeholder: "A few details about what you need" }
        ]
      }]
    })
  },
  {
    id: "service_request",
    name: "Service request",
    description: "Qualifying questions about the job and timing before contact details.",
    icon: "fa-clipboard-list",
    category: "General",
    requires: ["contact_form"],
    build: () => ({
      template: "service_request",
      presentation: {
        headline: "Request service",
        subheadline: "Answer a few quick questions so we can send the right person.",
        submit_label: "Request service",
        fine_print: "By submitting, you agree to be contacted about your request.",
        success: { title: "Request received", body: "We have your details and will reach out to schedule." }
      },
      steps: [
        { id: "need", title: "What do you need?", items: [
          { id: "service", kind: "select", param: "service", label: "What can we help with?", required: true, options: [choice("repair", "Repair", "Something is broken or damaged"), choice("install", "New installation", "A new or replacement project"), choice("maintenance", "Maintenance", "Routine service or a check-up"), choice("other", "Something else")] },
          { id: "timing", kind: "select", param: "timing", label: "How soon do you need it?", required: true, style: "list", options: [choice("urgent", "As soon as possible"), choice("weeks", "In the next few weeks"), choice("planning", "Just planning ahead")] }
        ] },
        { id: "details", title: "Where and who?", items: [
          { id: "address", kind: "address", param: "address", label: "Service address", required: true, placeholder: "Street, city, state" },
          { id: "notes", kind: "paragraph", param: "notes", label: "Anything else we should know?" },
          contact()
        ] }
      ]
    })
  },
  {
    id: "appointment",
    name: "Appointment booking",
    description: "Customers pick an open time from your live schedule. Books a real appointment using one of your appointment types.",
    icon: "fa-calendar-check",
    category: "Scheduling",
    requires: ["appointment_form"],
    build: () => ({
      template: "appointment",
      presentation: {
        headline: "Book an appointment",
        subheadline: "Choose a time that works for you and we will take it from there.",
        submit_label: "Book appointment",
        fine_print: "By booking, you agree to be contacted about your appointment.",
        success: { title: "You are booked", body: "We have reserved your time and will send a confirmation shortly." }
      },
      steps: [
        { id: "details", title: "Your details", items: [
          contact(),
          { id: "address", kind: "address", param: "address", label: "Address", required: true, placeholder: "Street, city, state" }
        ] },
        { id: "time", title: "Pick a time", items: [
          { id: "appointment", kind: "appointment", param: "appointment", label: "Choose a day and time", required: true }
        ] }
      ]
    })
  },
  {
    id: "estimate",
    name: "Instant estimate",
    description: "Ask for a size or quantity, then show a price range from your own price table. Works for any trade priced per unit.",
    icon: "fa-calculator",
    category: "Estimates",
    requires: ["instant_estimate"],
    build: () => ({
      template: "estimate",
      presentation: {
        headline: "Get an instant estimate",
        subheadline: "Answer a few questions and see your price range right away.",
        submit_label: "See my estimate",
        fine_print: "Estimates are preliminary and confirmed after we review the details with you.",
        success: { title: "Your estimate", body: "We will follow up to confirm the details and answer any questions." }
      },
      steps: [
        { id: "project", title: "About your project", items: [
          { id: "size", kind: "number", param: "size", label: "Approximate size", description: "A rough number is fine. We confirm measurements before final pricing.", required: true, min: 1, unit: "sq ft" },
          { id: "timing", kind: "select", param: "timing", label: "When would you like to start?", style: "list", options: [choice("asap", "As soon as possible"), choice("months", "In the next few months"), choice("exploring", "Just exploring")] }
        ] },
        { id: "contact", title: "Where should we send it?", items: [
          contact({ fields: { name: { enabled: true, required: true }, email: { enabled: true, required: true }, phone: { enabled: true, required: false } } }),
          { id: "address", kind: "address", param: "address", label: "Project address", placeholder: "Street, city, state" },
          consent("I agree to be contacted about my estimate.")
        ] }
      ],
      calculation: {
        mode: "pricing",
        pricing: {
          quantity: { param: "size", label: "Size", unit: "sq ft" },
          options: [
            { id: "standard", label: "Standard", description: "Our most popular option.", low_rate: 4, high_rate: 6 },
            { id: "premium", label: "Premium", description: "Upgraded materials and finish.", low_rate: 6, high_rate: 9 }
          ]
        }
      },
      settings: { customer_email: { enabled: true, subject: "Your estimate" } }
    })
  },
  {
    id: "roofing_instant_estimate",
    name: "Roof replacement estimate",
    description: "Measures the roof from satellite imagery at the customer's address and prices each roofing material by measured area and steepness.",
    icon: "fa-house-chimney",
    category: "Estimates",
    industry: "roofing",
    requires: ["instant_estimate"],
    build: () => ({
      template: "roofing_instant_estimate",
      presentation: {
        headline: "Get a free instant roof estimate",
        subheadline: "We measure your roof from satellite imagery and show replacement options in minutes.",
        start_label: "Get started",
        submit_label: "Get my estimate",
        fine_print: "This is a preliminary estimate. Final pricing may change after inspection, measurements, materials and scope review.",
        success: { title: "Your roof estimate", body: "We will follow up to confirm the measurements and walk through your options." }
      },
      steps: [
        { id: "property", title: "Where is the property?", items: [
          { id: "address", kind: "address", param: "address", label: "Property address", required: true, placeholder: "123 Main Street, City, State" }
        ] },
        { id: "roof", title: "We found your roof", description: "Confirm the highlighted roof matches your property.", items: [
          { id: "measurement", kind: "property_measurement", param: "measurement", source: "solar_roof", address_param: "address", label: "Roof measurements" }
        ] },
        { id: "condition", title: "Tell us about the roof", items: [
          { id: "roof_age", kind: "select", param: "roof_age", label: "How old is the current roof?", required: true, style: "list", options: [choice("0-9", "Less than 10 years"), choice("10-19", "10 to 20 years"), choice("20+", "More than 20 years"), choice("unknown", "Not sure")] },
          { id: "damage", kind: "select", param: "damage", label: "Is there any damage or leaking?", required: true, style: "list", options: [choice("none", "No visible damage"), choice("minor", "Some wear or missing shingles"), choice("leak", "Active leak or storm damage")] }
        ] },
        { id: "timeline", title: "When are you looking to start?", items: [
          { id: "timeline", kind: "select", param: "timeline", label: "Project timeline", required: true, style: "list", options: [choice("asap", "As soon as possible"), choice("1-3", "In 1 to 3 months"), choice("3+", "More than 3 months out"), choice("exploring", "Just exploring")] },
          { id: "notes", kind: "paragraph", param: "notes", label: "Anything else we should know?" }
        ] },
        { id: "contact", title: "Where should we send your estimate?", items: [
          contact({ fields: { name: { enabled: true, required: true }, email: { enabled: true, required: true }, phone: { enabled: true, required: false } } }),
          consent("I agree to be contacted about my roofing estimate.")
        ] }
      ],
      calculation: {
        mode: "pricing",
        pricing: {
          quantity: { param: "measurement.roof_area_sqft", label: "Roof area", unit: "sq ft", fallback: 2200 },
          options: [
            { id: "asphalt", label: "Asphalt shingle roof", description: "Architectural shingles, the most common choice.", low_rate: 6.75, high_rate: 9.25, visible_when: [{ param: "measurement.pitch_category", op: "neq", value: "Flat" }] },
            { id: "metal", label: "Metal roof", description: "Standing seam or metal panel systems.", low_rate: 10.5, high_rate: 14.5, visible_when: [{ param: "measurement.pitch_category", op: "neq", value: "Flat" }] },
            { id: "tile", label: "Tile roof", description: "Concrete or clay tile.", low_rate: 13.5, high_rate: 18, visible_when: [{ param: "measurement.pitch_category", op: "neq", value: "Flat" }] },
            { id: "flat", label: "Flat roof membrane", description: "TPO or modified bitumen for low-slope roofs.", low_rate: 9.5, high_rate: 14.5, visible_when: [{ param: "measurement.pitch_category", op: "in", value: ["Flat", "Low"] }] }
          ],
          adjustments: [
            { id: "moderate_pitch", label: "Moderate roof pitch", percent: 12, when: [{ param: "measurement.pitch_category", op: "eq", value: "Moderate" }] },
            { id: "steep_pitch", label: "Steep roof pitch", percent: 30, when: [{ param: "measurement.pitch_category", op: "eq", value: "Steep" }] }
          ],
          disclaimer: "This is a preliminary estimate based on satellite measurements. Final pricing may change after inspection, measurements, materials and scope review."
        }
      },
      settings: { customer_email: { enabled: true, subject: "Your instant roof estimate" } }
    })
  }
];

export function listFormTemplates() {
  return TEMPLATES.map(({ build: _build, ...template }) => template);
}

export function formTemplate(templateId: string) {
  return TEMPLATES.find((template) => template.id === templateId) || null;
}

export function buildTemplateDefinition(templateId: string): FormDefinition {
  const template = formTemplate(templateId) || formTemplate("blank")!;
  return formDefinitionSchema.parse(template.build());
}
