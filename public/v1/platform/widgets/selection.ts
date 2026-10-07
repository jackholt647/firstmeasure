import { z } from 'zod';

/**
 * A widget selection is what the user picked in a displayed picker widget: one bounded JSON object of
 * references and plain values (media ids, ISO dates, hex colors, project ids). The browser reports it as
 * screen metadata. It is never authorization, file content, markup or a credential: a picked id must still
 * pass through an authorized read or action before it is used.
 */
export const WIDGET_SELECTION_MAX_BYTES=4096;
const text=z.string().max(512).refine(value=>!/[<>]/.test(value)&&!/^\s*data:/i.test(value),'Selections hold references and plain values only.');
const leaf=z.union([text,z.number().finite(),z.boolean(),z.null()]);
const name=z.string().min(1).max(64).refine(value=>!['__proto__','prototype','constructor'].includes(value),'Reserved key.');
const flat=z.record(name,leaf);
const value=z.union([leaf,z.array(z.union([leaf,flat])).max(100),z.record(name,z.union([leaf,z.array(leaf).max(100)]))]);
/** Structural contract shared by every transport. A widget's declared schema is checked separately. */
export const widgetSelectionValue=z.record(name,value).refine(selection=>Buffer.byteLength(JSON.stringify(selection))<=WIDGET_SELECTION_MAX_BYTES,'A widget selection is limited to 4 KB.');
/** Request fields for one displayed widget. An invalid selection is dropped; it never rejects the rest of the screen context. */
export const displayedWidgetSelection={selection:widgetSelectionValue.optional().catch(undefined),selection_confirmed:z.boolean().optional().catch(undefined)};
/** Removes the keys an invalid or absent selection leaves behind, so request JSON never carries undefined fields. */
export function dropEmptySelection<T extends {selection?:unknown;selection_confirmed?:unknown}>(entry:T):T{
 const next={...entry};if(next.selection===undefined){delete next.selection;delete next.selection_confirmed;}else if(next.selection_confirmed===undefined)delete next.selection_confirmed;return next;
}
