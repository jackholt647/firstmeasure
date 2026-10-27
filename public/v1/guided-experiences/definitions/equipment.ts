import { addTabFaqs, registerExperience } from '../registry.js';

const t = (key: string, text: string) => ({ key, text });
export const EQUIPMENT_TUTORIAL = 'equipment.tab_tutorial';
let registered = false;
export function registerEquipmentGuidedExperiences() {
  if (registered) return;
  registered = true;
  registerExperience({
    id: EQUIPMENT_TUTORIAL, version: 1, kind: 'overlay', scope: 'person', salt: '2026-10', replayable: true,
    title: t('gx_eq_tour_title', 'Equipment tour'), tab: 'portal.equipment',
    eligibility: { capabilities: ['apps.equipment'] },
    triggers: [{ kind: 'tab_opened', tab: 'portal.equipment', delay_ms: 0 }],
    variants: [{ id: 'tour', weight: 1 }],
    steps: [
      { id: 'intro', targets: [], placement: 'center', title: t('gx_eq_intro_title', 'Equipment that fits the work'), body: t('gx_eq_intro_body', 'Your scope of work tells a project what it needs. Equipment tells it what you can provide—from hauling debris to reaching the roof.') },
      { id: 'fleet', targets: ['#tab_equipment [data-eq-add-unit]', '[data-eq-add-unit]'], title: t('gx_eq_fleet_title', 'Add what you use'), body: t('gx_eq_fleet_body', 'Add equipment you own or rent. Give each unit a name so you can choose the right one for a project.') },
      { id: 'capabilities', targets: [], placement: 'center', title: t('gx_eq_functions_title', 'Say what it can do'), body: t('gx_eq_functions_body', 'An equipment type describes the functions it provides and its capacity. These match the requirements published by your project documents and scope of work.') },
      { id: 'projects', targets: [], placement: 'center', title: t('gx_eq_projects_title', 'Bring it into Operations'), body: t('gx_eq_projects_body', 'Choose equipment on a project’s work order to cover those requirements. Operations shows what is covered and what still needs attention, alongside your materials and work orders.') },
      { id: 'finish', targets: [], placement: 'center', title: t('gx_eq_finish_title', 'Start with one unit'), body: t('gx_eq_finish_body', 'Add the equipment you use most. You can build the rest of your fleet as you go.') }
    ]
  });
  addTabFaqs({ tab: 'portal.equipment', questions: [
    { id: 'equipment.tour', text: t('gx_eq_faq_tour', 'Show me the equipment tutorial again'), action: 'play', experience: EQUIPMENT_TUTORIAL }
  ] });
}
