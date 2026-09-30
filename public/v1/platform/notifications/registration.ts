/** Team channels and live chat use their existing membership-aware producers. */
export function eventIsSubscribable(event:string){
 return !/^(channels|chat)\./.test(event);
}
export const notificationGroupingPaths=['project_id','payload.document_id','payload.template_id','payload.workflow_id','payload.scope_template_id','payload.work_plan_id'] as const;
export function eventTagPath(event:string){return event.startsWith('document.')?'payload.document_tags':undefined;}
export function eventGroupingPaths(event:string){return notificationGroupingPaths.filter(path=>path==='project_id'||(event.startsWith('document.')?['payload.document_id','payload.template_id','payload.workflow_id'].includes(path):event.startsWith('work.')?['payload.scope_template_id','payload.work_plan_id'].includes(path):false));}
