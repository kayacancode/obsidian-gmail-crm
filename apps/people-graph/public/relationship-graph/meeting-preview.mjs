const DAY = 86_400_000;
const key = value => value.trim().toLocaleLowerCase();
function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(field => !fields.includes(field))) throw Error('Invalid meeting preview fields.');
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('Invalid meeting preview text.');
  return value.trim();
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(value)) throw Error('Invalid meeting preview id.');
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || value.length > 40 || !Number.isFinite(Date.parse(value))) throw Error('Invalid meeting date.');
  return new Date(value).toISOString();
}
function list(value, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw Error('Meeting preview exceeds its small-batch limit.');
  return value;
}
function unique(values) { if (new Set(values).size !== values.length) throw Error('Duplicate meeting preview id.'); }

/** Import only a reviewed distillation, never raw notes or credentials. No I/O. */
export function parseMeetingBatch(input, account) {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > 100_000) throw Error('Meeting preview file is too large.');
    try { input = JSON.parse(input); } catch { throw Error('Choose a valid meeting preview JSON file.'); }
  }
  record(input, ['version','id','account','reviewedAt','notes','themes']);
  if (input.version !== 1) throw Error('Unsupported meeting preview version.');
  if (!account || key(text(input.account,254)) !== key(account)) throw Error('This preview belongs to a different account.');
  const reviewedAt = date(input.reviewedAt);
  const notes = list(input.notes,5,1).map(note => {
    record(note,['id','title','date']);
    if (typeof note.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(note.id)) throw Error('Invalid Granola meeting id.');
    const observed = date(note.date);
    if (Date.parse(observed) > Date.parse(reviewedAt)) throw Error('Meeting is newer than its review.');
    return {id:note.id,title:text(note.title,200),date:observed,url:`https://notes.granola.ai/d/${note.id}`};
  });
  unique(notes.map(note => note.id));
  const notesById = new Map(notes.map(note => [note.id,note]));
  const themes = list(input.themes,10,1).map(theme => {
    record(theme,['id','name','status','whyNow','suggestion','evidence','people']);
    if (!['active','resolved','superseded'].includes(theme.status)) throw Error('Invalid meeting suggestion status.');
    const evidence = list(theme.evidence,10,1).map(item => {
      record(item,['noteId','text','attribution']);
      const note = notesById.get(item.noteId);
      if (!note) throw Error('Evidence must reference a meeting in this batch.');
      return {...note,text:text(item.text,600),attribution:text(item.attribution,120)};
    });
    const people = list(theme.people,12).map(person => {
      record(person,['label','matchName','matchCompany','context']);
      const unmatched = person.matchName === null && person.matchCompany === null;
      return {label:text(person.label,120),matchName:unmatched ? null : text(person.matchName,120),matchCompany:unmatched ? null : text(person.matchCompany,120),context:text(person.context,300)};
    });
    return {id:id(theme.id),name:text(theme.name,100),status:theme.status,whyNow:text(theme.whyNow,600),suggestion:text(theme.suggestion,600),evidence,people};
  });
  unique(themes.map(theme=>theme.id));
  return {id:id(input.id),account:key(account),reviewedAt,notes,themes};
}

/** Derived heat is a transparent preview heuristic, not an inference of closeness. */
export function meetingPreviewState(batch, graph, feedback = {}, now = Date.now()) {
  if (!batch) return null;
  const cards = batch.themes.map(theme => {
    const vote = feedback[theme.id];
    const status = theme.status !== 'active' ? theme.status : vote?.action === 'resolve' ? 'resolved' : vote?.action === 'dismiss' ? 'dismissed' : 'active';
    const newest = Math.max(...theme.evidence.map(item=>Date.parse(item.date)));
    const age = Math.max(0,(now-newest)/DAY);
    const confirmationAge = vote?.action === 'still-relevant' ? (now-Date.parse(vote.at))/DAY : Infinity;
    const confirmed = confirmationAge >= 0 && confirmationAge < 7;
    const meetingCount = new Set(theme.evidence.map(item=>item.id)).size;
    const score = status !== 'active' ? 0 : Math.round(Math.max(confirmed ? 65 : 0,
      age <= 45 ? Math.min(80,40+meetingCount*10)*Math.pow(.5,age/14) : 0));
    const people = theme.people.map(person => {
      const matches = person.matchName && person.matchCompany ? graph.nodes.filter(node => node.type === 'person' && key(node.name) === key(person.matchName) && key(node.company || '') === key(person.matchCompany)) : [];
      const match = matches.length === 1 ? matches[0] : null;
      const allowed = match && !['denied','conflicted'].includes(match.permission) && !match.permissionConflict && match.identityStatus !== 'unresolved' && match.identityResolved !== false;
      return {...person,nodeId:allowed ? match.id : null};
    });
    return {...theme,themeId:`meeting-preview:${batch.id}:${theme.id}`,status,score,confirmed,meetingCount,people};
  });
  const signals = [], themes = [];
  for (const card of cards.filter(card=>card.score>0)) {
    const nodeIds = [...new Set(card.people.flatMap(person=>person.nodeId?[person.nodeId]:[]))];
    const components = [];
    for (const [i,evidence] of card.evidence.entries()) {
      for (const personId of nodeIds.length ? nodeIds : [null]) {
        const signalId = `${card.themeId}:${i}:${personId || 'context'}`;
        signals.push({id:signalId,themeId:card.themeId,personId,sourceType:'granola',visibility:'private',observedAt:evidence.date,ingestedAt:batch.reviewedAt,confidence:1,summary:evidence.text,evidenceRef:evidence.url,contentHash:'reviewed-preview',extractorVersion:'reviewed-meeting-preview-v1'});
        components.push({signalId,sourceType:'granola',observedAt:evidence.date,contribution:card.score/card.evidence.length});
      }
    }
    themes.push({themeId:card.themeId,name:card.name,score:card.score,reason:card.whyNow,nodeIds,components});
  }
  return {batch,cards,signals,themes};
}

/** The original network and persisted scores are never mutated. */
export function withMeetingPreview(graph, preview, lens) {
  if (!preview || lens !== 'my') return graph;
  return {...graph,
    themes:[...(graph.themes||[]),...preview.themes.map(theme=>({id:theme.themeId,name:theme.name,status:'active'}))],
    themeSignals:[...(graph.themeSignals||[]),...preview.signals],
    relevance:{...graph.relevance,themes:[...(graph.relevance?.themes||[]),...preview.themes]},
  };
}
