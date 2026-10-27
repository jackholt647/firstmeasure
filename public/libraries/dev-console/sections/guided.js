/* Guided experiences (docs/architecture/guided-experiences.md, "Development"): the guided library draws its own tools here. */
export async function mount(root, { T, esc }) {
  const guides = window.FirstMateGuides;
  // The library learns that this person is a development editor from its first list; wait for it briefly.
  for (let i = 0; i < 40 && guides && !guides.isDevEditor?.(); i++) await new Promise((r) => setTimeout(r, 150));
  const handle = guides?.devPanel?.(root);
  if (!handle) root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_guided_unavailable', 'Guided experience tools are not available on this page.'))}</p>`;
  return handle;
}
