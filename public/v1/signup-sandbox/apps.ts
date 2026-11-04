import { appDefinitions, appDefinition, type AppDefinition } from "../platform/app-experience/registry.js";
import { APP_OFFERS, NEW_ORGANIZATION_APP_OFFERS, offerSiblings, offeredAppIds, maskOfferedCapabilities, type OfferedAppId } from "../platform/app-experience/offers.js";
import {
  capabilityDefinition, capabilityDefinitions, EQUIPMENT_SIMPLE_CAPABILITIES, flattenGroupedValues, normalizeCapabilityValue, resolveCapabilities,
  type CapabilityValue, type NormalizedCapability
} from "../platform/capabilities.js";
import { newOrganizationAppFlagDefaults } from "../platform/app_flags.js";
import { badRequest } from "../platform/errors.js";
import type { SandboxConfigurationData } from "../config-library/kinds/sandbox_configuration.js";
import { appFlagBaseOverrides, USER_CHOICE } from "./service.js";

/**
 * Every app's starting state in a signup sandbox configuration (the sandbox's Apps tab), read from and written to
 * the configuration's own data, the same way a test organization is made from it (`createTestInstance`):
 *
 * - **On**: one of the app's organization switches (registry `capabilities`) resolves on, after the configuration's
 *   offers mask theirs, and its placement is not `hidden`. An app without a switch is always on.
 * - **Offered**: the app is in `settings.app_offers` (or, with no list, the new-organization offers) and one of its
 *   offer switches is on before masking, so it shows its welcome until someone starts it.
 * - **Off**: anything else (a switch off, a dependency off, a switch masked by another app's offer, or `hidden`).
 *
 * Writing a state changes only those fields: switches (with what they depend on, when turning on) in
 * `defaults.app_flags`, the offer list and the app's placement. A flag that ends up equal to what the configuration's
 * base gives anyway is removed rather than written. Nothing here depends on which configuration it is.
 */

export const APP_STATES = ["on", "offered", "off"] as const;
export type AppState = (typeof APP_STATES)[number];
type Json = SandboxConfigurationData["defaults"]["settings"][string];
type Flat = Record<string, CapabilityValue>;

const PLACEMENTS = ["sidebar", "more", "settings", "hidden"] as const;
const PILLS = ["new", "coming_soon"] as const;
const SURFACE_GROUPS = [
  { id: "portal_tab", title: "Portal apps" },
  { id: "project_modal", title: "Project tabs" },
  { id: "contact_modal", title: "Contact tabs" }
] as const;

const object = (value: unknown): Record<string, Json> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Json> : {};
const isOffered = (id: string): id is OfferedAppId => Object.prototype.hasOwnProperty.call(APP_OFFERS, id);

/** What a new organization's flags are before this configuration's own: registration's start, then its base. */
export async function configurationFlagBase(data: Pick<SandboxConfigurationData, "app_flags_base">): Promise<Flat> {
  const start = flattenGroupedValues((await newOrganizationAppFlagDefaults()) as Record<string, unknown>);
  const base: Flat = { ...start };
  for (const [key, value] of Object.entries(appFlagBaseOverrides(data.app_flags_base))) base[key] = value as CapabilityValue;
  return base;
}

function configuredValues(data: SandboxConfigurationData, base: Flat): Flat {
  const values: Flat = { ...base };
  for (const [key, value] of Object.entries(data.defaults.app_flags)) {
    const node = capabilityDefinition(key);
    if (value === USER_CHOICE || !node?.stores_value) continue;
    values[key] = normalizeCapabilityValue(node, value);
  }
  return values;
}

function configuredOffers(data: SandboxConfigurationData): OfferedAppId[] {
  const list = data.defaults.settings.app_offers;
  return Array.isArray(list) ? offeredAppIds(list) : [...NEW_ORGANIZATION_APP_OFFERS];
}

function placements(data: SandboxConfigurationData) {
  return object(data.defaults.settings.app_placements);
}

function pills(data: SandboxConfigurationData) {
  return object(object(data.defaults.settings.project_tabs).pills);
}

/** The value-bearing features and settings under an app's switches, which its state does not already decide. */
function appFeatures(app: AppDefinition, nodes: NormalizedCapability[]) {
  const own = new Set(app.capabilities);
  return nodes.filter((node) => node.stores_value && !own.has(node.key) && node.ancestors.some((key) => own.has(key)))
    .sort((left, right) => left.order - right.order);
}

function appTitle(app: AppDefinition, data: SandboxConfigurationData) {
  const [namespace, key] = String(app.terminology_key || "").split(".");
  const label = namespace && key ? object(data.terminology[namespace])[key] : undefined;
  return typeof label === "string" && label ? label : app.title;
}

export type ConfigurationApps = Awaited<ReturnType<typeof configurationApps>>;

/** Every app's state, features and options in a configuration. */
export async function configurationApps(data: SandboxConfigurationData) {
  const base = await configurationFlagBase(data);
  const values = configuredValues(data, base);
  const offers = configuredOffers(data);
  const ceiling = resolveCapabilities(values);
  const resolved = resolveCapabilities(maskOfferedCapabilities(values, offers));
  const placed = placements(data);
  const pilled = pills(data);
  const nodes = capabilityDefinitions();
  const apps = appDefinitions();
  const titles = new Map(apps.map((app) => [app.id, appTitle(app, data)]));
  const rows = apps.map((app) => {
    const placement = typeof placed[app.id] === "string" ? String(placed[app.id]) : "";
    const switchOn = !app.capabilities.length || app.capabilities.some((key) => resolved.effectiveByKey[key] === true);
    const offered = isOffered(app.id) && offers.includes(app.id) && APP_OFFERS[app.id].some((key) => ceiling.effectiveByKey[key] === true);
    const state: AppState = offered ? "offered" : switchOn && placement !== "hidden" ? "on" : "off";
    // Why an app is off, for the popover: the first of its switches and the reason the resolver gives.
    const reason = state !== "off" ? "" : placement === "hidden" && switchOn ? "hidden"
      : app.capabilities.map((key) => {
        if (offers.some((id) => (APP_OFFERS[id] as readonly string[]).includes(key)) && ceiling.effectiveByKey[key] === true) return `offered:${offers.find((id) => (APP_OFFERS[id] as readonly string[]).includes(key))}`;
        return String(resolved.reasons[key] || (capabilityDefinition(key) ? "" : "unknown_flag"));
      }).find(Boolean) || "";
    const sharedWith = apps.filter((other) => other.id !== app.id && other.capabilities.some((key) => app.capabilities.includes(key))).map((other) => other.id);
    return {
      id: app.id,
      title: titles.get(app.id)!,
      icon: app.icon,
      surface: app.surface,
      order: app.order,
      state,
      reason,
      switches: app.capabilities.map((key) => ({ key, label: capabilityDefinition(key)?.label || key, on: resolved.effectiveByKey[key] === true })),
      offerable: isOffered(app.id),
      offer_siblings: isOffered(app.id) ? offerSiblings(app.id).filter((id) => id !== app.id) : [],
      shared_with: sharedWith,
      placement,
      pill: app.surface === "project_modal" && typeof pilled[app.id] === "string" ? String(pilled[app.id]) : "",
      features: appFeatures(app, nodes).map((node) => ({
        key: node.key, label: node.label, description: node.description, type: node.type, options: node.options,
        // What the configuration sets (or its base gives); `effective` says whether it resolves on for booleans.
        value: values[node.key] ?? node.default,
        effective: node.type === "boolean" ? resolved.effectiveByKey[node.key] === true : resolved.values[node.key] ?? null,
        configured: Object.prototype.hasOwnProperty.call(data.defaults.app_flags, node.key),
        available: (node.parent ? resolved.effectiveByKey[node.parent] === true : true),
        locked: Object.prototype.hasOwnProperty.call(EQUIPMENT_SIMPLE_CAPABILITIES, node.key),
        depth: node.ancestors.length
      })),
      options: app.options.map((option) => {
        const set = object(data.role_app_options[app.id])[option.key];
        return { key: option.key, label: option.label, description: option.description, default: option.default, value: typeof set === "boolean" ? set : option.default };
      })
    };
  });
  // Two apps with one title in a group (the crew and sales "Today") are told apart by the mode the registry opens
  // them in, or else their first switch.
  const twin = (row: typeof rows[number]) => rows.filter((other) => other.surface === row.surface && other.title === row.title).length > 1;
  for (const row of rows.filter(twin)) {
    const mode = String(apps.find((app) => app.id === row.id)?.default_params.mode || "");
    const suffix = mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : row.switches[0]?.label;
    if (suffix) row.title = `${row.title} · ${suffix}`;
  }
  return {
    groups: SURFACE_GROUPS.map((group) => ({
      id: group.id,
      title: group.title,
      apps: rows.filter((row) => row.surface === group.id).sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    })),
    offers
  };
}

export type AppChange = {
  state?: AppState;
  /** Feature and setting values under the app's switches; null puts one back to the configuration's base. */
  features?: Record<string, CapabilityValue | null>;
  /** The app's options every role gets; null removes the configuration's value. */
  options?: Record<string, boolean | null>;
  /** Project tabs: "new", "coming_soon" or "" for none. */
  pill?: string;
  /** Portal tabs: sidebar, more, settings, hidden or "" for the default. */
  placement?: string;
};

/** Booleans a switch needs on to resolve on: itself, its parents and what it requires, transitively. */
function dependencyChain(key: string, seen = new Set<string>()) {
  if (seen.has(key)) return seen;
  const node = capabilityDefinition(key);
  if (!node) return seen;
  seen.add(key);
  for (const next of [...(node.parent ? [node.parent] : []), ...node.requires]) dependencyChain(next, seen);
  return seen;
}

/** The configuration with one app's state, features, options, pill or placement changed. */
export async function applyAppChange(input: SandboxConfigurationData, appId: string, change: AppChange): Promise<SandboxConfigurationData> {
  const app = appDefinition(appId);
  if (!app) throw badRequest("sandbox_app_unknown", `There is no app ${appId}.`);
  const data = structuredClone(input);
  const base = await configurationFlagBase(data);
  const flags = data.defaults.app_flags as Record<string, CapabilityValue>;
  const settings = data.defaults.settings as Record<string, Json>;
  const setFlag = (key: string, value: CapabilityValue | null) => {
    const node = capabilityDefinition(key);
    if (!node?.stores_value) return;
    if (value === null || normalizeCapabilityValue(node, value) === base[key]) delete flags[key];
    else flags[key] = normalizeCapabilityValue(node, value);
  };
  const setOffers = (next: OfferedAppId[]) => {
    const ordered = [...new Set(next)];
    // No list means the new-organization offers, so a change always writes the list it means.
    settings.app_offers = ordered;
  };
  const setPlacement = (value: string) => {
    const next = { ...placements(data) };
    if (value) next[app.id] = value; else delete next[app.id];
    if (Object.keys(next).length) settings.app_placements = next; else delete settings.app_placements;
  };
  const turnOn = (keys: readonly string[]) => {
    for (const key of keys) for (const needed of dependencyChain(key)) {
      const node = capabilityDefinition(needed);
      if (node?.stores_value && node.type === "boolean") setFlag(needed, true);
    }
  };

  if (change.state !== undefined) {
    if (!APP_STATES.includes(change.state)) throw badRequest("sandbox_app_state", "An app's state is on, offered or off.");
    const offers = configuredOffers(data);
    const own = isOffered(app.id) ? offerSiblings(app.id) : [];
    if (change.state === "offered") {
      if (!isOffered(app.id)) throw badRequest("sandbox_app_not_offerable", `${app.title} has no welcome, so it cannot be offered.`);
      // The offer's switches are on underneath (that is what starting it turns on); the offer masks them until then.
      turnOn(APP_OFFERS[app.id]);
      setOffers([...offers, ...own]);
      if (placements(data)[app.id] === "hidden") setPlacement("");
    } else if (change.state === "on") {
      if (!app.capabilities.length && placements(data)[app.id] !== "hidden") return data;
      turnOn(app.capabilities);
      // Its own offer and any other offer masking one of its switches would keep it off.
      const masking = offers.filter((id) => own.includes(id) || (APP_OFFERS[id] as readonly string[]).some((key) => app.capabilities.some((cap) => dependencyChain(cap).has(key))));
      if (masking.length || Array.isArray(settings.app_offers)) setOffers(offers.filter((id) => !masking.includes(id)));
      if (placements(data)[app.id] === "hidden") setPlacement("");
    } else {
      if (!app.capabilities.length) {
        if (app.surface !== "portal_tab") throw badRequest("sandbox_app_always_on", `${app.title} has no organization switch, so it is always on.`);
        setPlacement("hidden");
      } else {
        for (const key of app.capabilities) setFlag(key, false);
        if (own.some((id) => offers.includes(id))) setOffers(offers.filter((id) => !own.includes(id)));
      }
    }
  }

  if (change.features) {
    const allowed = new Set(appFeatures(app, capabilityDefinitions()).map((node) => node.key));
    for (const [key, value] of Object.entries(change.features)) {
      if (!allowed.has(key)) throw badRequest("sandbox_app_feature", `${key} is not a feature of ${app.title}.`);
      if (Object.prototype.hasOwnProperty.call(EQUIPMENT_SIMPLE_CAPABILITIES, key)) throw badRequest("sandbox_app_feature_fixed", `${key} is fixed by the platform.`);
      setFlag(key, value);
    }
  }

  if (change.options) {
    const declared = new Set(app.options.map((option) => option.key));
    const next = { ...object(data.role_app_options[app.id]) } as Record<string, boolean>;
    for (const [key, value] of Object.entries(change.options)) {
      if (!declared.has(key)) throw badRequest("sandbox_app_option", `${app.title} has no option ${key}.`);
      if (value === null) delete next[key]; else next[key] = value === true;
    }
    if (Object.keys(next).length) data.role_app_options[app.id] = next; else delete data.role_app_options[app.id];
  }

  if (change.pill !== undefined) {
    if (app.surface !== "project_modal") throw badRequest("sandbox_app_pill", "Only project tabs carry a pill.");
    if (change.pill && !(PILLS as readonly string[]).includes(change.pill)) throw badRequest("sandbox_app_pill", "A pill is new or coming_soon.");
    const tabs = { ...object(settings.project_tabs) };
    const nextPills = { ...object(tabs.pills) };
    if (change.pill) nextPills[app.id] = change.pill; else delete nextPills[app.id];
    tabs.pills = nextPills;
    settings.project_tabs = tabs;
  }

  if (change.placement !== undefined) {
    if (app.surface !== "portal_tab") throw badRequest("sandbox_app_placement", "Only portal apps have a placement.");
    if (change.placement && !(PLACEMENTS as readonly string[]).includes(change.placement)) throw badRequest("sandbox_app_placement", "A placement is sidebar, more, settings or hidden.");
    setPlacement(change.placement);
  }
  return data;
}
