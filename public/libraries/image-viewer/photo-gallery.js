/* Project photos in the Operations rail. Kept for callers that import this module: the rail's Photos view is the
 * shared media carousel, mounted by the Operations rail's own module (apps/materials/rail-media.js). */
import { mountRailPhotos } from '../apps/materials/rail-media.js?v=20261027-rail-media';
export function mount(root, { context = {}, initialState = {}, host = null } = {}) {
  const view = mountRailPhotos(root, { context, initialState, host });
  return { ready: Promise.resolve(), serialize: () => view.serialize(), setVisible: (value) => view.setVisible(value), resize: () => view.resize(), destroy: () => view.destroy() };
}
