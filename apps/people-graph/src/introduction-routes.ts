import type {ShareEnv} from './share-routes';
import {readWorkspace,memberOf,deny} from './workspace-store';
import {buildWorkspaceGraph,assertWorkspaceRevision,type WorkspaceGraph} from './workspace-graph';
import {buildAnswerCards,personEvidence} from './network-answer';
import {createIntroductionRequest,readIntroductionRequest,listIntroductionRequests,replyToIntroductionRequest,type IntroductionRequest,type IntroductionState} from './introduction-store';
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max?v.trim():deny(400,'invalid_request');
export async function introductionRoute(env:ShareEnv,me:string,workspaceId:string,requestId:string|undefined,reply:boolean,method:string,body:any,cursor?:string){
 const workspace=await readWorkspace(env.DB,workspaceId),self=memberOf(workspace,me);
 const authorized=(r:IntroductionRequest)=>{if(![r.requesterId,r.recipientId].includes(self.id)||![r.requesterId,r.recipientId].every(id=>workspace.members.some(m=>m.id===id)))deny(403,'request_unavailable');};
 const project=(r:IntroductionRequest,g:WorkspaceGraph)=>{
  const profile=(id:string|null)=>{const p=g.nodes.find(n=>n.id===id);return p?{id:p.id,name:p.name,company:p.company,photoUrl:p.photoUrl}:null;};
  return {...r,clientRequestId:undefined,requesterName:workspace.members.find(m=>m.id===r.requesterId)!.email,recipientName:workspace.members.find(m=>m.id===r.recipientId)!.email,isRequester:r.requesterId===self.id,person:profile(r.personId),alternative:profile(r.alternativePersonId),evidence:personEvidence(g,r.personId).filter(e=>r.evidenceRefs.includes(e.ref)),evidenceRefs:undefined};
 };
 if(!requestId&&method==='GET'){
  const page=await listIntroductionRequests(env.DB,workspaceId,self.id,cursor),graph=await buildWorkspaceGraph(env,workspaceId,me);
  const requests=page.requests.filter(r=>[r.requesterId,r.recipientId].every(id=>workspace.members.some(m=>m.id===id))).map(r=>project(r,graph));await assertWorkspaceRevision(env,workspaceId,me,workspace.revision);return {requests,nextCursor:page.nextCursor};
 }
 if(!requestId&&method==='POST'){
  const recipientId=text(body.recipientId,200),personId=text(body.personId,200),clientRequestId=text(body.clientRequestId,200),message=text(body.message,2000);
  if(recipientId===self.id||!workspace.members.some(m=>m.id===recipientId))deny(400,'invalid_recipient');
  if(body.workspaceRevision!==workspace.revision)deny(409,'workspace_changed_retry');
  if(!Array.isArray(body.evidenceRefs)||body.evidenceRefs.length>5||!body.evidenceRefs.every((r:unknown)=>typeof r==='string'&&r.length<=200))deny(400,'invalid_evidence');
  const evidenceRefs=[...new Set<string>(body.evidenceRefs)].sort(),graph=await buildWorkspaceGraph(env,workspaceId,me),card=buildAnswerCards(graph,[{personId}])[0];
  if(!card?.routes.some(r=>r.memberId===recipientId))deny(404,'introduction_unavailable');
  if(evidenceRefs.some(ref=>!card.evidence.some(e=>e.ref===ref)))deny(400,'invalid_evidence');
  await assertWorkspaceRevision(env,workspaceId,me,workspace.revision);
  const item=await createIntroductionRequest(env.DB,{workspaceId,workspaceRevision:workspace.revision,requesterId:self.id,recipientId,clientRequestId,personId,message,evidenceRefs});await assertWorkspaceRevision(env,workspaceId,me,workspace.revision);return {request:project(item,graph)};
 }
 if(!requestId)deny(405,'method_not_allowed');
 const item=await readIntroductionRequest(env.DB,workspaceId,requestId);authorized(item);
 if(method==='GET'&&!reply){const graph=await buildWorkspaceGraph(env,workspaceId,me);await assertWorkspaceRevision(env,workspaceId,me,workspace.revision);return {request:project(item,graph)};}
 if(method!=='POST'||!reply)deny(405,'method_not_allowed');
 const state=body.state as IntroductionState,expectedRevision=body.expectedRevision;
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)deny(400,'invalid_revision');
 if(item.revision!==expectedRevision)deny(409,'request_changed');
 const terminal=['completed','cancelled','declined','alternative_suggested'].includes(item.state);
 if(terminal)deny(409,'request_closed');
 if(state==='cancelled'){if(self.id!==item.requesterId)deny(403,'request_unavailable');}
 else{if(self.id!==item.recipientId)deny(403,'recipient_required');
  if(!['checking_interest','agreed','alternative_suggested','declined','completed'].includes(state))deny(400,'invalid_state');
  if(state==='completed'&&!['checking_interest','agreed'].includes(item.state))deny(409,'agreement_required');
 }
 const message=text(body.reply,2000),graph=await buildWorkspaceGraph(env,workspaceId,me);let alternativePersonId:string|null=null;
 if(state==='alternative_suggested'){alternativePersonId=text(body.alternativePersonId,200);const candidate=graph.nodes.find(n=>n.id===alternativePersonId);if(!candidate||candidate.id===item.personId||candidate.sources?.includes('obsidian')&&!candidate.identityMatchReady||!candidate.relationships.some(r=>(r.evidenceCategory==='email'||r.evidenceCategory==='meeting')&&r.memberId===self.id))deny(400,'invalid_alternative');}
 await assertWorkspaceRevision(env,workspaceId,me,workspace.revision);
 const updated=await replyToIntroductionRequest(env.DB,{workspaceId,workspaceRevision:workspace.revision,requestId,expectedRevision,state,reply:message,alternativePersonId});await assertWorkspaceRevision(env,workspaceId,me,workspace.revision);return {request:project(updated,graph)};
}
