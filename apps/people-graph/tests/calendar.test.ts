import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCalendarEvent} from '../src/calendar';
const event={id:'one',iCalUID:'shared-id',summary:'Design review',start:{dateTime:'2026-09-25T10:00:00Z'},end:{dateTime:'2026-09-25T11:00:00Z'},attendees:[{email:'me@example.com',self:true,responseStatus:'accepted'},{email:'ada@example.com',responseStatus:'accepted'},{email:'bo@example.com',responseStatus:'declined'}]};
test('calendar retains RSVP evidence without claiming attendance',()=>{
 const value=normalizeCalendarEvent(event,'me@example.com')!;
 assert.equal(value.status,'accepted');assert.deepEqual(value.people,['ada@example.com']);
 assert.equal(value.at,'2026-09-25T10:00:00.000Z');
 assert.equal(value.key,normalizeCalendarEvent({...event,id:'copy'},'other@example.com')!.key);
 assert.equal(normalizeCalendarEvent({...event,status:'cancelled'},'me@example.com'),null);
 assert.equal(normalizeCalendarEvent({...event,attendees:event.attendees.map(a=>a.self?{...a,responseStatus:'declined'}:a)},'me@example.com'),null);
});
test('calendar excludes resource calendars, preserves tentative status and all-day semantics',()=>{
 const value=normalizeCalendarEvent({...event,start:{date:'2026-09-25'},end:{date:'2026-09-26'},attendees:[{email:'room@example.com',resource:true,responseStatus:'accepted'},{email:'ada@example.com',responseStatus:'tentative'}]},'me@example.com')!;
 assert.deepEqual(value.people,['ada@example.com']);assert.equal(value.status,'invited');assert.equal(value.allDay,true);
});
