// Pure presentation helpers. Recency is activity evidence, never a claim about thoughts.
export function directContact(node) {
  if (Object.hasOwn(node, 'directLastContact')) return node.directLastContact;
  return node.via?.length ? null : node.lastContact ?? null;
}
export function inWindow(value, window, now = new Date()) {
  const at = value ? Date.parse(value) : NaN;
  if(window==='upcoming')return Number.isFinite(at)&&at>+now&&at<=+now+30*86400000;
  if (!Number.isFinite(at) || at > +now) return false;
  if (window === 'all') return true;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (window === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  else if (window === 'month') start.setDate(start.getDate() - 29);
  return at >= +start;
}
export function connectionSummary(person, nodes) {
  if (person.directRelationship === false || (person.directRelationship !== true && person.via?.length)) return null;
  if (typeof person.strength !== 'number' || !Number.isFinite(person.strength) || person.strength<0 || person.strength>100) return null;
  const peers = nodes.filter(n => n.id !== person.id && n.directRelationship !== false
    && (n.directRelationship === true || !n.via?.length) && typeof n.strength === 'number' && Number.isFinite(n.strength));
  return {score: person.strength, lower: peers.filter(n => n.strength < person.strength).length, total: peers.length};
}
export function ownSignals(signals) {
  return signals.filter(s => s.visibility === 'private' && ['granola','gmail_subject','gmail_body_derived','obsidian_note'].includes(s.sourceType)
    && !String(s.evidenceRef ?? '').startsWith('share:'));
}
export function dailyDigest(nodes, signals, now = new Date()) {
  const byPerson = new Map();
  for (const s of ownSignals(signals)) {
    if (!inWindow(s.observedAt, 'month', now)) continue;
    if (!byPerson.has(s.personId)) byPerson.set(s.personId, []);
    byPerson.get(s.personId).push(s);
  }
  return nodes.filter(n=>n.type === undefined || n.type === 'person').map(n => {
    const notes = (byPerson.get(n.id) ?? []).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
    const date = directContact(n);
    const recent = inWindow(date,'month',now);
    const reasons = [...(recent ? [`Last recorded contact · ${date.slice(0,10)}`] : []),
      ...notes.slice(0,2).map(s=>`${s.sourceType === 'granola' ? 'Meeting note' : 'Recorded context'} · ${s.summary}`)];
    const latest = Math.max(recent ? Date.parse(date) : 0,...notes.map(s=>Date.parse(s.observedAt)),0);
    return {id:n.id,name:n.name,reasons,latest};
  }).filter(n=>n.reasons.length).sort((a,b)=>b.latest-a.latest || a.id.localeCompare(b.id)).slice(0,6);
}
export function introductionCandidates(targetId,nodes,edges) {
  const byId = new Map(nodes.map(n=>[n.id,n]));
  const seen = new Set();
  return edges.filter(e=>e.source===targetId || e.target===targetId).map(edge=>({edge,person:byId.get(edge.source===targetId?edge.target:edge.source)}))
    .filter(item=>item.person && item.person.permission!=='denied' && item.person.permissionConflict!==true && item.person.identityResolved!==false
      && item.edge.kind!=='interpretation' && connectionSummary(item.person,[]) !== null)
    .sort((a,b)=>b.person.strength-a.person.strength || a.person.id.localeCompare(b.person.id))
    .filter(({person})=>{if(seen.has(person.id))return false;seen.add(person.id);return true;}).slice(0,3);
}

// Subject fragments are useful search evidence, but cannot establish a conversation topic.
export function conversationThemes(themes, signals) {
  const substantive = new Map(signals.filter(s => s.sourceType !== 'gmail_subject').map(s => [s.id,s]));
  return themes.flatMap(theme => {
    const components = theme.components.filter(c => c.sourceType !== 'gmail_subject' && substantive.has(c.signalId));
    if (!components.length) return [];
    const evidence = components.map(c => substantive.get(c.signalId)).sort((a,b)=>(Date.parse(b.observedAt)||0)-(Date.parse(a.observedAt)||0));
    const nodeIds = [...new Set(evidence.map(s=>s.personId).filter(Boolean))];
    if (!nodeIds.length) return [];
    return [{...theme,components,nodeIds,latestAt:evidence[0].observedAt,summary:evidence[0].summary || ''}];
  });
}

export function activityTimeline(graph, window, now=new Date()) {
  const ids=new Set(graph.nodes.map(n=>n.id));
  const events=(graph.activity||[]).filter(e=>inWindow(e.at,window,now)).map(e=>({...e,personIds:e.personIds.filter(id=>ids.has(id))}));
  const seen=new Set();
  for(const s of ownSignals(graph.themeSignals||[])) {
    if(!['granola','obsidian_note'].includes(s.sourceType)||!ids.has(s.personId)||!inWindow(s.observedAt,window,now))continue;
    const key=`${s.evidenceRef}|${s.personId}|${s.summary}`;
    if(seen.has(key))continue;seen.add(key);
    events.push({id:`mention:${s.id}`,kind:'mention',at:s.observedAt,personIds:[s.personId],title:s.summary,source:s.sourceType==='granola'?'Granola note mention':'Obsidian note mention'});
  }
  return events.filter(e=>e.personIds.length).sort((a,b)=>(window==='upcoming'?1:-1)*(Date.parse(a.at)-Date.parse(b.at))||a.id.localeCompare(b.id));
}

// Conservative, reviewable suggestions from permitted evidence. Never infer email
// questions from subjects, or claim that an obligation remains unresolved.
export function attentionDigest(graph, feedback={}, now=new Date()) {
  const suggestions=[];
  const signals=ownSignals(graph.themeSignals||[]).filter(s=>s.sourceType!=='gmail_subject' && inWindow(s.observedAt,'month',now));
  for(const person of graph.nodes) {
    if(person.permission==='denied'||person.identityResolved===false||person.permissionConflict)continue;
    const choice=graph.personFeedback?.[person.id];
    if(choice?.action==='suppress'||(choice?.action==='snooze'&&choice.until>+now))continue;
    const upcoming=(graph.activity||[]).filter(e=>e.kind==='calendar'&&e.status==='accepted'&&e.acceptedPersonIds?.includes(person.id)&&inWindow(e.at,'upcoming',now)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    const evidence=signals.filter(s=>s.personId===person.id).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
    const emitted=new Set();
    const add=(kind,title,reason,items)=>{
      const unique=kind+':'+(items[0]?.evidenceRef||items[0]?.id||'').split('#')[0];
      if(emitted.has(unique))return;emitted.add(unique);
      const id=JSON.stringify([person.id,kind,...items.map(s=>s.id).sort()]);
      if(choice?.action==='boost'&&items.every(s=>Date.parse(s.observedAt)<=choice.at))return;
      const state=feedback[id];
      if(state && (['done','dismiss'].includes(state.action)||(state.action==='snooze'&&state.until>+now)))return;
      suggestions.push({id,personId:person.id,name:person.name,kind,title,reason,evidence:items,latest:Math.max(...items.map(s=>Date.parse(s.observedAt)))});
    };
    if(upcoming.length){const e=upcoming[0];add('upcoming','Prepare for an upcoming event','You both accepted this calendar invitation. Attendance is not verified; review your recent context before the event.',[{id:e.id,observedAt:e.at,summary:e.title,source:'Google Calendar · accepted invitation',provenance:e.url?{canonicalUrl:e.url}:undefined}]);}
    for(const s of evidence) {
      const text=(s.summary||'').replace(/^(?:follow[ -]?up|action item|ask|promise|commitment):\s*/i,'');
      if(/\b(no follow.?up|already (sent|done|answered|resolved)|completed|resolved|cancelled|canceled|no longer|not needed)\b/i.test(text))continue;
      if(/\b(follow[ -]?up|action item|promised|committed to|will send|will share|will introduce|owe[sd]?|need to send)\b/i.test(text))
        add('follow-up','Possible follow-up','This source records a follow-up or commitment. Check whether it is still open; ownership and completion are not verified.',[s]);
      else if(/\?|\b(asked (you|me|us)|awaiting (an? )?(answer|reply|response)|unanswered question)\b/i.test(text))
        add('question','Possible question to revisit','A question appears in recorded content. This does not establish that it was directed to you or remains unanswered.',[s]);
    }
    const distinct=new Map();
    for(const s of evidence.filter(s=>['granola','obsidian_note'].includes(s.sourceType))){const ref=String(s.evidenceRef||s.id).split('#')[0];if(!distinct.has(ref))distinct.set(ref,s);}
    if(distinct.size>=2)add('recurring','Recurring in your notes',`Mentioned in ${distinct.size} distinct notes in the last 30 days. A mention does not imply you met or emailed.`,[...distinct.values()].slice(0,6));
    const days=[...new Set((graph.activity||[]).filter(e=>e.personIds.includes(person.id)&&['email','meeting'].includes(e.kind)&&Date.parse(e.at)<=+now).map(e=>e.at.slice(0,10)))].sort();
    if(days.length>=5&&!upcoming.length){const gaps=days.slice(1).map((d,i)=>(Date.parse(d)-Date.parse(days[i]))/86400000).sort((a,b)=>a-b);const usual=gaps[Math.floor(gaps.length/2)];const elapsed=(+now-Date.parse(days.at(-1)))/86400000;
      if(elapsed>=Math.max(14,usual*2)&&elapsed<=180) {
        const latest=(graph.activity||[]).filter(e=>e.personIds.includes(person.id)&&e.at.startsWith(days.at(-1))).slice(0,1).map(e=>({id:e.id,summary:e.title,observedAt:e.at,sourceType:e.kind,source:e.source}));
        add('reconnect','Consider reconnecting',`${Math.floor(elapsed)} days since recorded contact; the median gap in available history is ${Math.round(usual)} days. History may be incomplete.`,latest);
      }
    }
  }
  const priority={upcoming:-1,'follow-up':0,question:1,recurring:2,reconnect:3};
  return suggestions.sort((a,b)=>priority[a.kind]-priority[b.kind]||b.latest-a.latest).slice(0,24);
}

export function recentlyInTouch(graph) {
  return graph.nodes.filter(n=>directContact(n)).map(n=>{
    const events=(graph.activity||[]).filter(e=>e.personIds.includes(n.id)&&['email','meeting'].includes(e.kind)).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    return {...n,event:events[0],latest:Date.parse(directContact(n))};
  }).filter(n=>Number.isFinite(n.latest)&&n.latest<=Date.now()).sort((a,b)=>b.latest-a.latest).slice(0,12);
}
