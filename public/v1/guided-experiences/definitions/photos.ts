import { addTabFaqs, registerExperience } from "../registry.js";

/**
 * The Photos tab's tour: the first time someone opens Photos on a project, and again from the agent's "Show me the
 * tutorial again". Data only; the runtime plays it (guided-experiences/service.ts, libraries/guided-experiences/).
 * Targets are the project gallery (apps/photos/project.js mounting PhotoFeed.mountProjectGallery from photos/feed.js
 * into #rPhotoFeedMount), with the plain gallery's controls as fallbacks. A missing target skips its step.
 */
const t = (key: string, text: string) => ({ key, text });
export const PHOTOS_TUTORIAL = "photos.tab_tutorial";
const GALLERY = "#rPhotoFeedMount";

let registered = false;
export function registerPhotosGuidedExperiences() {
  if (registered) return;
  registered = true;

  registerExperience({
    id: PHOTOS_TUTORIAL, version: 1, kind: "overlay", scope: "person", salt: "2026-10", replayable: true,
    title: t("gx_pt_title", "Photos tour"),
    tab: "project.photos",
    eligibility: { capabilities: ["platform.project_photos"] },
    triggers: [{ kind: "tab_opened", tab: "project.photos", delay_ms: 900 }],
    variants: [{ id: "tour", weight: 1 }],
    steps: [
      { id: "intro", targets: [], placement: "center", title: t("gx_pt_intro_title", "Welcome to Photos"), body: t("gx_pt_intro_body", "Every photo and video for this project lives here. Here's a quick look around.") },
      { id: "upload", targets: [`${GALLERY} [data-photo-feed-upload]`, "#rPhotoUploadBtn", "#rPhotoUploadEmpty"], title: t("gx_pt_upload_title", "Upload"), body: t("gx_pt_upload_body", "Add photos and videos from your computer or phone. You can pick several at once.") },
      { id: "gallery", targets: [`${GALLERY} [data-photo-feed-dynamic]`, "#rPhotoGridOnly"], title: t("gx_pt_gallery_title", "Your photos"), body: t("gx_pt_gallery_body", "Click a photo to open it. From there you can mark it up, comment on it or share it to the customer's portal.") },
      { id: "select", targets: [`${GALLERY} .pf-select`], title: t("gx_pt_select_title", "Pick several"), body: t("gx_pt_select_body", "Tick photos to work on a few at once, such as sharing them all to the customer's portal.") },
      { id: "search", targets: [`${GALLERY} .pf-search`], title: t("gx_pt_search_title", "Search"), body: t("gx_pt_search_body", "Find photos by date, who uploaded them or tag.") },
      { id: "tags", targets: [`${GALLERY} [data-local-tags]`], title: t("gx_pt_tags_title", "Filter by tag"), body: t("gx_pt_tags_body", "Show only the photos with the tags you choose.") },
      { id: "outro", targets: [], placement: "center", title: t("gx_pt_outro_title", "You're all set"), body: t("gx_pt_outro_body", "Want this tour again? Ask the agent \"Show me the tutorial again\".") }
    ]
  });

  // The tab's other questions live in materials.ts; this adds the replay beside them.
  addTabFaqs({ tab: "project.photos", questions: [
    { id: "photos.tour", text: t("gx_faq_photos_tour", "Show me the tutorial again"), action: "play", experience: PHOTOS_TUTORIAL }
  ] });
}
