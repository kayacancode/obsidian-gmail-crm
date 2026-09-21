export type RelevanceLens = 'my' | 'firm' | 'public';
export type SignalVisibility = 'private' | 'firm' | 'public';
export type SignalSourceType = 'gmail_subject' | 'gmail_body_derived' | 'calendar' | 'granola' | 'obsidian_note' | 'product_activity' | 'public_url' | 'public_feed';

export interface Theme {
	id:string; owner:string; canonicalName:string; aliases:string[]; description:string;
	status:'active'|'muted'|'merged'; mergedInto?:string; createdAt:string; updatedAt:string;
}
export interface ThemeSignal {
	id:string; owner:string; personId?:string; themeId:string; sourceType:SignalSourceType;
	visibility:SignalVisibility; observedAt:string; ingestedAt:string; confidence:number;
	summary:string; evidenceRef:string; contentHash:string; extractorVersion:string; modelId?:string;
	provenance?:{canonicalUrl:string;publisherHost:string;observedAt:string;retrievedAt:string;timeBasis:'observed';title?:string};
}
export interface RelevanceFeedback {
	id:string; owner:string; themeId:string; personId?:string; action:'pin'|'mute'|'correct'|'expire';
	replacementThemeId?:string; expiresAt?:string; createdAt:string;
}
export interface RelevanceSnapshot {
	version:1; lens:RelevanceLens; calculatedAt:string; scoreVersion:'relevance-v1';
	themes:Array<{themeId:string; name:string; score:number; reason:string; nodeIds:string[]; nodeScores?:Record<string,number>; components:Array<{signalId:string; sourceType:SignalSourceType; observedAt:string; contribution:number}>}>;
	connectors:Array<{nodeId:string; score:number; evidenceClass:'documented'|'inferred'; documentedDegree:number; inferredDegree:number; sampledPathCount:number}>;
	discoveries:Array<{nodeId:string; score:number; reason:string; themeIds:string[]; pathNodeIds:string[]; freshness:string; relationshipUncertainty:string}>;
}

export interface MetadataThemeRow { personId:string; subject:string; observedAt:string; contentHash?:string; }
export interface GraphNode {
	id:string; name?:string; visibility?:SignalVisibility; permission?:'allowed'|'conflicted'|'denied'|string;
	permissionConflict?:boolean; identityStatus?:'resolved'|'unresolved'|string; identityResolved?:boolean;
	lastContactAt?:string; observedAt?:string; updatedAt?:string;
}
export interface GraphEdge { id:string; source:string; target:string; kind:'personal'|'cooccurrence'|'interpretation'|string; observedAt?:string; }
export interface ConnectorScore { nodeId:string; score:number; evidenceClass:'documented'|'inferred'; documentedDegree:number; inferredDegree:number; sampledPathCount:number; }

const CONFIG: Record<SignalSourceType,{weight:number;halfLifeDays:number}> = Object.freeze({
	product_activity:{weight:1.20,halfLifeDays:7}, calendar:{weight:1.00,halfLifeDays:30},
	granola:{weight:.95,halfLifeDays:45}, obsidian_note:{weight:.95,halfLifeDays:45},
	gmail_body_derived:{weight:.90,halfLifeDays:30}, gmail_subject:{weight:.45,halfLifeDays:14},
	public_url:{weight:.60,halfLifeDays:21}, public_feed:{weight:.60,halfLifeDays:21},
});
const STOPWORDS = new Set(['a','an','and','are','as','at','be','by','for','from','in','is','it','of','on','or','re','fw','fwd','the','to','with']);
const DAY = 86_400_000;

/** A punctuation- and accent-insensitive form suitable for stable theme keys. */
export function canonicalThemeName(value:string):string {
	return value.normalize('NFKD').replace(/\p{Mark}/gu, '').toLocaleLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim().split(/\s+/)
		.filter(token => token && !STOPWORDS.has(token)).join(' ');
}

export function contribution(signal:ThemeSignal, now:number):number {
	const config = CONFIG[signal.sourceType];
	const parsed = Date.parse(signal.observedAt);
	const ageDays = Math.max(0, now - (Number.isFinite(parsed) ? parsed : now)) / DAY;
	return config.weight * signal.confidence * Math.exp(-ageDays / config.halfLifeDays);
}

/** Derives private, repeat-observed subject themes without retaining message content. */
export function metadataThemeSignals(rows:MetadataThemeRow[], owner:string, now:number):{themes:Theme[];signals:ThemeSignal[]} {
	const grouped = new Map<string,MetadataThemeRow[]>();
	for (const row of rows.slice(0, 5_000)) {
		const tokens = canonicalThemeName(row.subject).split(' ').filter(Boolean).slice(0, 4);
		if (tokens.length < 2) continue;
		const canonical = tokens.join(' ');
		const bucket = grouped.get(canonical) ?? [];
		bucket.push(row); grouped.set(canonical,bucket);
	}
	const eligible = [...grouped.entries()].filter(([,occurrences]) => occurrences.length >= 2)
		.sort(([a,aa],[b,bb]) => bb.length-aa.length || a.localeCompare(b)).slice(0,200);
	const calculatedAt = new Date(now).toISOString();
	const themes:Theme[] = [], signals:ThemeSignal[] = [];
	for (const [canonical, occurrences] of eligible) {
		const id = `theme-${stableId(`${owner}\u0000${canonical}`)}`;
		const name = humanize(canonical);
		themes.push({id,owner,canonicalName:canonical,aliases:[name].slice(0,20),description:cap(`Subject metadata theme: ${name}`,240),status:'active',createdAt:calculatedAt,updatedAt:calculatedAt});
		for (const row of occurrences) {
			if (signals.length >= 5_000) break;
			const hash = row.contentHash ?? stableId(`${owner}\u0000${row.personId}\u0000${row.subject}\u0000${row.observedAt}`);
			signals.push({id:`signal-${stableId(`${owner}\u0000${canonical}\u0000${row.personId}\u0000${row.observedAt}\u0000${hash}`)}`,owner,personId:row.personId,themeId:id,sourceType:'gmail_subject',visibility:'private',observedAt:row.observedAt,ingestedAt:calculatedAt,confidence:1,summary:cap(`Subject metadata matched ${name}`,240),evidenceRef:cap(`metadata:${hash}`,500),contentHash:hash,extractorVersion:'metadata-v1'});
		}
	}
	return {themes,signals};
}

export function scoreRelevance(signals:ThemeSignal[], feedback:RelevanceFeedback[], lens:RelevanceLens, now:number, themes:Theme[]=[]):RelevanceSnapshot {
	const activeFeedback = feedback.filter(item => !item.expiresAt || Date.parse(item.expiresAt) > now)
		.slice().sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	const corrections = new Map<string,string>();
	const muted = new Set<string>(), pinned = new Set<string>(), expired = new Set<string>();
	for (const item of activeFeedback) {
		const key=feedbackKey(item.themeId,item.personId);
		if (item.action === 'correct' && item.replacementThemeId) corrections.set(key,item.replacementThemeId);
		if (item.action === 'mute') muted.add(key);
		if (item.action === 'pin') pinned.add(key);
		if (item.action === 'expire') expired.add(key);
	}
	const lookup = new Map(themes.map(theme => [theme.id,theme]));
	const groups = new Map<string,ThemeSignal[]>();
	for (const source of signals.slice(0,5_000)) {
		if (!permitted(source.visibility,lens,source.evidenceRef)) continue;
		const themeId = resolveCorrection(source.themeId,corrections,source.personId);
		const theme = lookup.get(themeId);
		if (theme && theme.status !== 'active') continue;
		if ([themeId,source.themeId].some(id=>hasFeedback(muted,id,source.personId)||hasFeedback(expired,id,source.personId))) continue;
		const bucket = groups.get(themeId) ?? [];
		bucket.push(source); groups.set(themeId,bucket);
	}
	const raw = [...groups.entries()].map(([themeId,items]) => ({themeId,items,value:items.reduce((total,item) => total + contribution(item,now),0)}));
	const max = Math.max(0,...raw.map(item => item.value));
	const scored = raw.map(({themeId,items,value}) => {
		const display = lookup.get(themeId);
		const score = Math.min(100,Math.max(hasFeedback(pinned,themeId) ? 65 : 0,max ? value / max * 100 : 0));
		const nodeIds=[...new Set(items.flatMap(item=>item.personId?[item.personId]:[]))].sort();
		const nodeScores=Object.fromEntries(nodeIds.map(id=>[id,Math.max(score,items.some(item=>item.personId===id&&(hasFeedback(pinned,themeId,id)||hasFeedback(pinned,item.themeId,id)))?65:0)]));
		const components = items.map(item => ({signalId:item.id,sourceType:item.sourceType,observedAt:item.observedAt,contribution:contribution(item,now)}))
			.sort((a,b) => b.contribution-a.contribution || a.signalId.localeCompare(b.signalId));
		return {themeId,name:display ? humanize(display.canonicalName) : humanizeThemeId(themeId),score,reason:reasonFor(components),nodeIds,nodeScores,components};
	}).sort((a,b) => b.score-a.score || a.themeId.localeCompare(b.themeId)).slice(0,200);
	return {version:1,lens,calculatedAt:new Date(now).toISOString(),scoreVersion:'relevance-v1',themes:scored,connectors:[],discoveries:[]};
}

/** Scores graph bridging without promoting inferred co-occurrence to a documented relationship. */
export function scoreConnectors(nodes:GraphNode[], edges:GraphEdge[]):Map<string,ConnectorScore> {
	const ids = [...new Set(nodes.map(node => node.id))].sort();
	const valid = new Set(ids), documented = new Map<string,Set<string>>(), inferred = new Map<string,Set<string>>(), graph = new Map<string,Set<string>>();
	for (const id of ids) { documented.set(id,new Set()); inferred.set(id,new Set()); graph.set(id,new Set()); }
	for (const edge of edges) {
		if (!valid.has(edge.source) || !valid.has(edge.target) || edge.source === edge.target) continue;
		const target = edge.kind === 'personal' ? documented : inferred;
		target.get(edge.source)?.add(edge.target); target.get(edge.target)?.add(edge.source);
		graph.get(edge.source)?.add(edge.target); graph.get(edge.target)?.add(edge.source);
	}
	const paths = sampledParticipation(ids,graph);
	const result = new Map<string,ConnectorScore>();
	for (const id of ids) {
		const documentedDegree = documented.get(id)?.size ?? 0, inferredDegree = inferred.get(id)?.size ?? 0;
		if (!documentedDegree && !inferredDegree) continue;
		const sampledPathCount = paths.get(id) ?? 0;
		result.set(id,{nodeId:id,score:documentedDegree*30 + inferredDegree*8 + sampledPathCount*2,evidenceClass:documentedDegree ? 'documented':'inferred',documentedDegree,inferredDegree,sampledPathCount});
	}
	return result;
}

export function rankSerendipity(input:{nodes:GraphNode[];edges:GraphEdge[];relevance:Pick<RelevanceSnapshot,'themes'|'connectors'>;selectedNodeIds:string[];mutedNodeIds:string[];lens?:RelevanceLens;now?:number}):RelevanceSnapshot['discoveries'] {
	const nodes = new Map(input.nodes.map(node => [node.id,node]));
	const selected = new Set(input.selectedNodeIds), muted = new Set(input.mutedNodeIds);
	const lens = input.lens ?? 'my', now = input.now ?? relevanceCalculationTime(input.relevance);
	const trusted = (node:GraphNode | undefined) => !!node && !muted.has(node.id) && !blocked(node) && permittedNode(node,lens);
	const paths = documentedPaths([...selected].filter(id => trusted(nodes.get(id))).sort(),input.edges,nodes,trusted);
	const connectorById = new Map(input.relevance.connectors.map(connector => [connector.nodeId,connector]));
	const results:RelevanceSnapshot['discoveries'] = [];
	for (const [nodeId,path] of paths) {
		const node = nodes.get(nodeId);
		if (!node || selected.has(nodeId) || !trusted(node)) continue;
		const activeThemes = input.relevance.themes.filter(theme => theme.nodeIds.includes(nodeId) && theme.score > 0);
		if (!activeThemes.length) continue;
		const themeScore = Math.max(...activeThemes.map(theme => theme.nodeScores?.[nodeId] ?? theme.score));
		const bridgeScore = path.slice(1,-1).reduce((total,id) => total + (connectorById.get(id)?.evidenceClass === 'documented' ? 12 : 0),0);
		const freshness = freshnessFor(node,input.edges,nodeId,now);
		const freshnessScore = freshness === 'recent' ? 10 : freshness === 'aging' ? 5 : 0;
		const diversityScore = path.length === 4 ? 18 : 6;
		const score = themeScore + bridgeScore + freshnessScore + diversityScore;
		const theme = activeThemes.sort((a,b) => b.score-a.score || a.themeId.localeCompare(b.themeId))[0];
		results.push({nodeId,score,reason:`${theme.name} via documented bridge`,themeIds:activeThemes.map(item => item.themeId).sort(),pathNodeIds:path,freshness,relationshipUncertainty:'documented'});
	}
	return results.sort((a,b) => b.score-a.score || a.nodeId.localeCompare(b.nodeId)).slice(0,5);
}

/**
 * Evidence another owner shared lands as `firm` under a `share:<owner>` evidence ref. `firm` is
 * the only lens it belongs in: `my` is this owner's own mind, and a superset visibility rule
 * would quietly mix somebody else's notes into it, which is the opposite of what the sharing
 * copy promises. Public stays excluded by the visibility rule itself.
 */
const SHARED_EVIDENCE_REF='share:';
function permitted(visibility:SignalVisibility,lens:RelevanceLens,evidenceRef?:string):boolean {
	if (lens === 'my' && evidenceRef?.startsWith(SHARED_EVIDENCE_REF)) return false;
	return lens === 'my' || visibility === lens;
}
function permittedNode(node:GraphNode,lens:RelevanceLens):boolean { return node.visibility ? permitted(node.visibility,lens) : lens === 'my'; }
function relevanceCalculationTime(relevance:Pick<RelevanceSnapshot,'themes'|'connectors'>):number { const observed = relevance.themes.flatMap(theme => theme.components.map(component => Date.parse(component.observedAt))).filter(Number.isFinite); return observed.length ? Math.max(...observed) : 0; }
function feedbackKey(themeId:string,personId?:string):string {return JSON.stringify([themeId,personId??null]);}
function hasFeedback(values:Set<string>,themeId:string,personId?:string):boolean {return values.has(feedbackKey(themeId))||values.has(feedbackKey(themeId,personId));}
function resolveCorrection(themeId:string, corrections:Map<string,string>,personId?:string):string {
	const seen=new Set<string>();
	while(!seen.has(themeId)) {seen.add(themeId);const next=corrections.get(feedbackKey(themeId,personId))??corrections.get(feedbackKey(themeId));if(!next)break;themeId=next;}
	return themeId;
}
function humanize(value:string):string { return value.split(/\s+/).filter(Boolean).map(word => word[0].toLocaleUpperCase()+word.slice(1)).join(' '); }
function humanizeThemeId(id:string):string { return humanize(id.replace(/^theme-/, '').replace(/[-_]+/g,' ')); }
function cap(value:string,length:number):string { return value.slice(0,length); }
function stableId(value:string):string { let hash = 0x811c9dc5; for (let i=0;i<value.length;i++) hash = Math.imul(hash ^ value.charCodeAt(i),0x01000193); return (hash >>> 0).toString(16).padStart(8,'0'); }
function reasonFor(components:Array<{sourceType:SignalSourceType}>):string { const first = components[0]; return first ? `${humanize(first.sourceType.replace(/_/g,' '))} evidence` : 'No evidence'; }

function sampledParticipation(ids:string[], graph:Map<string,Set<string>>):Map<string,number> {
	const samples = ids.length <= 64 ? ids : Array.from({length:64},(_,index) => ids[Math.floor(index*(ids.length-1)/63)]);
	const participation = new Map(ids.map(id => [id,0]));
	for (const source of samples) {
		const stack:string[] = [], predecessors = new Map(ids.map(id => [id,[] as string[]]));
		const paths = new Map(ids.map(id => [id,0])), distance = new Map(ids.map(id => [id,-1]));
		paths.set(source,1); distance.set(source,0); const queue=[source];
		for (let index=0;index<queue.length;index++) { const vertex=queue[index]; stack.push(vertex); for (const next of [...(graph.get(vertex) ?? [])].sort()) { if (distance.get(next) === -1) { distance.set(next,(distance.get(vertex) ?? 0)+1); queue.push(next); } if (distance.get(next) === (distance.get(vertex) ?? 0)+1) { paths.set(next,(paths.get(next) ?? 0)+(paths.get(vertex) ?? 0)); predecessors.get(next)?.push(vertex); } } }
		const dependency = new Map(ids.map(id => [id,0]));
		for (let index=stack.length-1;index>=0;index--) { const vertex=stack[index]; for (const predecessor of predecessors.get(vertex) ?? []) dependency.set(predecessor,(dependency.get(predecessor) ?? 0)+(paths.get(predecessor) ?? 0)/(paths.get(vertex) ?? 1)*(1+(dependency.get(vertex) ?? 0))); if (vertex !== source) participation.set(vertex,(participation.get(vertex) ?? 0)+(dependency.get(vertex) ?? 0)); }
	}
	return new Map([...participation].map(([id,count]) => [id,Math.round(count)]));
}

function documentedPaths(selected:string[], edges:GraphEdge[], nodes:Map<string,GraphNode>, trusted:(node:GraphNode | undefined)=>boolean):Map<string,string[]> {
	const adjacency = new Map<string,string[]>();
	for (const [id,node] of nodes) if (trusted(node)) adjacency.set(id,[]);
	for (const edge of edges) if (edge.kind === 'personal' && trusted(nodes.get(edge.source)) && trusted(nodes.get(edge.target))) { adjacency.get(edge.source)?.push(edge.target); adjacency.get(edge.target)?.push(edge.source); }
	for (const list of adjacency.values()) list.sort();
	const output = new Map<string,string[]>(), queue = selected.filter(id => nodes.has(id)).map(id => ({id,path:[id]})), seen = new Set(queue.map(item => item.id));
	for (let index=0;index<queue.length;index++) { const current=queue[index]; if (current.path.length > 4) continue; if (current.path.length >= 3) output.set(current.id,current.path); if (current.path.length === 4) continue; for (const next of adjacency.get(current.id) ?? []) if (!seen.has(next)) { seen.add(next); queue.push({id:next,path:[...current.path,next]}); } }
	return output;
}
function blocked(node:GraphNode):boolean { return node.permissionConflict === true || node.permission === 'conflicted' || node.permission === 'denied' || node.identityStatus === 'unresolved' || node.identityResolved === false; }
function freshnessFor(node:GraphNode,edges:GraphEdge[],nodeId:string,now:number):string { const dates=[node.lastContactAt,node.observedAt,node.updatedAt,...edges.filter(edge => edge.source===nodeId || edge.target===nodeId).map(edge => edge.observedAt)].map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite); if (!dates.length) return 'unknown'; const age=(now-Math.max(...dates))/DAY; return age <= 30 ? 'recent' : age <= 90 ? 'aging' : 'stale'; }
