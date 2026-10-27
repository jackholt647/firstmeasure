import { z } from "zod";
// Every capability the platform declares, including the ones modules register as a side effect, so a check sees the
// whole registry whichever process runs it.
import "../../platform/capability_defs.js";
import "../../assistant/capabilities.js";
import "../../comms/capabilities.js";
import "../../chat/capabilities.js";
import { capabilityDefinition } from "../../platform/capabilities.js";

/**
 * Checks shared by the kinds that hold capability values (capability defaults, flag defaults, presets, the signup
 * preset and sandbox configurations): every key is a declared value capability and every value fits its type and
 * options. The declarations stay code (platform/capability_defs.ts); only values are library data.
 */

export const CAPABILITY_KEY = /^[a-z0-9_]+\.[a-z0-9_]+$/;
export const capabilityValueSchema = z.union([z.boolean(), z.number().finite(), z.string().max(2000)]);
export const capabilityValuesSchema = z.record(z.string().regex(CAPABILITY_KEY, "A capability key is group.flag."), capabilityValueSchema);
export const groupedCapabilityValuesSchema = z.record(z.string().regex(/^[a-z0-9_]+$/), z.record(z.string().regex(/^[a-z0-9_]+$/), capabilityValueSchema));

/** Problems with one capability value; `allowUserChoice` accepts "$user" (a sandbox page's choice). */
export function capabilityValueErrors(key: string, value: unknown, at: string, options: { allowUserChoice?: boolean } = {}): string[] {
  const node = capabilityDefinition(key);
  if (!node) return [`${at}: ${key} is not a declared capability.`];
  if (!node.stores_value) return [`${at}: ${key} is a permission; it holds no value.`];
  if (options.allowUserChoice && value === "$user") return [];
  if (node.type === "boolean") return typeof value === "boolean" ? [] : [`${at}: ${key} is on or off (true or false).`];
  if (node.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${at}: ${key} is a number.`];
    return node.min !== undefined && value < node.min ? [`${at}: ${key} is at least ${node.min}.`] : [];
  }
  const allowed = new Set(node.options.map(([option]) => option));
  if (typeof value !== "string") return [`${at}: ${key} is one of ${[...allowed].join(", ")}.`];
  if (node.type === "select") return allowed.has(value) ? [] : [`${at}: ${key} has no option ${JSON.stringify(value)} (${[...allowed].join(", ")}).`];
  const unknown = value.split(",").map((part) => part.trim()).filter((part) => part && !allowed.has(part));
  return unknown.length ? [`${at}: ${key} has no option ${unknown.map((part) => JSON.stringify(part)).join(", ")}.`] : [];
}

export function capabilityValuesErrors(values: Record<string, unknown>, at: string, options: { allowUserChoice?: boolean } = {}) {
  return Object.entries(values).flatMap(([key, value]) => capabilityValueErrors(key, value, `${at}.${key}`, options));
}

/** The stored `{group: {flag: value}}` shape (global.data.app_flags). */
export function groupedCapabilityValuesErrors(grouped: Record<string, Record<string, unknown>>, at: string) {
  return Object.entries(grouped).flatMap(([group, flags]) => Object.entries(flags).flatMap(([flag, value]) => capabilityValueErrors(`${group}.${flag}`, value, `${at}.${group}.${flag}`)));
}
