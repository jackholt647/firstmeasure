import { registerExperience, registerGuidedSource } from '../registry.js';
import { laborSetupOptions } from '../../labor/labor-setup.js';
import { roofingSupplierPresets } from '../../pricebook/setups/roofing.js';

const t = (key: string, text: string) => ({ key: `gx_ops_${key}`, text });
let registered = false;
export function registerOperationsGuidedExperiences() {
  if (registered) return;
  registered = true;
  registerGuidedSource('operations.suppliers', () => ({ suppliers: roofingSupplierPresets() }));
  registerGuidedSource('operations.workforce', ctx => laborSetupOptions(ctx.orgId));
  registerExperience({
    id: 'operations.workflow_tutorial', version: 1, kind: 'overlay', scope: 'person', salt: 'v1', replayable: true,
    title: t('workflow_tour_title', 'Build your project scope'), tab: 'project.materials',
    eligibility: { capabilities: ['platform.materials'], permissions: ['manage_projects'] }, triggers: [{ kind: 'manual' }],
    variants: [{ id: 'default', weight: 1 }],
    steps: [
      { id: 'work', targets: ['.ops-workflow .fmdw-piece-grid'], placement: 'bottom', advance: 'next',
        title: t('workflow_tour_work_title', 'Pick every kind of work'),
        body: t('workflow_tour_work_body', 'Roofing, gutters, siding—or a combination. Choose everything this project includes. You can select more than one.'), wait_ms: 5000 },
      { id: 'steps', targets: ['.ops-workflow [data-fmdw-steps]'], placement: 'right', advance: 'next',
        title: t('workflow_tour_steps_title', 'Build it one step at a time'),
        body: t('workflow_tour_scope_steps_body', 'Next you’ll check measurements and review the products and work. You can go back to change an answer.') },
      { id: 'continue', targets: ['.ops-workflow [data-fmdw-continue]'], placement: 'top', advance: 'next',
        title: t('workflow_tour_continue_title', 'Your choices build your scope'),
        body: t('workflow_tour_continue_body', 'Use Next when you’re ready. Finishing saves your scope of work, so Operations can generate materials from the choices you made.') }
    ]
  });
  const documentStep = { id: 'document', widget: 'operations-document', title: t('document_title', 'What does this project need?'),
    selects: ['operation_path', 'operations_document_id', 'operations_scope_ready', 'operations_project_id'], options: {}, required: true };
  registerExperience({
    id: 'operations.setup', version: 1, kind: 'modal', scope: 'organization', salt: 'operations-v1', replayable: true,
    title: t('title', 'Set up Operations'), tab: 'project.materials',
    description: t('description', 'Build a scope of work, then get your materials, work orders and equipment ready.'),
    eligibility: { capabilities: ['platform.materials'], permissions: ['manage_projects'] },
    triggers: [{ kind: 'tab_opened', tab: 'project.materials', delay_ms: 0 }],
    variants: [{ id: 'default', weight: 1 }],
    steps: [
      { id: 'path', widget: 'operations-path', title: t('path_title', 'Start with the work you’re planning'),
        subtitle: t('path_body', 'Your proposal tells us what the job needs, so we can build your materials and work order. Not ready for a proposal? Build a quick scope of work instead.'),
        selects: ['operation_path'] },
      documentStep,
      { id: 'ready', widget: 'operations-ready', title: t('ready_title', 'Your scope of work is ready'),
        subtitle: t('ready_body', 'Generate your materials now, or set up a little more of Operations. You can come back to any of these later.'),
        selects: ['operations_document_id', 'operation_path', 'operations_scope_ready', 'operations_project_id'],
        options: { setups: [
          { id: 'suppliers', label: 'Suppliers', minutes: 5, experience: 'operations.suppliers.setup' },
          { id: 'equipment', label: 'Equipment', minutes: 3, appId: 'portal.equipment' },
          { id: 'workforce', label: 'Workforce', terminologyKey: 'workforce.resource_group_plural', minutes: 5, experience: 'operations.workforce.setup' },
          { id: 'proposals', label: 'Proposals', minutes: 10, experience: 'operations.proposal.setup' }
        ] } }
    ],
    completion: { action: { id: 'operations.setup.complete', target: 'project' }, then: [{ resume: true }, { play: 'materials.tab_tutorial' }] }
  });
  registerExperience({
    id: 'operations.proposal.setup', version: 1, kind: 'modal', scope: 'organization', salt: 'v1', replayable: true,
    title: t('proposal_title', 'Create your proposal'), tab: 'project.materials',
    eligibility: { capabilities: ['platform.materials'], permissions: ['manage_projects'] }, triggers: [{ kind: 'manual' }],
    variants: [{ id: 'default', weight: 1 }], steps: [{ ...documentStep, options: { path: 'proposal' } }],
    completion: { action: { id: 'operations.setup.complete', target: 'project' } }
  });
  registerExperience({
    id: 'operations.suppliers.setup', version: 1, kind: 'modal', scope: 'organization', salt: 'v1', replayable: true,
    title: t('suppliers_title', 'Set up your suppliers'), tab: 'project.materials',
    eligibility: { capabilities: ['platform.materials'], permissions: ['manage_company_settings'] }, triggers: [{ kind: 'manual' }],
    variants: [{ id: 'default', weight: 1 }],
    steps: [{ id: 'suppliers', widget: 'supplier-columns', source: 'operations.suppliers', selects: ['suppliers'],
      title: t('suppliers_step', 'Where do you get your materials?'), subtitle: t('suppliers_body', 'Add your suppliers now. You can add their prices and delivery details whenever you’re ready.') }],
    completion: { action: { id: 'operations.suppliers.setup.apply', target: 'organization' } }
  });
  registerExperience({
    id: 'operations.workforce.setup', version: 1, kind: 'modal', scope: 'organization', salt: 'v1', replayable: true,
    title: t('workforce_title', 'Set up who does the work'), tab: 'project.materials',
    eligibility: { capabilities: ['platform.materials', 'apps.crew'], permissions: ['manage_company_settings', 'manage_projects'] }, triggers: [{ kind: 'manual' }],
    variants: [{ id: 'default', weight: 1 }],
    steps: [{ id: 'workforce', widget: 'labor-assignees', source: 'operations.workforce', selects: ['labor', 'include_labor'],
      title: t('workforce_step', 'Who will do the work?'), subtitle: t('workforce_body', 'Add your groups and subcontractors, and how you pay them. Work orders use their pay sheets.') }],
    completion: { action: { id: 'operations.workforce.setup.apply', target: 'organization' } }
  });
}
