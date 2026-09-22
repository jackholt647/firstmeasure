import type { JsonObject } from "./storage.js";

/* Sample training content seeded once per organization (seed_key marks rows
 * as presets so we never re-seed after an admin edits or archives them). */

const mc = (id: string, prompt: string, choices: Array<[string, boolean]>, explanation = "", image = ""): JsonObject => ({
  id,
  kind: "multiple_choice",
  prompt,
  image,
  explanation,
  choices: choices.map(([text], index) => ({ id: `${id}_c${index + 1}`, text, image: "" })),
  correct_choice_ids: choices.map(([, correct], index) => (correct ? `${id}_c${index + 1}` : "")).filter(Boolean),
  answers: [],
  case_sensitive: false
});

const ti = (id: string, prompt: string, answers: string[], explanation = ""): JsonObject => ({
  id,
  kind: "text_input",
  prompt,
  image: "",
  explanation,
  choices: [],
  correct_choice_ids: [],
  answers,
  case_sensitive: false
});

const flip = (id: string, front: string, back: string): JsonObject => ({
  id, kind: "flip", front_text: front, front_image: "", back_text: back, back_image: "",
  choices: [], correct_choice_ids: [], answers: [], case_sensitive: false
});

const cardMc = (id: string, front: string, choices: Array<[string, boolean]>, image = ""): JsonObject => ({
  id, kind: "multiple_choice", front_text: front, front_image: image, back_text: "", back_image: "",
  choices: choices.map(([text], index) => ({ id: `${id}_c${index + 1}`, text, image: "" })),
  correct_choice_ids: choices.map(([, correct], index) => (correct ? `${id}_c${index + 1}` : "")).filter(Boolean),
  answers: [], case_sensitive: false
});

const cardTi = (id: string, front: string, answers: string[]): JsonObject => ({
  id, kind: "text_input", front_text: front, front_image: "", back_text: answers[0] || "", back_image: "",
  choices: [], correct_choice_ids: [], answers, case_sensitive: false
});

export const SEED_DECKS: JsonObject[] = [
  {
    seed_key: "preset_deck_roofing_tools",
    course_seed_key: "preset_course_roofing_101",
    unlock_lesson_id: "",
    title: "Roofing Tools & Terms",
    description: "The everyday vocabulary of a roofing crew. Flip through these until they are second nature.",
    icon: "fa-toolbox",
    color: "#f59e0b",
    status: "published",
    shuffle: true,
    cards: [
      flip("rt1", "Square", "A roofing area of 100 square feet. A 30-square roof is 3,000 sq ft."),
      flip("rt2", "Drip edge", "Metal flashing at the roof edges that directs water away from the fascia."),
      flip("rt3", "Underlayment", "The water-resistant layer installed between the deck and the shingles."),
      flip("rt4", "Valley", "Where two roof planes meet and channel water downward."),
      flip("rt5", "Starter strip", "The first course of shingles that seals the eave edge against wind."),
      cardMc("rt6", "What tool sets a chalk reference line across the deck?", [["Chalk line", true], ["Speed square", false], ["Utility knife", false], ["Pry bar", false]]),
      cardMc("rt7", "Which fastener is standard for asphalt shingles?", [["1 1/4\" roofing nail", true], ["Drywall screw", false], ["Staple", false], ["Finish nail", false]]),
      cardTi("rt8", "The vertical distance a roof rises per 12\" of run is called its ____.", ["pitch", "slope", "the pitch", "roof pitch"]),
      cardTi("rt9", "Metal installed around chimneys and walls to shed water is called ____.", ["flashing", "step flashing"]),
      flip("rt10", "Ridge cap", "Specially cut shingles that finish and protect the peak of the roof."),
      flip("rt11", "Ice & water shield", "Self-adhering membrane used at eaves and valleys in cold climates."),
      cardMc("rt12", "How many square feet are in 12 squares?", [["1,200", true], ["120", false], ["12,000", false], ["2,400", false]])
    ]
  },
  {
    seed_key: "preset_deck_objections",
    course_seed_key: "preset_course_sales_101",
    unlock_lesson_id: "sales_l3",
    title: "Objection Handling",
    description: "Common homeowner objections and the responses that keep the conversation moving.",
    icon: "fa-comments",
    color: "#8b5cf6",
    status: "published",
    shuffle: true,
    cards: [
      flip("ob1", "\"I need to think about it.\"", "\"Totally fair. What part would you like to think through? Usually it is price, timing, or trust — which one is it for you?\""),
      flip("ob2", "\"Your price is higher than the other guys.\"", "\"You are right, we are rarely the cheapest. Can I show you the three things in our scope the lower bids leave out?\""),
      flip("ob3", "\"I want to wait until spring.\"", "\"I understand. The risk is that small leaks compound over winter. Let us at least lock today's price with a spring install date.\""),
      flip("ob4", "\"I need to talk to my spouse.\"", "\"Of course — this is a decision you should make together. What questions do you think they will have, so I can leave you great answers?\""),
      cardMc("ob5", "A homeowner says the quote is too expensive. What is your FIRST move?", [["Agree and explore what is behind the concern", true], ["Immediately offer a discount", false], ["Compare competitors negatively", false], ["End the appointment", false]]),
      cardMc("ob6", "What is the goal of every objection response?", [["Keep the conversation open and move one step forward", true], ["Win the argument", false], ["Close on the spot no matter what", false], ["Change the subject", false]]),
      cardTi("ob7", "Feel, felt, ____. Complete the classic empathy framework.", ["found"]),
      flip("ob8", "\"We just got three other quotes.\"", "\"Smart move. When you compare them, line up the scope sheets side by side — I am happy to walk through ours line by line.\"")
    ]
  }
];

export const SEED_QUIZZES: JsonObject[] = [
  {
    seed_key: "preset_quiz_safety",
    course_seed_key: "preset_course_roofing_101",
    unlock_lesson_id: "roof_l1",
    title: "Roofing Safety Refresher",
    description: "A quick self-check on fall protection and site safety. Practice any time.",
    icon: "fa-helmet-safety",
    color: "#ef4444",
    status: "published",
    shuffle: true,
    pass_percent: 80,
    questions: [
      mc("sq1", "At what roof height does OSHA require fall protection in residential construction?", [["6 feet", true], ["10 feet", false], ["12 feet", false], ["Only on steep slopes", false]]),
      mc("sq2", "Before climbing, a ladder should extend how far above the roof edge?", [["3 feet", true], ["1 foot", false], ["Level with the edge", false], ["6 feet", false]]),
      mc("sq3", "What should you do with power lines near the work area?", [["Keep at least 10 feet of clearance", true], ["Cover them with a tarp", false], ["Ignore them if insulated", false], ["Tie ladders to them", false]]),
      ti("sq4", "The three parts of a personal fall arrest system: anchor, harness, and ____.", ["lanyard", "lifeline", "a lanyard"]),
      mc("sq5", "When is it acceptable to work a roof alone with no one on site?", [["Never", true], ["On one-story homes", false], ["If you have a phone", false], ["On low slopes", false]]),
      mc("sq6", "The ladder angle rule of thumb is:", [["1 foot out for every 4 feet up", true], ["1 foot out for every 8 feet up", false], ["As steep as possible", false], ["45 degrees always", false]])
    ]
  },
  {
    seed_key: "preset_quiz_sales_final",
    course_seed_key: "preset_course_sales_101",
    unlock_lesson_id: "sales_l5",
    title: "Sales 101 Final Practice",
    description: "Practice version of the Sales 101 final. Unlimited attempts, zero pressure.",
    icon: "fa-bullseye",
    color: "#10b981",
    status: "published",
    shuffle: true,
    pass_percent: 70,
    questions: [
      mc("sf1", "What is the first goal of the initial home visit?", [["Build trust and understand the homeowner's problem", true], ["Present the price", false], ["Measure the roof", false], ["Get a signature", false]]),
      mc("sf2", "The best time to ask for referrals is:", [["Right after a happy install walkthrough", true], ["During the first call", false], ["Never", false], ["Only via email", false]]),
      ti("sf3", "Listening should take up roughly ____ percent of a great discovery conversation.", ["70", "70%", "seventy", "60", "80"]),
      mc("sf4", "A proposal should always be presented:", [["In person or live, never just emailed", true], ["By text message", false], ["Through a lawyer", false], ["After payment", false]]),
      mc("sf5", "When a homeowner goes quiet after hearing the price, you should:", [["Stay silent and let them process", true], ["Immediately discount", false], ["Repeat the price louder", false], ["Pack up", false]]),
      ti("sf6", "Every follow-up should add ____ for the homeowner, not just \"check in\".", ["value", "new value", "some value"])
    ]
  }
];

/* Steps helpers */
const text = (body: string): JsonObject => ({ type: "text", body });
const heading = (body: string): JsonObject => ({ type: "heading", body });
const callout = (body: string, icon = "fa-lightbulb"): JsonObject => ({ type: "callout", body, icon });
const image = (url: string, caption = ""): JsonObject => ({ type: "image", url, caption });
const gallery = (urls: string[], caption = ""): JsonObject => ({ type: "gallery", urls, caption });
const video = (url: string, caption = ""): JsonObject => ({ type: "video", url, caption });
const doc = (url: string, name: string, description = ""): JsonObject => ({ type: "document", url, name, description });

const content = (id: string, title: string, blocks: JsonObject[]): JsonObject => ({ id, kind: "content", title, config: { blocks } });

export const SEED_COURSES: JsonObject[] = [
  {
    seed_key: "preset_course_roofing_101",
    default_role_ids: ["crew_member", "crew_foreman"],
    title: "Roof Installation 101",
    description: "Everything a new crew member needs before their first tear-off: safety, tools, prep, install, and inspection.",
    icon: "fa-house-chimney",
    color: "#f59e0b",
    status: "published",
    sort_order: 0,
    settings: { progression: "sequential" },
    lessons: [
      {
        id: "roof_l1",
        title: "Welcome & Safety Basics",
        summary: "Why safety comes before speed, the gear you must wear, and the rules that are never optional.",
        icon: "fa-helmet-safety",
        minutes: 8,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("roof_l1_s1", "Welcome to the crew", [
            heading("Safety is the job"),
            text("Roofing is one of the most rewarding trades — and one of the most dangerous. Falls are the #1 cause of serious injury on our sites, and every single one is preventable."),
            image("https://picsum.photos/seed/fm-roof-safety/900/540", "Full harness, anchor, and clean staging: the start of every job."),
            callout("Rule zero: if you are not tied off above 6 feet, you are not working. No exceptions, no matter the schedule.", "fa-triangle-exclamation"),
            text("This course walks you through the full lifecycle of a residential asphalt install. Each lesson ends when you tap Continue — a few include a short check so we know the crucial parts stuck.")
          ]),
          content("roof_l1_s2", "Your daily gear", [
            heading("The non-negotiables"),
            text("Every crew member wears: a harness with a rated anchor point, soft-soled roofing boots, gloves for tear-off, and eye protection when cutting or nailing."),
            gallery([
              "https://picsum.photos/seed/fm-gear-1/700/500",
              "https://picsum.photos/seed/fm-gear-2/700/500",
              "https://picsum.photos/seed/fm-gear-3/700/500"
            ], "Harness, boots, and eye protection — inspect all three every morning."),
            doc("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", "Site Safety Checklist.pdf", "Print one per job. The foreman signs it before the first ladder goes up.")
          ]),
          {
            id: "roof_l1_s3",
            kind: "quiz",
            title: "Safety check",
            config: {
              required: true,
              pass_percent: 100,
              allow_practice: true,
              questions: [
                mc("r1q1", "At what height does fall protection become mandatory?", [["6 feet", true], ["12 feet", false], ["Only on steep roofs", false], ["20 feet", false]], "OSHA requires fall protection at 6 feet in residential construction."),
                mc("r1q2", "Your harness strap looks frayed this morning. What do you do?", [["Tag it out and get a replacement before working", true], ["Use it carefully today only", false], ["Tape the strap", false], ["Borrow one at lunch", false]]),
                ti("r1q3", "A ladder should extend ____ feet above the roof edge.", ["3", "three", "3 feet"], "Three feet of extension gives you a handhold at the transition.")
              ]
            }
          }
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "roof_l2",
        title: "Tools & Materials",
        summary: "Learn the vocabulary of the roof: squares, courses, flashing, underlayment, and the tools in your belt.",
        icon: "fa-toolbox",
        minutes: 10,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("roof_l2_s1", "Talk like a roofer", [
            heading("Squares, pitch, and courses"),
            text("Roofs are measured in squares — one square is 100 sq ft. Pitch is rise over run: a 6/12 roof rises 6 inches for every 12 inches of horizontal run. A course is one horizontal row of shingles."),
            image("https://picsum.photos/seed/fm-roof-diagram/900/540", "A 6/12 pitch is the sweet spot: walkable, but always tied off."),
            callout("Estimators talk in squares. If the work order says 28 squares, that is 2,800 sq ft of finished roof — order 10% extra for waste.")
          ]),
          {
            id: "roof_l2_s2",
            kind: "flashcards",
            title: "Tools & terms practice",
            config: {
              deck_seed_key: "preset_deck_roofing_tools",
              mode: "practice",
              required: false,
              pass_percent: 0
            }
          }
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "roof_l3",
        title: "Tear-Off & Deck Prep",
        summary: "Strip it clean, inspect the deck, and replace what is rotten. The roof is only as good as what is under it.",
        icon: "fa-hammer",
        minutes: 9,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("roof_l3_s1", "Strip it to the deck", [
            heading("Tear-off day"),
            text("Work top-down with tear-off forks, keep the magnet sweeper moving in the yard, and tarp the landscaping before the first shingle flies. A clean site is a professional site — and it is how we earn referrals."),
            video("https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", "Watch: a full tear-off from staging to clean deck (3 min)."),
            text("Once stripped, walk every inch of the deck. Soft spots, delamination, or rot mean the sheathing gets replaced — photograph everything and log it in FirstMate before covering it up.")
          ]),
          content("roof_l3_s2", "Deck inspection standards", [
            heading("What passes, what fails"),
            gallery([
              "https://picsum.photos/seed/fm-deck-1/700/500",
              "https://picsum.photos/seed/fm-deck-2/700/500"
            ], "Left: solid deck ready for underlayment. Right: rot that must be cut out and re-sheeted."),
            callout("Never underlay over rot. It voids the warranty and it will come back as a warranty call with your name on it.", "fa-ban")
          ])
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "roof_l4",
        title: "Underlayment & Flashing",
        summary: "The waterproofing layer nobody sees. Ice & water, synthetic felt, drip edge, and step flashing done right.",
        icon: "fa-layer-group",
        minutes: 12,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("roof_l4_s1", "The hidden system", [
            heading("Water always wins — unless"),
            text("Shingles shed water; underlayment and flashing stop it. Ice & water shield goes on eaves and valleys first, then synthetic underlayment overlapping upslope, then drip edge — over the underlayment on rakes, under it at the eaves."),
            image("https://picsum.photos/seed/fm-underlay/900/540", "Valleys get ice & water shield centered and rolled flat, no wrinkles."),
            callout("Order of operations at the eave: ice & water first, drip edge on top. At the rake: underlayment first, drip edge on top. Crews mix this up constantly — you won't.")
          ]),
          {
            id: "roof_l4_s2",
            kind: "quiz",
            title: "Waterproofing check",
            config: {
              required: true,
              pass_percent: 66,
              allow_practice: true,
              questions: [
                mc("r4q1", "Where does ice & water shield always go?", [["Eaves and valleys", true], ["Only the ridge", false], ["Rakes only", false], ["Nowhere in warm climates", false]]),
                mc("r4q2", "At the eave, drip edge is installed:", [["Over the ice & water shield", true], ["Under everything", false], ["After the shingles", false], ["Only on metal roofs", false]]),
                ti("r4q3", "Metal pieces woven into each shingle course along a wall are called ____ flashing.", ["step"], "Step flashing laps each course so water steps down and out.")
              ]
            }
          }
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "roof_l5",
        title: "Shingle Installation",
        summary: "Starter strips, coursing, nailing zones, valleys, and the ridge cap. Where craftsmanship shows.",
        icon: "fa-house-chimney",
        minutes: 15,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("roof_l5_s1", "Laying the field", [
            heading("Straight courses, perfect nails"),
            text("Snap your lines, run the starter strip, and keep every nail in the manufacturer's nailing zone — flush, never overdriven. Four nails per shingle, six in high-wind zones."),
            video("https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", "Watch: coursing and nail placement on a 6/12 field (4 min)."),
            gallery([
              "https://picsum.photos/seed/fm-shingle-1/700/500",
              "https://picsum.photos/seed/fm-shingle-2/700/500",
              "https://picsum.photos/seed/fm-shingle-3/700/500"
            ], "Overdriven, underdriven, and flush. Only one of these passes inspection."),
            callout("An overdriven nail cuts the mat and becomes a leak in five years. Set your gun pressure at the start of every day.")
          ])
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "roof_l6",
        title: "Final Inspection & Cleanup",
        summary: "The 12-point walkthrough, magnetic sweep, photos, and the handoff that earns a five-star review.",
        icon: "fa-clipboard-check",
        minutes: 8,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("roof_l6_s1", "Finish like a pro", [
            heading("The last 30 minutes matter most"),
            text("Walk the roof: ridge straight, flashing tight, no exposed nails, penetrations sealed. Walk the yard: magnet sweep twice, gutters cleared, tarps packed. Then photograph everything and upload it to the project."),
            doc("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", "12-Point Final Inspection.pdf", "The exact checklist the foreman signs before we invoice."),
            callout("The homeowner never sees your nailing pattern. They see the yard. Leave it cleaner than you found it.", "fa-star")
          ]),
          {
            id: "roof_l6_s2",
            kind: "quiz",
            title: "Final check",
            config: {
              required: true,
              pass_percent: 75,
              allow_practice: true,
              questions: [
                mc("r6q1", "How many times do you magnet-sweep the yard?", [["Twice, in perpendicular passes", true], ["Once, quickly", false], ["Only if kids live there", false], ["Never", false]]),
                mc("r6q2", "You spot one exposed nail head on the ridge during walkthrough. You:", [["Seal or replace it before leaving", true], ["Note it for later", false], ["Ignore it — one is fine", false], ["Tell the homeowner to watch it", false]]),
                mc("r6q3", "Final photos get uploaded:", [["Before the crew leaves the site", true], ["Next week", false], ["Only if there was a problem", false], ["Never", false]]),
                ti("r6q4", "Completed roofs are measured and invoiced in ____.", ["squares", "square"], "One last vocabulary check — 100 sq ft each.")
              ]
            }
          }
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      }
    ]
  },
  {
    seed_key: "preset_course_sales_101",
    default_role_ids: ["salesperson", "sales_manager"],
    title: "Sales 101",
    description: "The FirstMate sales method: earn trust, run a perfect first visit, handle objections, and close with confidence.",
    icon: "fa-handshake",
    color: "#10b981",
    status: "published",
    sort_order: 1,
    settings: { progression: "sequential" },
    lessons: [
      {
        id: "sales_l1",
        title: "The Sales Mindset",
        summary: "You are not selling shingles — you are removing a homeowner's biggest worry. Start here.",
        icon: "fa-brain",
        minutes: 6,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("sales_l1_s1", "Solve, don't sell", [
            heading("Nobody wants a roof"),
            text("Homeowners don't wake up wanting to spend five figures on a roof. They want the leak gone, the family safe, and the process painless. Your job is to be the calmest, most trustworthy person who has ever stood in their driveway."),
            image("https://picsum.photos/seed/fm-sales-door/900/540", "The first ten seconds at the door set the tone for the entire project."),
            callout("The golden ratio: listen 70%, talk 30%. Every question you ask is worth ten features you could pitch.")
          ])
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "sales_l2",
        title: "The Perfect First Visit",
        summary: "A repeatable structure for the first appointment: rapport, discovery, inspection, and the next step.",
        icon: "fa-door-open",
        minutes: 12,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("sales_l2_s1", "The four-part visit", [
            heading("Rapport → Discovery → Inspection → Next step"),
            text("1) Rapport: two minutes, genuine, never rushed. 2) Discovery: what happened, how long, what have they tried, who decides. 3) Inspection: narrate what you see with photos. 4) Next step: never leave without a scheduled follow-up on the calendar."),
            gallery([
              "https://picsum.photos/seed/fm-visit-1/700/500",
              "https://picsum.photos/seed/fm-visit-2/700/500"
            ], "Show homeowners what you see. Photos build trust faster than words."),
            callout("If you leave without a concrete next step booked, the visit was a conversation, not an appointment.")
          ]),
          {
            id: "sales_l2_s2",
            kind: "quiz",
            title: "First visit check",
            config: {
              required: true,
              pass_percent: 66,
              allow_practice: true,
              questions: [
                mc("s2q1", "What must happen before you leave every first visit?", [["A scheduled next step", true], ["A signed contract", false], ["A discount offer", false], ["A handshake photo", false]]),
                mc("s2q2", "During discovery you should mostly be:", [["Asking and listening", true], ["Presenting the company deck", false], ["Talking price", false], ["Measuring", false]]),
                ti("s2q3", "Rapport, discovery, inspection, and the next ____.", ["step"])
              ]
            }
          }
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "sales_l3",
        title: "Objection Handling",
        summary: "Price, timing, spouse, competitors. Master the graceful response to every push-back.",
        icon: "fa-comments",
        minutes: 10,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("sales_l3_s1", "Objections are interest", [
            heading("A question in disguise"),
            text("An objection means the homeowner is engaged enough to push back. The framework: acknowledge it honestly, narrow it to the real concern, answer just that, then move one step forward."),
            callout("Feel, felt, found: \"I understand how you feel. Other homeowners felt the same. What they found was...\"")
          ]),
          {
            id: "sales_l3_s2",
            kind: "flashcards",
            title: "Objection drills",
            config: {
              deck_seed_key: "preset_deck_objections",
              mode: "test",
              required: true,
              pass_percent: 60
            }
          }
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "sales_l4",
        title: "Building the Proposal",
        summary: "Scope clarity wins jobs. Build proposals that sell themselves when compared side by side.",
        icon: "fa-file-signature",
        minutes: 9,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("sales_l4_s1", "Sell the scope, not the price", [
            heading("Your proposal is your best salesperson"),
            text("Line-item the scope: tear-off, deck repair allowance, ice & water, underlayment, shingle system, ventilation, flashing, cleanup, warranty. When a cheaper bid arrives, your detail makes their omissions obvious."),
            image("https://picsum.photos/seed/fm-proposal/900/540", "Good-better-best options let the homeowner choose instead of negotiate."),
            doc("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", "Proposal Walkthrough Script.pdf", "The exact talk track for presenting all three options in under ten minutes.")
          ])
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      },
      {
        id: "sales_l5",
        title: "Closing & Follow-Up",
        summary: "Ask with confidence, go silent, and follow up with value until they decide.",
        icon: "fa-flag-checkered",
        minutes: 11,
        unlock: { mode: "previous", available_on: "" },
        steps: [
          content("sales_l5_s1", "The confident close", [
            heading("Ask, then hold the silence"),
            text("After presenting options: \"Most homeowners in your situation choose the Better package. Should we get you on the schedule for the week of the 14th?\" Then stop talking. Silence is the homeowner processing — respect it."),
            callout("Every follow-up must add value: a new photo, a permit update, a financing option. \"Just checking in\" teaches them to ignore you."),
            video("https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", "Watch: a full close and follow-up sequence roleplay (5 min).")
          ]),
          {
            id: "sales_l5_s2",
            kind: "quiz",
            title: "Sales 101 final",
            config: {
              required: true,
              pass_percent: 70,
              allow_practice: true,
              questions: [
                mc("s5q1", "After you ask the closing question, you should:", [["Stay silent and wait", true], ["Fill the silence with features", false], ["Offer a discount", false], ["Ask a different question", false]]),
                mc("s5q2", "A great follow-up always includes:", [["Something new and valuable", true], ["The phrase 'just checking in'", false], ["Pressure about the deadline", false], ["A lower price", false]]),
                mc("s5q3", "The purpose of good-better-best pricing is:", [["Let the homeowner choose instead of negotiate", true], ["Confuse the buyer", false], ["Hide the real price", false], ["Look bigger than competitors", false]]),
                ti("s5q4", "Listen ____%, talk 30%.", ["70", "70%", "seventy"]),
                ti("s5q5", "An objection is a ____ in disguise.", ["question", "a question"])
              ]
            }
          }
        ],
        reward_deck_ids: [],
        reward_quiz_ids: []
      }
    ]
  }
];
