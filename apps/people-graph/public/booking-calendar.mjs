const locale = 'en-US';
const fullDateOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };

function dateFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

function dateKey(value, timeZone, formatter = dateFormatter(timeZone)) {
  const parts = formatter.formatToParts(new Date(value));
  const part = name => parts.find(item => item.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Keep the API's original slot objects: choosing a displayed time must submit
// its exact instant, never a timestamp reconstructed from a calendar date.
export function buildBookingCalendarModel(slots, timeZone, selectedStart) {
  const seen = new Set();
  const valid = (Array.isArray(slots) ? slots : []).filter(slot => {
    if (typeof slot?.start !== 'string' || typeof slot?.end !== 'string') return false;
    const start = Date.parse(slot.start), end = Date.parse(slot.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || seen.has(start)) return false;
    seen.add(start);
    return true;
  }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const days = new Map();
  const formatter = dateFormatter(timeZone);
  for (const slot of valid) {
    const day = dateKey(slot.start, timeZone, formatter);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(slot);
  }
  let selected = valid.find(slot => slot.start === selectedStart);
  if (!selected && typeof selectedStart === 'string' && Number.isFinite(Date.parse(selectedStart))) {
    selected = days.get(dateKey(selectedStart, timeZone, formatter))?.[0];
  }
  selected ||= valid[0];
  const dates = [...days.keys()];
  return {
    slots: valid, days,
    selectedDate: selected ? dateKey(selected.start, timeZone, formatter) : null,
    firstMonth: dates[0]?.slice(0, 7) || null,
    lastMonth: dates.at(-1)?.slice(0, 7) || null,
  };
}

export function calendarMonthDays(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = Array(firstWeekday).fill(null);
  for (let day = 1; day <= count; day++) cells.push(`${monthKey}-${String(day).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function formatCalendarSlot(slot, timeZone) {
  const start = new Date(slot.start), end = new Date(slot.end);
  const times = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' });
  const zones = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'shortOffset' });
  const dates = new Intl.DateTimeFormat(locale, { timeZone, ...fullDateOptions });
  const zone = value => zones.formatToParts(value).find(part => part.type === 'timeZoneName').value;
  const startZone = zone(start), endZone = zone(end);
  const endDate = dateKey(start, timeZone) === dateKey(end, timeZone) ? '' : `${dates.format(end)}, `;
  return {
    range: times.formatRange(start, end),
    zone: startZone === endZone ? startZone : `${startZone} → ${endZone}`,
    accessible: `Choose ${dates.format(start)}, ${times.format(start)} ${startZone} to ${endDate}${times.format(end)} ${endZone}, ${timeZone.replaceAll('_', ' ')}`,
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function calendarDateLabel(key, options = fullDateOptions) {
  // A date key is a civil date, not a local instant. UTC keeps calendar headings
  // and weekday alignment independent of the browser's own timezone.
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(new Date(`${key}T12:00:00Z`));
}

function shiftedMonth(key, amount) {
  const [year, month] = key.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function createBookingCalendar({ slots = [], timeZone = 'UTC', onChoose, onDayChange, selectedStart } = {}) {
  let zone = timeZone;
  let model = buildBookingCalendarModel(slots, zone, selectedStart);
  let selectedDate = model.selectedDate;
  let visibleMonth = selectedDate?.slice(0, 7) || null;
  // Changing display timezone must not replace the selected instant with an
  // earlier slot that happens to share its new local date.
  let anchor = model.slots.find(slot => slot.start === selectedStart)?.start || model.days.get(selectedDate)?.[0]?.start;
  const root = element('section', 'booking-calendar');
  root.setAttribute('aria-label', 'Choose a day and time');
  const monthPanel = element('div', 'calendar-month-panel');
  const header = element('div', 'calendar-heading');
  const previous = element('button', 'calendar-nav', '‹');
  const next = element('button', 'calendar-nav', '›');
  const title = element('h3', 'calendar-month');
  previous.type = next.type = 'button';
  previous.setAttribute('aria-label', 'Previous month');
  next.setAttribute('aria-label', 'Next month');
  title.setAttribute('aria-live', 'polite');
  title.setAttribute('aria-atomic', 'true');
  header.append(previous, title, next);
  const table = element('table', 'calendar-table');
  const caption = element('caption', 'calendar-sr-only');
  const thead = element('thead');
  const weekdays = element('tr');
  for (const [short, full] of [['Sun', 'Sunday'], ['Mon', 'Monday'], ['Tue', 'Tuesday'], ['Wed', 'Wednesday'], ['Thu', 'Thursday'], ['Fri', 'Friday'], ['Sat', 'Saturday']]) {
    const day = element('th', '', short);
    day.scope = 'col';
    day.setAttribute('abbr', full);
    weekdays.append(day);
  }
  thead.append(weekdays);
  const body = element('tbody');
  table.append(caption, thead, body);
  const legend = element('p', 'calendar-legend', 'Choose a highlighted day to see times.');
  monthPanel.append(header, table, legend);
  const timePanel = element('div', 'calendar-time-panel');
  root.append(monthPanel, timePanel);

  function reportDay() {
    if (selectedDate && anchor) onDayChange?.(anchor);
  }

  function drawTimes() {
    timePanel.replaceChildren();
    const selectedSlots = model.days.get(selectedDate) || [];
    if (!selectedSlots.length) {
      timePanel.append(element('p', 'calendar-empty', 'No available times this month. Try another month.'));
      return;
    }
    const label = element('p', 'calendar-time-label', 'AVAILABLE TIMES');
    const heading = element('h3', 'calendar-selected-date', calendarDateLabel(selectedDate, { weekday: 'long', month: 'long', day: 'numeric' }));
    const times = element('div', 'calendar-times');
    times.setAttribute('aria-label', `Available times for ${calendarDateLabel(selectedDate)}`);
    for (const slot of selectedSlots) {
      const formatted = formatCalendarSlot(slot, zone);
      const choice = element('button', 'calendar-time');
      choice.type = 'button';
      choice.dataset.start = slot.start;
      choice.setAttribute('aria-label', formatted.accessible);
      choice.append(element('span', 'calendar-time-range', formatted.range), element('small', 'calendar-time-zone', formatted.zone));
      choice.addEventListener('click', () => onChoose?.(slot));
      times.append(choice);
    }
    const zoneLabel = element('p', 'calendar-timezone', `All times in ${zone.replaceAll('_', ' ')}.`);
    timePanel.append(label, heading, times, zoneLabel);
  }

  function drawDays() {
    const today = dateKey(new Date(), zone);
    const monthLabel = calendarDateLabel(`${visibleMonth}-01`, { month: 'long', year: 'numeric' });
    title.textContent = monthLabel;
    caption.textContent = `Choose a day in ${monthLabel}`;
    root.dataset.month = visibleMonth;
    previous.disabled = visibleMonth <= model.firstMonth;
    next.disabled = visibleMonth >= model.lastMonth;
    body.replaceChildren();
    const cells = calendarMonthDays(visibleMonth);
    for (let row = 0; row < cells.length; row += 7) {
      const week = element('tr');
      for (const key of cells.slice(row, row + 7)) {
        const cell = element('td');
        if (key) {
          const day = element('button', 'calendar-day', String(Number(key.slice(-2))));
          day.type = 'button';
          day.dataset.date = key;
          day.disabled = !model.days.has(key);
          day.setAttribute('aria-label', `${calendarDateLabel(key)}${day.disabled ? ', no available times' : ''}`);
          day.setAttribute('aria-pressed', String(key === selectedDate));
          if (key === today) day.setAttribute('aria-current', 'date');
          day.addEventListener('click', () => {
            selectedDate = key;
            anchor = model.days.get(key)[0].start;
            for (const other of body.querySelectorAll('.calendar-day')) other.setAttribute('aria-pressed', String(other.dataset.date === key));
            drawTimes();
            reportDay();
          });
          cell.append(day);
        }
        week.append(cell);
      }
      body.append(week);
    }
  }

  function navigate(amount) {
    const month = shiftedMonth(visibleMonth, amount);
    if (month < model.firstMonth || month > model.lastMonth) return;
    visibleMonth = month;
    selectedDate = [...model.days.keys()].find(key => key.startsWith(month)) || null;
    if (selectedDate) anchor = model.days.get(selectedDate)[0].start;
    drawDays();
    drawTimes();
    reportDay();
    // Navigation controls are stable DOM nodes. If the active arrow becomes
    // unavailable at the boundary, keep keyboard focus on the opposite arrow.
    if (document.activeElement === previous && previous.disabled) next.focus();
    if (document.activeElement === next && next.disabled) previous.focus();
  }
  previous.addEventListener('click', () => navigate(-1));
  next.addEventListener('click', () => navigate(1));

  function draw() {
    if (!visibleMonth) {
      root.replaceChildren(element('p', 'calendar-empty', 'No available times right now.'));
      return;
    }
    drawDays();
    drawTimes();
    reportDay();
  }
  draw();
  return {
    element: root,
    setTimeZone(value) {
      zone = value;
      model = buildBookingCalendarModel(slots, zone, anchor);
      selectedDate = model.selectedDate;
      visibleMonth = selectedDate?.slice(0, 7) || null;
      draw();
    },
  };
}
