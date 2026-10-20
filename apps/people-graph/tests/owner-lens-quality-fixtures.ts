import {explainHelpers,verifyHelperProposal,type HelperEvidence,type ExplainedHelper} from '../src/helper-explanation';
import {HELPER_MODEL,HELPER_MODEL_TIMEOUT_MS} from '../src/helper-model';

/** Synthetic owner-mode calibration. No inbox content, names, account IDs, or secrets. */
export const ownerLensQualityCases=[
 {
  id:'clinic-handoff-workflow',match:true,
  brief:'My current focus: Building a clinic scheduling tool that coordinates nurse shift handoffs.\nI am looking for: Validate the handoff workflow with nurses.',
  candidate:'I led moderated usability interviews with hospital nurses about shift handoffs. We tested prototypes with ward staff and documented where information gets lost during a handoff.',
  probe:{reason:'You are looking to validate nurse shift handoffs for your clinic scheduling tool. PERSON_B interviewed nurses and tested handoff prototypes.',conversation:'Which nurse handoff assumptions should your scheduling tool test first?'},
 },
 {
  id:'coding-agent-tool-decisions',match:true,
  brief:'My current focus: Building decision models for coding agents.\nI am looking for: Identify when the agents choose the wrong tool or code edit.',
  candidate:'We built an evaluation harness for coding-agent decisions. It replays tool calls against failing tests to identify incorrect edits and tool-selection failures.',
  probe:{reason:'You are looking to identify incorrect tool choices and edits by coding agents. PERSON_B built a harness that replays tool calls against failing tests to identify those failures.',conversation:'How could tool-call replay tests expose incorrect decisions in your coding agents?'},
 },
 {
  id:'broad-beta-onboarding',match:false,
  brief:'My current focus: Our iOS app is in beta and we are iterating daily improvements.',
  candidate:'We have been trying to meet with one person each day to show them our new onboarding.',
  probe:{reason:'You are improving an iOS beta. PERSON_B is showing people new onboarding, so you could exchange beta feedback.',conversation:'What onboarding feedback could help improve your iOS beta?'},
 },
 {
  id:'third-party-nurse-research',match:false,
  brief:'My current focus: Building a clinic scheduling tool.\nI am looking for: Test nurse shift handoff workflows.',
  candidate:'A person I met once led usability interviews with nurses and tested handoff prototypes. I have not worked on clinical workflows myself.',
  probe:{reason:'You are testing a clinic handoff workflow. PERSON_B has interviewed nurses and tested handoff prototypes.',conversation:'Which nurse handoff assumptions should your scheduling tool test first?'},
 },
] as const;

/** Run explanation plus the unchanged independent audit, without the Jev shortlist.
 * The fixed probe also exercises the audit when the explanation correctly returns no match.
 * Provider errors are explicit failures, never counted as a negative-case success.
 */
export async function evaluateOwnerLensQualityCase(ai:Env['AI']|undefined,id:string){
 const fixture=ownerLensQualityCases.find(value=>value.id===id);
 if(!fixture)throw Error('unknown_owner_lens_quality_case');
 const evidence:HelperEvidence={ref:'synthetic-source',summary:fixture.candidate,date:'2026-10-18T12:00:00.000Z',sourceType:'gmail_body_derived',sourceLabel:'Synthetic sent email',contributor:'Synthetic fixture',title:'Email sender’s own words · building'};
 const candidate={personId:'synthetic-candidate',score:3,evidence:[evidence]};
 const probe:ExplainedHelper={...candidate,...fixture.probe,anchorEvidence:[]};
 const started=Date.now();
 try{
  const proposals=await explainHelpers(ai,{owner:true,automatic:false,brief:fixture.brief,anchorEvidence:[],candidates:[candidate]},AbortSignal.timeout(HELPER_MODEL_TIMEOUT_MS));
  const audit=async(proposal:ExplainedHelper)=>verifyHelperProposal(ai,{owner:true,automatic:false,brief:fixture.brief,proposal,candidateContext:[evidence]},AbortSignal.timeout(HELPER_MODEL_TIMEOUT_MS));
  const [probeAudit,...proposalAudits]=await Promise.all([audit(probe),...proposals.map(audit)]);
  const accepted=(result:typeof probeAudit)=>result.grounded&&result.attributed&&result.specific;
  const results=proposals.map((proposal,index)=>({reason:proposal.reason,conversation:proposal.conversation,audit:proposalAudits[index],accepted:accepted(proposalAudits[index])}));
  const actualMatch=results.some(result=>result.accepted),probeAccepted=accepted(probeAudit);
  return {id:fixture.id,model:HELPER_MODEL,expected:fixture.match,status:'ready',passed:actualMatch===fixture.match&&probeAccepted===fixture.match,actualMatch,probeAccepted,probeAudit,results,elapsedMs:Date.now()-started};
 }catch(error){return {id:fixture.id,model:HELPER_MODEL,expected:fixture.match,status:'unavailable',passed:false,error:error instanceof Error?error.message:'unavailable',elapsedMs:Date.now()-started};}
}
