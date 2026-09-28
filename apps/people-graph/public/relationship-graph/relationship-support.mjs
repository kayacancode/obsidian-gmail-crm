export const scoreBacked=r=>r.evidenceCategory==='score'&&Number.isFinite(r.score)&&r.score>0;
export const supportsIntroduction=r=>Boolean(r.confirmedAt||scoreBacked(r)||(['email','meeting'].includes(r.evidenceCategory)&&!(r.activity&&(!r.activity.sent||!r.activity.received)&&!r.activity.meetings)));
