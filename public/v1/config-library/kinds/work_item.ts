import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { DICTIONARY_ID, unchanged } from "./dictionary-shared.js";

export const WORK_ITEM_KIND = "work_item";

/** One thing a job can require (platform/publication/work-items.ts): work, or a function such as debris disposal. The entry id is the item id. */
export const workItemData = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["work", "function"]),
  unit: z.string().trim().min(1).max(40),
  description: z.string().max(1000),
  /** For a function: equipment usually meets it a load at a time. Only a starting point for whoever sets a type up. */
  per_load_default: z.boolean().optional()
}).strict();
export type WorkItemData = z.infer<typeof workItemData>;

export const workItemKind: LibraryKind<WorkItemData> = {
  kind: WORK_ITEM_KIND,
  title: "Work items",
  description: "The shared dictionary of what a job can require: work to be done and functions (capacities that are not labor), with no price and nobody named. Only ever added to; an item's kind and unit never change.",
  idPattern: DICTIONARY_ID,
  schema: workItemData,
  appendOnly: true,
  titleOf: (data) => data.label,
  compatible: (previous, next, id) => unchanged(previous, next, ["kind", "unit"], id)
};
