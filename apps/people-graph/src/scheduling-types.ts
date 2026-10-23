import type {BookingRequestStatus,BookingSlot} from './booking-types';

/** Created by authenticated adapters; never copied from caller JSON. */
export interface SchedulingAuthority {channel:'owner_api'|'owner_email';evidenceId:string}
export interface SchedulingInput {
 email:string;name?:string;context:string;instructions?:string;timezone?:string;
 windowStart?:string;windowEnd?:string;idempotencyKey:string;
}
export interface SchedulingConfirmation {revision:string;slotId:string;evidenceId:string}
export interface SchedulingOfferedSlot extends BookingSlot {id:string}
export interface SchedulingOffer {revision:string;expiresAt:number;slots:SchedulingOfferedSlot[]}
export interface SchedulingRecommendation {summary:string;reasons:string[];uncertainties:string[]}
export interface SchedulingResult {
 requestId:string;status:BookingRequestStatus;timezone:string;offer:SchedulingOffer|null;
 replyText:string;recommendation:SchedulingRecommendation;
}
/** Additive private request JSON. Never included in visitor projections. */
export interface SchedulingRecord {
 authority:SchedulingAuthority;input:SchedulingInput;timezone:string;settingsRevision:number;
 windowStart:string;windowEnd:string;offer:SchedulingOffer|null;
 recommendation:SchedulingRecommendation;
 confirmation?:SchedulingConfirmation;
}
