/**
 * Device types an app can exist on (docs/architecture/app-experience.md).
 *
 * A device type is data: add a row to support another one (a tablet, say) and
 * every app, role, group and person can then declare and set it. The browser
 * sorts the device it runs on into exactly one type with `match`: the first
 * type in this list whose rules all pass, or the type with no rules.
 */
export type DeviceTypeMatch = {
  /** The viewport is at most this many CSS pixels wide. */
  max_width?: number;
  /** The viewport is at least this many CSS pixels wide. */
  min_width?: number;
  /** The primary pointer: "coarse" for touch, "fine" for a mouse. */
  pointer?: "coarse" | "fine";
};

export type DeviceType = {
  id: string;
  label: string;
  icon: string;
  /** Rules the browser checks to sort itself into this type; none means "otherwise". */
  match: DeviceTypeMatch;
};

export const DEVICE_TYPES: readonly DeviceType[] = Object.freeze([
  { id: "mobile", label: "Phone", icon: "fa-mobile-screen-button", match: { max_width: 820 } },
  { id: "desktop", label: "Desktop", icon: "fa-desktop", match: {} }
]);

/** Columns in App experience read left to right in this order. */
export const DEVICE_DISPLAY_ORDER: readonly string[] = Object.freeze(["desktop", "mobile"]);

export type DeviceId = string;

export function deviceTypeIds() {
  return DEVICE_TYPES.map((device) => device.id);
}

export function isDeviceTypeId(value: unknown): value is DeviceId {
  return typeof value === "string" && DEVICE_TYPES.some((device) => device.id === value);
}

/** Device types for the client: in display order, each with its sorting rules. */
export function deviceTypesForClient() {
  const order = (id: string) => {
    const index = DEVICE_DISPLAY_ORDER.indexOf(id);
    return index < 0 ? DEVICE_DISPLAY_ORDER.length : index;
  };
  return {
    // The browser checks `classify` in this order; display uses `types`.
    classify: DEVICE_TYPES.map((device) => device.id),
    types: [...DEVICE_TYPES]
      .sort((left, right) => order(left.id) - order(right.id))
      .map((device) => ({ ...device, match: { ...device.match } }))
  };
}
