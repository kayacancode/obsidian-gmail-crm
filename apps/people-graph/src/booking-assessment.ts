import {assessMeetingFit} from './booking-fit';
import {lookupBookingPerson} from './booking-people';
import {decideBooking} from './booking-policy';
import type {BookingDecision,BookingEnv,BookingSettings} from './booking-types';

/** One judgment path. Channel authorization does not imply meeting approval. */
export async function assessMeetingRequest(env:BookingEnv,settings:BookingSettings,email:string,evidence:{project:string;purpose:string},emailAuthoritative=true):Promise<BookingDecision>{
 const [fit,people]=await Promise.all([assessMeetingFit(env,settings,evidence),emailAuthoritative?lookupBookingPerson(env,settings.owner,email):Promise.resolve({status:'unavailable' as const,reason:'Google has not established authority over this email address. The owner must review this request.'})]);
 return decideBooking(settings,email,fit,people);
}
