/* External packages supply factories; only successful factories enter the app runtime. */
(function () {
  'use strict';
  const factories = new Map();
  function define(id, factory) {
    if (typeof id === 'string' && typeof factory === 'function') factories.set(id, factory);
  }
  function register(meta) {
    const runtime = window.FirstMateEmbeddableApps;
    const factory = factories.get(meta.id);
    factories.delete(meta.id);
    if (!factory || !runtime) return false;
    const id = `portal.external_${meta.id}`;
    if (runtime.getApp(id)) return false;
    try {
      const assetUrl = (file) => `/external-apps/asset.php?app=${encodeURIComponent(meta.id)}&file=${encodeURIComponent(file)}`;
      const implementation = factory(Object.freeze({ assetUrl }));
      if (!implementation || typeof implementation.mount !== 'function') return false;
      const app = {
        ...implementation,
        id, package: `external-${meta.id}`, title: meta.title, label: meta.title,
        icon: meta.icon, order: meta.order,
        kind: 'portal_tab', portalTabId: `external_${meta.id}`,
        surfaces: ['portal_tab'], regions: ['main'], visible: true,
        access: { applicationsAny: ['management'], capability: 'platform.expanded_access' },
        route: { parent: 'portal', params: { tab: { default: `external_${meta.id}`, history: 'push' } } },
        mount(context) {
          try { return implementation.mount(context); }
          catch (error) {
            console.warn(`External app ${meta.id} could not mount.`, error);
            const root = context.roots?.main || context.root;
            if (root) root.textContent = ((v0) => globalThis.PlatformLanguage?.text("app-runtime","m_32f15575d1ebba",`${v0} is currently unavailable.`,{v0}) ?? `${v0} is currently unavailable.`)(meta.title);
            return { destroy() { if (root) root.replaceChildren(); } };
          }
        }
      };
      runtime.registerManifest(app);
      runtime.registerApp(app);
      window.FirstMateAppsManifest?.apps?.push({ ...app });
      return true;
    } catch (error) {
      console.warn(`External app ${meta.id} was skipped.`, error);
      return false;
    }
  }
  window.FirstMateExternalApps = Object.freeze({ define, register });
})();
