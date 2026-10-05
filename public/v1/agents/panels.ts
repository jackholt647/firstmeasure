import { randomUUID } from "node:crypto";
import { asArray, asObject, cleanText, nowIso, type JsonObject } from "./util.js";

export const MAX_PANELS_PER_TURN = 4;
export const MAX_WIDGETS_PER_PANEL = 6;
export function panelEnvelope(args: JsonObject, widgets: JsonObject[]): JsonObject {
  return { type: "panel", id: `panel_${randomUUID().replace(/-/g, "").slice(0,16)}`,
    title: cleanText(args.title).slice(0,80), subtitle: cleanText(args.subtitle).slice(0,160),
    key: cleanText(args.key).toLowerCase().replace(/[^a-z0-9_-]+/g,"-").slice(0,60),
    created_at: nowIso(), widgets };
}
/** Read compatibility only: historical chat artifacts and widget renders become panels. */
export function panelFrom(value: unknown): JsonObject | null {
  const entry = asObject(value);
  if (entry.type === "panel") return entry;
  if (entry.type === "artifact") return { ...entry, type: "panel", widgets: [{ ...entry, type: "visualization" }] };
  if (entry.type === "platform_widget") return { ...entry, type: "panel", widgets: [entry] };
  return null;
}
export function panelsFrom(renders: unknown): JsonObject[] {
  return asArray(renders).map(panelFrom).filter((entry): entry is JsonObject => !!entry);
}

export const VISUALIZATION_KINDS = ["bar", "line", "pie", "donut", "metrics", "table", "text"];
export const UNITS = ["currency", "number", "percent"];

function finiteNumbers(value: unknown, limit: number) {
  return asArray(value).slice(0, limit).map((entry) => {
    const number = Number(entry);
    return Number.isFinite(number) ? number : 0;
  });
}

/** Validates a declarative widget. The client renders it with its own chart code; no model HTML is ever executed. */
export function normalizeVisualizationWidget(args: JsonObject): JsonObject | string {
  const kind = cleanText(args.kind).toLowerCase();
  if (!VISUALIZATION_KINDS.includes(kind)) return `kind must be one of ${VISUALIZATION_KINDS.join(", ")}.`;
  const title = cleanText(args.title).slice(0, 80);
  if (!title) return "title is required.";
  const unit = UNITS.includes(cleanText(args.unit)) ? cleanText(args.unit) : "number";
  const widget: JsonObject = {
    type: "visualization",
    id: `widget_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    key: cleanText(args.key).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 60),
    kind, title, unit,
    subtitle: cleanText(args.subtitle).slice(0, 160),
    currency: cleanText(args.currency).toUpperCase().slice(0, 3) || "USD",
    created_at: nowIso()
  };
  if (["bar", "line", "pie", "donut"].includes(kind)) {
    const labels = asArray(args.labels).slice(0, 60).map((entry) => cleanText(entry).slice(0, 40));
    if (!labels.length) return "labels are required for charts.";
    const seriesLimit = kind === "pie" || kind === "donut" ? 1 : 6;
    const series = asArray(args.series).slice(0, seriesLimit).map((entry) => {
      const item = asObject(entry);
      return { name: cleanText(item.name).slice(0, 40), values: finiteNumbers(item.values, labels.length) };
    }).filter((item) => item.values.length);
    if (!series.length) return "series needs at least one entry with numeric values.";
    if ((kind === "pie" || kind === "donut") && series[0]?.values.some((value) => value < 0)) return "Pie and donut values must be zero or greater.";
    Object.assign(widget, { labels, series });
  } else if (kind === "metrics") {
    const metrics = asArray(args.metrics).slice(0, 6).map((entry) => {
      const item = asObject(entry);
      const value = Number(item.value);
      return {
        label: cleanText(item.label).slice(0, 40),
        value: Number.isFinite(value) ? value : 0,
        unit: UNITS.includes(cleanText(item.unit)) ? cleanText(item.unit) : unit,
        delta: cleanText(item.delta).slice(0, 40),
        trend: ["up", "down", "flat"].includes(cleanText(item.trend)) ? cleanText(item.trend) : "",
        good: ["up", "down"].includes(cleanText(item.good)) ? cleanText(item.good) : "up"
      };
    }).filter((item) => item.label);
    if (!metrics.length) return "metrics needs at least one {label, value}.";
    widget.metrics = metrics;
  } else if (kind === "table") {
    const columns = asArray(args.columns).slice(0, 8).map((entry) => cleanText(entry).slice(0, 40));
    if (!columns.length) return "columns are required for a table.";
    widget.columns = columns;
    widget.rows = asArray(args.rows).slice(0, 50).map((row) => asArray(row).slice(0, columns.length).map((cell) => {
      if (typeof cell === "number" && Number.isFinite(cell)) return cell;
      return cleanText(cell).slice(0, 120);
    }));
  } else {
    const text = cleanText(args.text).slice(0, 4000);
    if (!text) return "text is required for a text widget.";
    widget.text = text;
  }
  return widget;
}

