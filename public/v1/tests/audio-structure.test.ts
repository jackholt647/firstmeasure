import assert from "node:assert/strict";
import test from "node:test";

import {
  checklistAudioProcessor,
  checklistTitleSimilarity,
  reconcileChecklistAudioOperations
} from "../audio-structure/checklist.js";
import { processStructuredAudio, registerAudioStructureProcessor } from "../audio-structure/processor.js";

test("structured audio sends raw audio and validates forced function arguments", async () => {
  let captured: any = null;
  const processor = registerAudioStructureProcessor<{ subject: string }, { value: string }>({
    id: `test.processor.${Date.now()}`,
    instructions: "Return the spoken value.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"]
    },
    prompt: (context) => `Listen for ${context.subject}.`,
    validate(value) {
      const result = value as { value?: unknown };
      assert.equal(typeof result.value, "string");
      return { value: String(result.value) };
    }
  });
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: "submit_structured_audio_result",
              arguments: JSON.stringify({ value: "drywall complete" })
            }
          }]
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const result = await processStructuredAudio(processor, {
    audio: Buffer.from("raw-audio-bytes"),
    contentType: "audio/wav",
    fileName: "note.wav",
    context: { subject: "work status" }
  }, {
    apiKey: "test-key",
    model: "gpt-audio-mini",
    fetchImpl: fetchImpl as typeof fetch
  });

  assert.equal(result.value, "drywall complete");
  assert.equal(captured.messages[0].content[1].type, "input_audio");
  assert.equal(captured.messages[0].content[1].input_audio.data, Buffer.from("raw-audio-bytes").toString("base64"));
  assert.equal(captured.tool_choice.function.name, "submit_structured_audio_result");
});

test("checklist audio reconciles completed paraphrases instead of creating duplicates", () => {
  const items = [
    { id: "hazards", title: "Work area walked and hazards identified", completed: false, item_type: "todo" },
    { id: "ladders", title: "Ladders set, tied off, and inspected", completed: false, item_type: "todo" }
  ];
  assert.ok(checklistTitleSimilarity("Set the ladders", items[1]!.title) >= 0.74);
  assert.ok(checklistTitleSimilarity("Walked the area for hazards", items[0]!.title) >= 0.74);

  const result = reconcileChecklistAudioOperations([
    {
      action: "complete",
      item_id: "hazards",
      title: "Walked the area for hazards",
      confidence: 0.96,
      reason: "The speaker said this work was already completed."
    },
    {
      action: "add",
      item_id: "",
      title: "Set the ladders",
      confidence: 0.91,
      reason: "The speaker said they already set the ladders."
    },
    {
      action: "add",
      item_id: "",
      title: "Install the sink later",
      confidence: 0.9,
      reason: "The speaker discovered new pending work."
    }
  ], items);

  assert.deepEqual(result.operations.map((operation) => [operation.action, operation.item_id]), [
    ["complete", "hazards"],
    ["complete", "ladders"],
    ["add", ""]
  ]);
  assert.equal(result.operations[1]!.title, items[1]!.title);
  assert.equal(result.suppressed.length, 0);
});

test("checklist audio suppresses pending paraphrases already represented by the list", () => {
  const result = reconcileChecklistAudioOperations([{
    action: "add",
    item_id: "",
    title: "Set the ladders",
    confidence: 0.95,
    reason: "The speaker says the ladders still need to be set."
  }], [{
    id: "ladders",
    title: "Ladders set, tied off, and inspected",
    completed: false,
    item_type: "todo"
  }]);
  assert.deepEqual(result.operations, []);
  assert.equal(result.suppressed[0]!.matched_item_id, "ladders");
  assert.equal(result.suppressed[0]!.suppression_reason, "duplicate_existing_item");
  assert.match(checklistAudioProcessor.instructions, /already walked the area/i);
  assert.match(checklistAudioProcessor.instructions, /same kind of checklist/i);
  assert.match(checklistAudioProcessor.instructions, /mix both item types/i);
  assert.match(checklistAudioProcessor.instructions, /private from the customer/i);
  assert.match(checklistAudioProcessor.instructions, /assigned to its creator/i);
  assert.match(checklistAudioProcessor.prompt({
    mode: "update",
    checklist: { id: "safety", title: "Safety", items: [] }
  }), /two complete operations and zero add operations/i);
  assert.match(checklistAudioProcessor.prompt({
    mode: "update",
    checklist: { id: "new", title: "Untitled checklist", items: [] }
  }), /generate a useful short title/i);
  const defaults = checklistAudioProcessor.validate({ title:"Daily work", summary:"Created", operations:[] });
  assert.equal(defaults.customer_access, "private");
  assert.equal(defaults.customer_access_explicit, false);
  assert.equal(defaults.completion_audience, "assigned");
  assert.equal(defaults.completion_audience_explicit, false);
  const mixed = checklistAudioProcessor.validate({
    title:"Final walkthrough",
    summary:"Created a mixed checklist",
    customer_access:"private",
    customer_access_explicit:false,
    completion_audience:"everyone",
    completion_audience_explicit:false,
    operations:[
      { action:"add", item_id:"", title:"Remove debris", item_type:"todo", confidence:.9, reason:"Task" },
      { action:"add", item_id:"", title:"Rate paint finish", item_type:"rating", confidence:.9, reason:"Quality rating" }
    ]
  });
  assert.deepEqual(mixed.operations.map((operation) => operation.item_type), ["todo", "rating"]);
});

test("checklist audio targets notes and evidence requirements at existing items", () => {
  const result = reconcileChecklistAudioOperations([
    {
      action:"add_note",
      item_id:"",
      title:"Paint finish inspection",
      note:"Pay special attention to the south wall.",
      confidence:.94,
      reason:"The speaker explicitly added a note."
    },
    {
      action:"set_requirements",
      item_id:"paint",
      title:"Paint finish inspection",
      requirements:["photo", "audio"],
      confidence:.97,
      reason:"The speaker explicitly required photo and audio evidence."
    }
  ], [{ id:"paint", title:"Paint finish inspection", completed:false, item_type:"rating" }]);
  assert.deepEqual(result.operations.map((operation) => [operation.action, operation.item_id]), [
    ["add_note", "paint"],
    ["set_requirements", "paint"]
  ]);
  const validated = checklistAudioProcessor.validate({
    title:"Quality review",
    summary:"Updated note and evidence",
    operations:[{
      action:"set_requirements",
      item_id:"paint",
      title:"Paint finish inspection",
      item_type:"rating",
      note:"",
      requirements:["photo", "audio", "photo", "unsupported"],
      confidence:.97,
      reason:"Explicit requirements"
    }]
  });
  assert.deepEqual(validated.operations[0]!.requirements, ["photo", "audio"]);
  assert.match(checklistAudioProcessor.instructions, /add_note/);
  assert.match(checklistAudioProcessor.instructions, /set_requirements/);
});
