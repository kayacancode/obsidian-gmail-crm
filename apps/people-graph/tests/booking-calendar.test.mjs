import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBookingCalendarModel, calendarMonthDays, formatCalendarSlot } from '../public/booking-calendar.mjs';

test('groups an instant into the displayed timezone’s date across a month boundary', () => {
  const slot = { start: '2026-11-01T00:30:00Z', end: '2026-11-01T01:00:00Z' };
  const newYork = buildBookingCalendarModel([slot], 'America/New_York');
  const tokyo = buildBookingCalendarModel([slot], 'Asia/Tokyo');
  assert.equal(newYork.selectedDate, '2026-10-31');
  assert.equal(newYork.firstMonth, '2026-10');
  assert.equal(tokyo.selectedDate, '2026-11-01');
  assert.equal(tokyo.firstMonth, '2026-11');
  assert.equal(newYork.days.get('2026-10-31')[0], slot, 'the original timestamps reach the time choice unchanged');
});

test('sorts available days and opens the exact requested slot’s month', () => {
  const october = { start: '2026-10-31T15:00:00Z', end: '2026-10-31T15:30:00Z' };
  const january = { start: '2027-01-04T15:00:00Z', end: '2027-01-04T15:30:00Z' };
  const model = buildBookingCalendarModel([january, october], 'UTC', january.start);
  assert.deepEqual([...model.days.keys()], ['2026-10-31', '2027-01-04']);
  assert.equal(model.selectedDate, '2027-01-04');
  assert.equal(model.firstMonth, '2026-10');
  assert.equal(model.lastMonth, '2027-01');
  assert.equal(buildBookingCalendarModel([january, october], 'UTC', '2027-01-05T15:00:00Z').selectedDate, '2026-10-31');
});

test('retains the selected local day when its first slot disappears on refresh', () => {
  const earlierDay = { start: '2026-10-29T15:00:00Z', end: '2026-10-29T15:30:00Z' };
  const laterTime = { start: '2026-11-02T15:00:00Z', end: '2026-11-02T15:30:00Z' };
  const model = buildBookingCalendarModel([earlierDay, laterTime], 'America/New_York', '2026-11-02T14:00:00Z');
  assert.equal(model.selectedDate, '2026-11-02');
  assert.equal(model.days.get(model.selectedDate)[0], laterTime);
});

test('falls back to the earliest day when the remembered start is invalid or its day has no slots', () => {
  const earlierDay = { start: '2026-10-29T15:00:00Z', end: '2026-10-29T15:30:00Z' };
  const laterDay = { start: '2026-11-02T15:00:00Z', end: '2026-11-02T15:30:00Z' };
  for (const selectedStart of ['invalid timestamp', '2026-11-03T14:00:00Z']) {
    const model = buildBookingCalendarModel([laterDay, earlierDay], 'America/New_York', selectedStart);
    assert.equal(model.selectedDate, '2026-10-29');
  }
});

test('ignores invalid ranges and duplicate starts without altering valid slots', () => {
  const valid = { start: '2026-10-22T15:00:00Z', end: '2026-10-22T15:30:00Z' };
  const model = buildBookingCalendarModel([
    null, {}, { start: 'no date', end: valid.end },
    { start: valid.start, end: 'no date' },
    { start: valid.start, end: '2026-10-22T14:30:00Z' },
    { start: valid.start, end: valid.start },
    valid, { ...valid },
    { start: '2026-10-22T11:00:00-04:00', end: '2026-10-22T11:30:00-04:00' },
  ], 'UTC');
  assert.deepEqual(model.slots, [valid]);
  assert.equal(model.slots[0], valid);
  assert.deepEqual(buildBookingCalendarModel([], 'UTC'), {
    slots: [], days: new Map(), selectedDate: null, firstMonth: null, lastMonth: null,
  });
});

test('lays out a leap-year month from Sunday with blank padding only outside the month', () => {
  const cells = calendarMonthDays('2028-02');
  assert.equal(cells.length, 35);
  assert.deepEqual(cells.slice(0, 4), [null, null, '2028-02-01', '2028-02-02']);
  assert.equal(cells[30], '2028-02-29');
  assert.deepEqual(cells.slice(31), [null, null, null, null]);
});

test('keeps repeated fall-back times distinct through their UTC offsets', () => {
  const early = { start: '2026-11-01T05:00:00Z', end: '2026-11-01T05:30:00Z' };
  const late = { start: '2026-11-01T06:00:00Z', end: '2026-11-01T06:30:00Z' };
  const model = buildBookingCalendarModel([late, early], 'America/New_York');
  assert.deepEqual(model.days.get('2026-11-01'), [early, late]);
  const first = formatCalendarSlot(early, 'America/New_York');
  const second = formatCalendarSlot(late, 'America/New_York');
  assert.equal(first.range, second.range);
  assert.equal(first.zone, 'GMT-4');
  assert.equal(second.zone, 'GMT-5');
  assert.match(first.accessible, /^Choose .*November 1, 2026.*GMT-4/);
  assert.match(second.accessible, /^Choose .*November 1, 2026.*GMT-5/);
});

test('identifies the end date when an available time crosses local midnight', () => {
  const slot = { start: '2026-10-31T23:45:00Z', end: '2026-11-01T00:15:00Z' };
  const label = formatCalendarSlot(slot, 'UTC');
  assert.match(label.accessible, /October 31, 2026.*November 1, 2026/);
});
