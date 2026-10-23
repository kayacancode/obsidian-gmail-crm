import type {BookingDecision} from './booking-types';
import type {SchedulingRecommendation} from './scheduling-types';

/** Owner-only assessment. Only the saved booking thesis is meeting policy. */
export function schedulingRecommendation(decision:BookingDecision,instructions=''):SchedulingRecommendation{
 return {
  summary:decision.tier==='priority'?'This request meets the saved meeting policy.':'This request needs your review before times are offered.',
  reasons:[...decision.reasons,...(decision.people.status==='matched'&&typeof decision.people.score==='number'?[`Exact relationship source score: ${decision.people.score}/100.`]:[])],
  uncertainties:[...decision.uncertainties,...(instructions.trim()?['Freeform instructions have not been validated as scheduling constraints; only the explicit time window and saved calendar rules are enforced.']:[])]
 };
}
