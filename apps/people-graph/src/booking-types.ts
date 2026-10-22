import type {MailEnv} from './mail-sync';
import type {BookingCoordinator} from './booking-coordinator';

export interface BookingSettings {
 owner:string; revision:number; slug:string; displayName:string; intro:string; thesis:string;
 timezone:string; durationMinutes:number; bufferMinutes:number; minNoticeHours:number; horizonDays:number;
 reviewDelayDays:number; dailyLimit:number; weeklyLimit:number; weekdays:number[]; startTime:string; endTime:string;
 vipEmails:string[]; enabled:boolean; autoBookPriority:boolean;
}
export type BookingTier='priority'|'review'|'async';
export interface BookingFit {fit:'strong'|'possible'|'weak'|'uncertain'; reasons:string[]; evidence:string[]; model:string}
export interface BookingPeopleContext {
 status:'matched'|'not_found'|'ambiguous'|'stale'|'unavailable';
 name?:string; email?:string; lastContact?:string|null; score?:number; lastSync?:string;
 reason:string;
}
export interface BookingSubmission {name:string;project:string;purpose:string;projectUrl:string;referrer:string}
export interface BookingVisitorIdentity {email:string;subject:string;emailAuthoritative:boolean}
export interface BookingDecision {tier:BookingTier;reasons:string[];uncertainties:string[];fit:BookingFit;people:BookingPeopleContext;policyRevision:number}
export type BookingRequestStatus='pending_approval'|'booking'|'booked'|'cancelling'|'needs_new_slot'|'declined'|'async_submitted'|'cancelled'|'expired';
export interface BookingRequestRecord extends BookingSubmission {
 id:string;owner:string;email:string;createdAt:number;updatedAt:number;status:BookingRequestStatus;
 decision:BookingDecision;slotStart:string|null;slotEnd:string|null;eventId:string|null;idempotencyKey:string;
 visitorSubject?:string;emailAuthoritative?:boolean;
 initialDecision?:BookingDecision;
 policySnapshot?:Omit<BookingSettings,'vipEmails'> & {vipMatch:boolean};
}
export interface BookingSlot {start:string;end:string}
export interface BookingBusy {start:string;end:string}
export interface BookingCalendarRecord {owner:string;email:string;grant:string;connectedAt:number}
export interface BookingReadiness {signIn:boolean;calendar:boolean;people:boolean;pilot:boolean;issues:string[]}
export interface BookingEnv extends MailEnv {
 DB:D1Database; BOOKING:DurableObjectNamespace<BookingCoordinator>;
 BOOKING_OWNER_EMAIL?:string;
 PEOPLEGRAPH_HOST?:string; PEOPLEGRAPH_TOKEN?:string; PEOPLEGRAPH_OWNER_EMAIL?:string;
}
