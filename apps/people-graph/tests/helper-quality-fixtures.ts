import {rankHelperBrief} from '../src/helper-brief';
import {HELPER_MODEL_TIMEOUT_MS} from '../src/helper-model';

/** Synthetic cases for live-provider evaluation; contains no inbox data or personal identities. */
export const helperQualityCases=[
 {id:'generic-beta-onboarding',match:false,anchor:'We are currently in beta for iOS, iterating daily improvements.',candidate:"We've been trying to meet with 1 person/day to show them our new onboarding"},
 {id:'clinic-handoff-research',match:true,anchor:'We are building a scheduling tool for clinics. It coordinates nurse handoffs between shifts. We need to test whether the handoff workflow fits how nurses actually work.',candidate:'I led moderated usability interviews with hospital nurses about shift handoffs. We tested prototypes with ward staff and documented where information gets lost during a handoff.'},
 {id:'coding-agent-evaluations',match:true,anchor:'We are building decision models for coding agents. We need to understand when the agents choose the wrong tool or edit.',candidate:'We built an evaluation harness for coding-agent decisions. It replays tool calls against failing tests to identify incorrect edits and tool-selection failures.'},
 {id:'unrelated-launches',match:false,anchor:'We are building a booking app for tennis courts. Our beta launched last week.',candidate:'We are building accounting software for freelance illustrators. Our beta launched last week.'},
 {id:'third-party-research',match:false,anchor:'We are building a scheduling tool for clinics and need to test nurse handoff workflows.',candidate:'A person I met once led usability interviews with nurses and tested handoff prototypes. I have not worked on clinical workflows myself.'},
 {id:'negated-research',match:false,anchor:'We are building a scheduling tool for clinics and need to test nurse handoff workflows.',candidate:'I have never conducted nurse usability interviews or tested handoff prototypes. We do not work in healthcare.'},
 {id:'invoice-table-extraction',match:true,anchor:'We are replacing hard-coded extraction rules for multilingual invoices. Our current OCR loses tables on scanned documents.',candidate:'I built an invoice extraction pipeline using layout-aware OCR and table reconstruction for German and French PDFs. We check extracted totals against line-item sums.'},
];
export async function evaluateHelperQuality(env:Parameters<typeof rankHelperBrief>[0]){
 const observedAt=new Date().toISOString();
 return Promise.all(helperQualityCases.map(async c=>{
  const graph={nodes:[{id:'anchor'},{id:'candidate'}],themeSignals:[['a','anchor',c.anchor],['b','candidate',c.candidate]].map(([id,personId,summary])=>({id,personId,summary,sourceType:'gmail_body_derived',visibility:'private',observedAt,provenance:{title:'Email sender’s own words · building'}}))};
  const result=await rankHelperBrief(env,graph,'anchor','');
  return {id:c.id,expected:c.match,status:result.status,passed:result.checked&&(result.results.length>0)===c.match,results:result.results.map(r=>({reason:r.reason,conversation:r.conversation}))};
 }));
}

/** Isolated judging calibration. All names, claims and passages below are synthetic. */
export async function evaluateHelperVerifier(env:Parameters<typeof rankHelperBrief>[0]){
 const {verifyHelperProposal}=await import('../src/helper-explanation');
 const observedAt=new Date().toISOString();
 const clinic=helperQualityCases.find(c=>c.id==='clinic-handoff-research')!;
 const coding=helperQualityCases.find(c=>c.id==='coding-agent-evaluations')!;
 const cleanClinic={reason:'PERSON_A is testing a clinic handoff tool. PERSON_B has interviewed nurses and tested handoff prototypes, so they could compare which workflow assumptions to validate.',conversation:'Which handoff assumptions should the clinic scheduling tool test with nurses first?'};
 const cases=[
  {id:'human-clinic-grounded',expected:true,anchor:clinic.anchor,candidate:clinic.candidate,proposal:cleanClinic},
  {id:'human-coding-grounded',expected:true,anchor:coding.anchor,candidate:coding.candidate,proposal:{reason:'The coding-agent team needs to identify incorrect tool choices and edits. The other team built a harness for those failures, so they could compare evaluation methods.',conversation:'How could tool-call replay tests expose incorrect decisions in the coding agents?'}},
  {id:'invented-expertise',expected:false,anchor:clinic.anchor,candidate:clinic.candidate,proposal:{reason:'The clinic handoff tool needs testing. The other person built a clinically proven scheduling system adopted by fifty hospitals, so they could share its validation results.',conversation:'Which validation results from those fifty hospitals should guide the new clinic tool?'}},
  {id:'misattributed-third-party',expected:false,anchor:clinic.anchor,candidate:'A person I met once led usability interviews with nurses and tested handoff prototypes. I have not worked on clinical workflows myself.',proposal:cleanClinic},
  {id:'negated-experience',expected:false,anchor:clinic.anchor,candidate:'I have never conducted nurse usability interviews or tested handoff prototypes. We do not work in healthcare.',proposal:cleanClinic},
  {id:'superseded-current-work',expected:false,anchor:clinic.anchor,candidate:'We are running nurse usability studies and testing handoff prototypes with ward staff.',proposal:{reason:'PERSON_A needs to test clinic handoff workflows. PERSON_B is running nurse usability studies and handoff prototype tests, so they could compare workflow assumptions.',conversation:'Which nurse handoff assumptions should the prototype studies evaluate first?'}},
  {id:'retrieval-model-category-error',expected:false,anchor:'We use hosted language models to answer questions. A classifier chooses which model to use based on cost.',candidate:'We built a document retrieval layer for agents and compared it with a standard retrieval baseline.',proposal:{reason:'PERSON_A uses hosted language models. PERSON_B built a document retrieval layer.',conversation:'Does your retrieval layer outperform our language models?'}},
 ];
 return Promise.all(cases.map(async c=>{
  const evidence=(summary:string,ref:string)=>({summary,ref,date:observedAt,sourceType:'gmail_body_derived',sourceLabel:'Gmail',contributor:'You',title:'Email sender’s own words · building'});
  const candidateEvidence=evidence(c.candidate,'b');
  const candidateContext=[candidateEvidence];
  if(c.id==='superseded-current-work'){
   candidateEvidence.date=new Date(Date.now()-14*86400000).toISOString();
   candidateContext.push(evidence('We stopped all nurse usability studies last week. We no longer test handoff prototypes or advise on healthcare workflows.','b-new'));
  }
  const audit=await verifyHelperProposal(env.AI,{automatic:true,brief:'',proposal:{...c.proposal,personId:'candidate',score:3,anchorEvidence:[evidence(c.anchor,'a')],evidence:[candidateEvidence]},candidateContext},AbortSignal.timeout(HELPER_MODEL_TIMEOUT_MS));
  return {id:c.id,expected:c.expected,passed:(audit.grounded&&audit.attributed&&audit.specific)===c.expected,audit};
 }));
}
