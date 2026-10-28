import type { JsonObject } from '../platform/storage.js';
import { libraryData } from '../config-library/library.js';
import { DOCUMENT_TEMPLATE_KIND, DOCUMENT_WORKFLOW_KIND } from '../config-library/kinds/document-shared.js';

/**
 * The Operations scope of work and proposal. Their template and workflow are config library entries
 * (`document_template` / `document_workflow` tpl_operations_<path>_v1 and wfl_operations_<path>_v1, made for an
 * organization the first time it asks: documents/library-copies.ts); this file holds what the Operations window
 * offers around them.
 */
export type OperationsPath = 'scope' | 'proposal';
export const operationsTemplateId = (path: OperationsPath) => `tpl_operations_${path}_v1`;
export const operationsWorkflowId = (path: OperationsPath) => `wfl_operations_${path}_v1`;

export const OPERATIONS_PIECES = [
  {id:'roof_replacement',name:'Roof replacement',description:'Roof covering, flashing and accessories.',icon:'fa-house',measurement_schema_ids:['roofing']},
  {id:'gutters',name:'Gutter replacement',description:'Gutters, downspouts and optional guards.',icon:'fa-water',measurement_schema_ids:['gutters']},
  {id:'siding_replacement',name:'Siding replacement',description:'Wall covering, trim and weather barrier.',icon:'fa-building',measurement_schema_ids:['siding']}
];
export const OPERATIONS_MEASUREMENTS: Record<string, JsonObject[]> = {
  // In the order a roofer reads a report; gutters are offered as optional lines (a roof report rarely measures them).
  roof_replacement:[
    {key:'roofSquares',label:'Roof area',unit:'sq'},{key:'wastePercent',label:'Waste',unit:'%',default:10},{key:'eavesLf',label:'Eaves',unit:'ft'},
    {key:'rakesLf',label:'Rakes',unit:'ft'},{key:'ridgesLf',label:'Ridges',unit:'ft'},{key:'hipsLf',label:'Hips',unit:'ft'},{key:'valleyLf',label:'Valleys',unit:'ft'},
    {key:'sideWallLf',label:'Sidewalls',unit:'ft'},{key:'headWallLf',label:'Headwalls',unit:'ft'},{key:'pipeBootsEa',label:'Pipe boots',unit:'ea',default:0},
    {key:'skylightsEa',label:'Skylights',unit:'ea',default:0},{key:'chimneysEa',label:'Chimneys',unit:'ea',default:0},
    {key:'gutterLf',label:'Gutters',unit:'ft',default:0},{key:'downspoutLf',label:'Downspouts',unit:'ft',default:0}
  ],
  gutters:[{key:'gutterLf',label:'Gutter length',unit:'ft'},{key:'downspoutLf',label:'Downspout length',unit:'ft',default:0}],
  siding_replacement:[{key:'wallNetArea',label:'Net wall area',unit:'sq ft'},{key:'wallTerminationsLf',label:'Wall terminations',unit:'ft'},{key:'wastePercent',label:'Waste',unit:'%',default:10}]
};

/** The library's template and workflow definitions for one path (frozen; clone before changing). */
export function operationsDefinitions(path: OperationsPath) {
  const template = libraryData<{ definition: JsonObject }>(DOCUMENT_TEMPLATE_KIND, operationsTemplateId(path))?.definition;
  const workflow = libraryData<{ definition: JsonObject }>(DOCUMENT_WORKFLOW_KIND, operationsWorkflowId(path))?.definition;
  if (!template || !workflow) throw new Error(`The config library has no Operations ${path} template and workflow.`);
  return { template, workflow };
}
