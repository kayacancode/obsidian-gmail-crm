import {canonicalThemeName, metadataThemeSignals, scoreConnectors, scoreRelevance, type GraphEdge, type GraphNode, type MetadataThemeRow, type RelevanceFeedback, type RelevanceLens, type RelevanceSnapshot, type Theme, type ThemeSignal} from './relevance-model';
import {THEME_TOPICS,THEME_MODEL,type ExtractedTheme} from './theme-extractor';
import {PUBLIC_EXTRACTOR_VERSION,publicURL,type PublicSourceState} from './public-sources';

type SignalInput = ThemeSignal & {account?:string};

export type RetrievalError='reconnect_required'|'gmail_access_denied'|'ai_unavailable'|'invalid_extraction'|'retrieval_failed';
export interface RetrievalJob {
	id:string;owner:string;accountId:string;revision:string;personId:string;themeId?:string;
	windowDays:30|90;after:number;before:number;fingerprint:string;idempotencyKey:string;
	status:'queued'|'running'|'complete'|'failed';error?:RetrievalError;dueAt:number;
	processed:number;decodedBytes:number;assertions:number;pending:string[];pageToken?:string;hasMore:boolean;seen:string[];
	generation:string;
}

export interface RelevanceFeedbackInput {
	idempotencyKey:string;
	themeId:string;
	personId?:string;
	action:RelevanceFeedback['action'];
	replacementThemeId?:string;
	expiresAt?:string;
	createdAt?:string;
}

export interface ThemeEvidence {
	theme:Theme | null;
	signals:ThemeSignal[];
}

export interface MetadataInput extends MetadataThemeRow { contentHash:string; }

type SqlRow = Record<string,string | number | ArrayBuffer | null>;

/**
 * Owner-local persistence for relevance assertions.  The Durable Object is the
 * isolation boundary; the owner column is retained as a defensive query fence.
 */
export class RelevanceStore {
	constructor(private readonly ctx:DurableObjectState, private readonly owner:()=>Promise<string|undefined>) {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS themes (
				id TEXT PRIMARY KEY, owner TEXT NOT NULL, canonical_name TEXT NOT NULL,
				aliases TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
				merged_into TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS themes_owner ON themes(owner, canonical_name);
			CREATE TABLE IF NOT EXISTS theme_signals (
				id TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT, person_id TEXT,
				theme_id TEXT NOT NULL, source_type TEXT NOT NULL, visibility TEXT NOT NULL,
				observed_at TEXT NOT NULL, ingested_at TEXT NOT NULL, confidence REAL NOT NULL,
				summary TEXT NOT NULL, evidence_ref TEXT NOT NULL, content_hash TEXT NOT NULL,
				extractor_version TEXT NOT NULL, model_id TEXT
			);
			CREATE INDEX IF NOT EXISTS theme_signals_theme_observed ON theme_signals(theme_id, observed_at);
			CREATE INDEX IF NOT EXISTS theme_signals_person_observed ON theme_signals(person_id, observed_at);
			CREATE INDEX IF NOT EXISTS theme_signals_visibility_observed ON theme_signals(visibility, observed_at);
			CREATE INDEX IF NOT EXISTS theme_signals_account ON theme_signals(owner, account);
			CREATE TABLE IF NOT EXISTS relevance_feedback (
				id TEXT PRIMARY KEY, owner TEXT NOT NULL, theme_id TEXT NOT NULL, person_id TEXT,
				action TEXT NOT NULL, replacement_theme_id TEXT, expires_at TEXT, created_at TEXT NOT NULL,
				idempotency_key TEXT NOT NULL, UNIQUE(owner, idempotency_key)
			);
			CREATE INDEX IF NOT EXISTS relevance_feedback_theme ON relevance_feedback(owner, theme_id, created_at);
			CREATE TABLE IF NOT EXISTS retrieval_jobs (
				id TEXT PRIMARY KEY, owner TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL,
				idempotency_key TEXT NOT NULL, UNIQUE(owner, idempotency_key)
			);
			CREATE INDEX IF NOT EXISTS retrieval_jobs_due ON retrieval_jobs(owner, status, due_at);
			CREATE TABLE IF NOT EXISTS retrieval_previews (
				owner TEXT NOT NULL, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL,
				PRIMARY KEY(owner, fingerprint)
			);
			CREATE TABLE IF NOT EXISTS public_sources (
				id TEXT PRIMARY KEY, owner TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL,
				updated_at TEXT NOT NULL, idempotency_key TEXT NOT NULL, UNIQUE(owner, idempotency_key)
			);
			CREATE INDEX IF NOT EXISTS public_sources_owner ON public_sources(owner, status);
			CREATE TABLE IF NOT EXISTS public_confirmations (owner TEXT NOT NULL,idempotency_key TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(owner,idempotency_key));
			CREATE TABLE IF NOT EXISTS public_revisions (owner TEXT NOT NULL,source_id TEXT NOT NULL,content_hash TEXT NOT NULL,extractor_version TEXT NOT NULL,PRIMARY KEY(owner,source_id,content_hash,extractor_version));
			CREATE TABLE IF NOT EXISTS public_signal_refs (owner TEXT NOT NULL,source_id TEXT NOT NULL,signal_id TEXT NOT NULL,PRIMARY KEY(owner,source_id,signal_id));
		`);
		if(!this.ctx.storage.sql.exec("SELECT name FROM pragma_table_info('retrieval_jobs') WHERE name='data'").toArray().length)this.ctx.storage.sql.exec('ALTER TABLE retrieval_jobs ADD COLUMN data TEXT');
		if(!this.ctx.storage.sql.exec("SELECT name FROM pragma_table_info('public_sources') WHERE name='data'").toArray().length)this.ctx.storage.sql.exec('ALTER TABLE public_sources ADD COLUMN data TEXT');
		if(!this.ctx.storage.sql.exec("SELECT name FROM pragma_table_info('public_sources') WHERE name='due_at'").toArray().length)this.ctx.storage.sql.exec('ALTER TABLE public_sources ADD COLUMN due_at INTEGER');
		this.ctx.storage.sql.exec("INSERT OR IGNORE INTO retrieval_previews (owner,fingerprint,job_id) SELECT owner,json_extract(data,'$.fingerprint'),id FROM retrieval_jobs WHERE data IS NOT NULL AND json_extract(data,'$.fingerprint') IS NOT NULL ORDER BY due_at,id");
	}

	async queuePublicSource(source:PublicSourceState,key:string):Promise<PublicSourceState>{
		const owner=await this.requiredOwner();if(source.owner!==owner)throw Error('public_source_conflict');
		return this.ctx.storage.transactionSync(()=>{
			const confirmation=this.ctx.storage.sql.exec<{source_id:string}>('SELECT source_id FROM public_confirmations WHERE owner=? AND idempotency_key=?',owner,key).toArray()[0];
			const prior=this.publicSource(owner,source.id);
			if(confirmation){if(confirmation.source_id!==source.id||!prior)throw Error('public_source_conflict');return prior;}
			if(this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM public_confirmations WHERE owner=?',owner).toArray()[0].n>=1000)throw Error('public_source_limit');
			if(!prior&&this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM public_sources WHERE owner=?',owner).toArray()[0].n>=100)throw Error('public_source_limit');
			// All fresh confirmations during one active generation coalesce into one
			// durable follow-up generation. Replays return above without adding intent.
			const value:PublicSourceState=prior?{...prior,status:prior.status==='running'?'running':'queued',pendingRefresh:prior.status==='running'?prior.pendingRefresh??source.generation:undefined,dueAt:prior.status==='running'?prior.dueAt:source.dueAt,updatedAt:source.updatedAt,error:undefined}:source;
			this.ctx.storage.sql.exec('INSERT INTO public_confirmations (owner,idempotency_key,source_id) VALUES (?,?,?)',owner,key,source.id);
			if(!prior)this.ctx.storage.sql.exec('INSERT INTO public_sources (id,owner,url,status,updated_at,idempotency_key,data,due_at) VALUES (?,?,?,?,?,?,?,?)',source.id,owner,source.canonicalUrl,'queued',source.updatedAt,source.id,JSON.stringify(publicCheckpoint(value)),value.dueAt);
			else this.savePublicSource(value);
			return value;
		});
	}

	publicSource(owner:string,id:string):PublicSourceState|null {
		const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM public_sources WHERE owner=? AND id=?',owner,id).toArray()[0];return row?.data?JSON.parse(row.data) as PublicSourceState:null;
	}
	nextPublicSource(owner:string,now:number):PublicSourceState|null {
		const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM public_sources WHERE owner=? AND status IN ('queued','running') AND due_at<=? AND data IS NOT NULL ORDER BY due_at,id LIMIT 1",owner,now).toArray()[0];return row?.data?JSON.parse(row.data) as PublicSourceState:null;
	}
	savePublicSource(source:PublicSourceState):void {
		this.ctx.storage.sql.exec('UPDATE public_sources SET status=?,updated_at=?,data=?,due_at=? WHERE owner=? AND id=?',source.status,source.updatedAt,JSON.stringify(publicCheckpoint(source)),source.dueAt,source.owner,source.id);
	}
	/** Merge the latest durable consent into completion; the active snapshot may be older. */
	finishPublicSource(source:PublicSourceState):void {
		const current=this.publicSource(source.owner,source.id);if(!current||current.generation!==source.generation)return;
		this.savePublicSource(current.pendingRefresh?{...source,status:'queued',generation:current.pendingRefresh,pendingRefresh:undefined,dueAt:Date.now()}:{...source,pendingRefresh:undefined});
	}
	cancelPublicPersonWork(owner:string,validPersonIds:Set<string>):void {
		this.ctx.storage.transactionSync(()=>{
			const rows=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM public_sources WHERE owner=? AND status IN ('queued','running') AND data IS NOT NULL",owner).toArray();
			for(const row of rows){const source=JSON.parse(row.data) as PublicSourceState;if(source.graphSource!=='obsidian'&&source.personId&&!validPersonIds.has(source.personId))this.savePublicSource({...source,status:'failed',error:'public_fetch_failed',generation:crypto.randomUUID(),pendingRefresh:undefined,updatedAt:new Date().toISOString()});}
		});
	}
	hasPublicRevision(source:PublicSourceState,hash:string):boolean {
		return !!this.ctx.storage.sql.exec('SELECT source_id FROM public_revisions WHERE owner=? AND source_id=? AND content_hash=? AND extractor_version=?',source.owner,source.id,hash,PUBLIC_EXTRACTOR_VERSION).toArray().length;
	}
	/** Persistence accepts finite topic IDs only. No source or model display strings cross this boundary. */
	commitPublicSource(source:PublicSourceState,items:ExtractedTheme[],topicNamespace:string):void {
		const current=this.publicSource(source.owner,source.id);
		if(!current||current.generation!==source.generation)return;
		if(!/^[a-zA-Z0-9_-]{43}$/.test(topicNamespace)||items.length>12)throw Error('invalid_extraction');
		const themes:Theme[]=[],signals:ThemeSignal[]=[];
		for(const item of items){
			if(!Object.hasOwn(THEME_TOPICS,item.topicId)||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1)throw Error('invalid_extraction');
			const topic=THEME_TOPICS[item.topicId],themeId=`public-theme:${topicNamespace}:${item.topicId}`,id=`public-signal:${source.id}:${source.contentHash}:${PUBLIC_EXTRACTOR_VERSION}:${item.topicId}`;
			if(signals.some(s=>s.id===id))continue;
			themes.push({id:themeId,owner:source.owner,canonicalName:canonicalThemeName(topic.name),aliases:[topic.name],description:topic.summary,status:'active',createdAt:source.updatedAt,updatedAt:source.updatedAt});
			signals.push({id,owner:source.owner,personId:source.personId,themeId,sourceType:source.sourceType==='public_feed'?'public_feed':'public_url',visibility:'public',observedAt:source.observedAt!,ingestedAt:source.retrievedAt!,confidence:item.confidence,summary:topic.summary,evidenceRef:`public-source:${source.id}`,contentHash:source.contentHash!,extractorVersion:PUBLIC_EXTRACTOR_VERSION,modelId:THEME_MODEL});
		}
		this.persist(source.owner,themes,signals,()=>{
			for(const s of signals)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO public_signal_refs (owner,source_id,signal_id) VALUES (?,?,?)',source.owner,source.id,s.id);
			if(source.contentHash)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO public_revisions (owner,source_id,content_hash,extractor_version) VALUES (?,?,?,?)',source.owner,source.id,source.contentHash,PUBLIC_EXTRACTOR_VERSION);
			source.assertions=Number(this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM public_signal_refs WHERE owner=? AND source_id=?',source.owner,source.id).toArray()[0].n);
			this.finishPublicSource(source);
		},true);
	}
	async removePublicSource(id:string):Promise<void>{
		const owner=await this.requiredOwner();
		this.ctx.storage.transactionSync(()=>{
			this.ctx.storage.sql.exec('DELETE FROM theme_signals WHERE owner=? AND id IN (SELECT signal_id FROM public_signal_refs WHERE owner=? AND source_id=?)',owner,owner,id);
			for(const table of ['public_signal_refs','public_revisions','public_confirmations'])this.ctx.storage.sql.exec(`DELETE FROM ${table} WHERE owner=? AND source_id=?`,owner,id);
			this.ctx.storage.sql.exec('DELETE FROM public_sources WHERE owner=? AND id=?',owner,id);
			this.ctx.storage.sql.exec('DELETE FROM themes WHERE owner=? AND NOT EXISTS (SELECT 1 FROM theme_signals WHERE theme_signals.owner=themes.owner AND theme_signals.theme_id=themes.id)',owner);
		});
	}

	/** Only owner-local, validated identifiers/counters belong in this checkpoint. */
	queueRetrieval(job:RetrievalJob):RetrievalJob {
		return this.ctx.storage.transactionSync(()=>{
		const prior=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM retrieval_jobs WHERE owner=? AND idempotency_key=?',job.owner,job.idempotencyKey).toArray()[0];
		if(prior){const value=JSON.parse(prior.data) as RetrievalJob;if(value.fingerprint!==job.fingerprint)throw Error('retrieval_failed');return value;}
		if(this.ctx.storage.sql.exec('SELECT job_id FROM retrieval_previews WHERE owner=? AND fingerprint=?',job.owner,job.fingerprint).toArray().length)throw Error('retrieval_failed');
		if(this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM retrieval_jobs WHERE owner=? AND status IN ('queued','running')",job.owner).toArray()[0].n>=5)throw Error('retrieval_failed');
		this.ctx.storage.sql.exec('INSERT INTO retrieval_previews (owner,fingerprint,job_id) VALUES (?,?,?)',job.owner,job.fingerprint,job.id);
		this.ctx.storage.sql.exec('INSERT INTO retrieval_jobs (id,owner,due_at,status,idempotency_key,data) VALUES (?,?,?,?,?,?)',job.id,job.owner,job.dueAt,job.status,job.idempotencyKey,JSON.stringify(job));
		return job;
		});
	}

	retrievalJob(owner:string,id:string):RetrievalJob|null {
		const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM retrieval_jobs WHERE owner=? AND id=?',owner,id).toArray()[0];
		return row?.data?JSON.parse(row.data) as RetrievalJob:null;
	}

	nextRetrieval(owner:string,now:number):RetrievalJob|null {
		const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM retrieval_jobs WHERE owner=? AND status IN ('queued','running') AND due_at<=? AND data IS NOT NULL ORDER BY due_at,id LIMIT 1",owner,now).toArray()[0];
		return row?.data?JSON.parse(row.data) as RetrievalJob:null;
	}

	saveRetrieval(job:RetrievalJob):void {
		this.ctx.storage.sql.exec('UPDATE retrieval_jobs SET status=?,due_at=?,data=? WHERE owner=? AND id=?',job.status,job.dueAt,JSON.stringify(job),job.owner,job.id);
	}

	removeRetrievalAccount(owner:string,accountId:string):void {
		this.ctx.storage.transactionSync(()=>{
		this.ctx.storage.sql.exec("DELETE FROM retrieval_previews WHERE owner=? AND job_id IN (SELECT id FROM retrieval_jobs WHERE owner=? AND json_extract(data,'$.accountId')=?)",owner,owner,accountId);
		this.ctx.storage.sql.exec("DELETE FROM retrieval_jobs WHERE owner=? AND json_extract(data,'$.accountId')=?",owner,accountId);
		});
	}

	commitRetrieval(job:RetrievalJob,themes:Theme[],signals:SignalInput[]):void {
		this.persist(job.owner,themes,signals,()=>this.saveRetrieval(job));
	}

	async ingest(signals:SignalInput[]):Promise<{themes:number;signals:number}> {
		const owner = await this.requiredOwner();
		const now = new Date().toISOString();
		const themes = new Map<string,Theme>();
		for (const signal of signals.slice(0,5_000)) {
			if (signal.owner !== owner) continue;
			if (!themes.has(signal.themeId)) themes.set(signal.themeId,defaultTheme(owner,signal.themeId,now));
		}
		return this.persist(owner,[...themes.values()],signals);
	}

	/** Converts transient subject metadata into compact, owner-opaque signals. */
	async ingestMetadata(account:string, rows:MetadataInput[], now=Date.now(), stillCurrent?:()=>boolean):Promise<{themes:number;signals:number}> {
		const owner = await this.requiredOwner();
		if (stillCurrent && !stillCurrent()) return {themes:0,signals:0};
		const compact = rows.slice(0,5_000).map(row => ({
			...row,
			// Metadata themes use a stable 2-token phrase; the original subject is
			// deliberately never persisted in theme storage.
			subject:canonicalThemeName(row.subject).split(' ').slice(0,2).join(' '),
		}));
		const derived = metadataThemeSignals(compact,owner,now);
		if (stillCurrent && !stillCurrent()) return {themes:0,signals:0};
		return this.replaceMetadata(owner,account,derived.themes,derived.signals.map(signal => ({...signal,account})));
	}

	async snapshot(lens:RelevanceLens, now=Date.now()):Promise<RelevanceSnapshot> {
		const owner = await this.requiredOwner();
		return scoreRelevance(this.signals(owner),this.feedback(owner),lens,now,this.themes(owner));
	}

	async evidence(themeId:string,lens:RelevanceLens):Promise<ThemeEvidence> {
		const owner = await this.requiredOwner();
		const snapshot = await this.snapshot(lens);
		const scored=snapshot.themes.find(theme => theme.themeId === themeId);if(!scored)return {theme:null,signals:[]};
		const visible = new Set(scored.components.map(component => component.signalId));
		return {theme:this.themes(owner).find(theme => theme.id === themeId) ?? null,signals:this.signals(owner).filter(signal => visible.has(signal.id))};
	}

	async recordFeedback(input:RelevanceFeedbackInput):Promise<RelevanceFeedback> {
		const owner = await this.requiredOwner();
		if (!input.idempotencyKey || input.idempotencyKey.length > 200 || !input.themeId || input.themeId.length > 200 || !['pin','mute','correct','expire'].includes(input.action)) throw Error('invalid_relevance_feedback');
		const prior = this.ctx.storage.sql.exec<SqlRow>('SELECT * FROM relevance_feedback WHERE owner=? AND idempotency_key=?',owner,input.idempotencyKey).toArray()[0];
		if (prior) {const value=feedbackFromRow(prior);if(value.themeId!==input.themeId||value.personId!==input.personId||value.action!==input.action||value.replacementThemeId!==input.replacementThemeId||value.expiresAt!==input.expiresAt)throw Error('invalid_relevance_feedback');return value;}
		if (input.action === 'correct' && !input.replacementThemeId) throw Error('invalid_relevance_feedback');
		const createdAt = input.createdAt && Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : new Date().toISOString();
		const value:RelevanceFeedback = {id:`feedback-${stableId(`${owner}\u0000${input.idempotencyKey}`)}`,owner,themeId:input.themeId,personId:input.personId,action:input.action,replacementThemeId:input.replacementThemeId,expiresAt:input.expiresAt,createdAt};
		this.ctx.storage.transactionSync(()=>{
			this.ctx.storage.sql.exec('INSERT INTO relevance_feedback (id,owner,theme_id,person_id,action,replacement_theme_id,expires_at,created_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)',value.id,owner,value.themeId,value.personId ?? null,value.action,value.replacementThemeId ?? null,value.expiresAt ?? null,value.createdAt,input.idempotencyKey);
		});
		return value;
	}

	async removeAccountData(account:string):Promise<void> {
		const owner = await this.owner();
		if (!owner) return;
		this.ctx.storage.transactionSync(()=>{
			this.ctx.storage.sql.exec('DELETE FROM theme_signals WHERE owner=? AND account=?',owner,account);
			this.ctx.storage.sql.exec('DELETE FROM themes WHERE owner=? AND NOT EXISTS (SELECT 1 FROM theme_signals WHERE theme_signals.owner=themes.owner AND theme_signals.theme_id=themes.id)',owner);
		});
	}

	/** The earliest queued relevance job, never an idle wake-up. */
	async nextAlarmAt(mailDue?:number,runningNotBefore?:number,publicRunningNotBefore?:number):Promise<number|undefined> {
		const owner = await this.owner();
		if (!owner) return mailDue;
		const row = this.ctx.storage.sql.exec<SqlRow>("SELECT MIN(CASE WHEN status='running' THEN MAX(due_at,?) ELSE due_at END) AS due_at FROM retrieval_jobs WHERE owner=? AND status IN ('queued','running')",runningNotBefore??0,owner).toArray()[0];
		const relevanceDue = typeof row?.due_at === 'number' ? row.due_at : undefined;
		const publicRow=this.ctx.storage.sql.exec<SqlRow>("SELECT MIN(CASE WHEN status='running' THEN MAX(due_at,?) ELSE due_at END) AS due_at FROM public_sources WHERE owner=? AND status IN ('queued','running')",publicRunningNotBefore??0,owner).toArray()[0];
		const candidates=[mailDue,relevanceDue,typeof publicRow?.due_at==='number'?publicRow.due_at:undefined].filter((value):value is number=>value!==undefined);
		return candidates.length?Math.min(...candidates):undefined;
	}

	async attachToGraph<T extends {nodes:unknown[];edges:unknown[]}>(graph:T,lens:RelevanceLens,now=Date.now()):Promise<T & {themes:Omit<Theme,'owner'>[];themeSignals:Omit<ThemeSignal,'owner'>[];relevance:RelevanceSnapshot;connectors:RelevanceSnapshot['connectors']}> {
		const owner = await this.requiredOwner();
		const relevance = await this.snapshot(lens,now);
		const nodes = graph.nodes.filter(isGraphNode);
		const edges = graph.edges.filter(isGraphEdge).map((edge,index) => ({id:`mail-${index}`,source:edge.source,target:edge.target,kind:'cooccurrence' as const}));
		const connectors = [...scoreConnectors(nodes,edges).values()].sort((a,b) => b.score-a.score || a.nodeId.localeCompare(b.nodeId));
		const themes = this.themes(owner).map(({owner:_,...theme}) => theme);
		const themeSignals = this.signals(owner).map(({owner:_,...signal}) => signal);
		return {...graph,themes,themeSignals,relevance:{...relevance,connectors},connectors};
	}

	async attachPushedGraph<T extends {nodes:unknown[];edges:unknown[];themes:Array<Omit<Theme,'owner'|'createdAt'|'updatedAt'>>;themeSignals:Array<Omit<ThemeSignal,'owner'|'modelId'>>}>(graph:T,lens:RelevanceLens,now=Date.now()):Promise<T & {relevance:RelevanceSnapshot;connectors:RelevanceSnapshot['connectors']}> {
		const owner=await this.requiredOwner(),stamp=new Date(now).toISOString();
		const nodeIds=new Set(graph.nodes.filter(isGraphNode).map(node=>node.id));
		const publicIds=this.publicSignalIds(owner,'obsidian');
		const publicSignals=this.signals(owner,true).filter(signal=>publicIds.has(signal.id)&&(!signal.personId||nodeIds.has(signal.personId)));
		const publicThemes=new Set(publicSignals.map(signal=>signal.themeId));
		const themes:Theme[]=[...graph.themes.map(theme=>({...theme,owner,createdAt:stamp,updatedAt:stamp})),...this.themes(owner,true).filter(theme=>publicThemes.has(theme.id)&&!graph.themes.some(local=>local.id===theme.id))];
		const signals:ThemeSignal[]=[...graph.themeSignals.map(signal=>({...signal,owner})),...publicSignals];
		const relevance=scoreRelevance(signals,this.feedback(owner),lens,now,themes);
		const nodes=graph.nodes.filter(isGraphNode);
		const edges=graph.edges.filter(isGraphEdge).map((edge,index)=>({id:`pushed-${index}`,source:edge.source,target:edge.target,kind:pushedEdgeKind(edge)}));
		const connectors=[...scoreConnectors(nodes,edges).values()].sort((a,b)=>b.score-a.score||a.nodeId.localeCompare(b.nodeId));
		return {...graph,themes:themes.map(({owner:_,createdAt:__,updatedAt:___,...theme})=>theme),themeSignals:signals.map(({owner:_,...signal})=>signal),relevance:{...relevance,connectors},connectors};
	}

	async pushedEvidence<T extends {nodes:unknown[];edges:unknown[];themes:Array<Omit<Theme,'owner'|'createdAt'|'updatedAt'>>;themeSignals:Array<Omit<ThemeSignal,'owner'|'modelId'>>}>(graph:T,themeId:string,lens:RelevanceLens,now=Date.now()):Promise<{theme:Omit<Theme,'owner'|'createdAt'|'updatedAt'>|null;signals:Array<Omit<ThemeSignal,'owner'|'modelId'>>}>{
		const attached=await this.attachPushedGraph(graph,lens,now),scored=attached.relevance.themes.find(theme=>theme.themeId===themeId);
		if(!scored)return {theme:null,signals:[]};
		const visible=new Set(scored.components.map(component=>component.signalId));
		return {theme:attached.themes.find(theme=>theme.id===themeId)??null,signals:attached.themeSignals.filter(signal=>visible.has(signal.id))};
	}

	private persist(owner:string,themes:Theme[],signals:SignalInput[],checkpoint?:()=>void,publicBoundary=false):{themes:number;signals:number} {
		let writtenThemes=0,writtenSignals=0;
		this.ctx.storage.transactionSync(()=>{
			for (const theme of themes.slice(0,200)) {
				if (theme.owner !== owner) continue;
				this.ctx.storage.sql.exec('INSERT INTO themes (id,owner,canonical_name,aliases,description,status,merged_into,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET aliases=excluded.aliases,description=excluded.description,status=excluded.status,merged_into=excluded.merged_into,updated_at=excluded.updated_at WHERE themes.owner=excluded.owner',theme.id,owner,theme.canonicalName,JSON.stringify(theme.aliases.slice(0,20)),cap(theme.description,240),theme.status,theme.mergedInto ?? null,theme.createdAt,theme.updatedAt);
				writtenThemes++;
			}
			for (let signal of signals.slice(0,5_000)) {
				if (signal.owner !== owner) continue;
				if(signal.sourceType==='public_url'||signal.sourceType==='public_feed'){
					if(!publicBoundary)throw Error('invalid_extraction');
					signal={...signal,visibility:'public'};
				}
				this.ctx.storage.sql.exec('INSERT INTO theme_signals (id,owner,account,person_id,theme_id,source_type,visibility,observed_at,ingested_at,confidence,summary,evidence_ref,content_hash,extractor_version,model_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',signal.id,owner,signal.account ?? null,signal.personId ?? null,signal.themeId,signal.sourceType,signal.visibility,signal.observedAt,signal.ingestedAt,Math.max(0,Math.min(1,signal.confidence)),cap(signal.summary,240),cap(signal.evidenceRef,500),signal.contentHash,signal.extractorVersion,signal.modelId ?? null);
				writtenSignals++;
			}
			checkpoint?.();
		});
		return {themes:writtenThemes,signals:writtenSignals};
	}

	private replaceMetadata(owner:string,account:string,themes:Theme[],signals:SignalInput[]):{themes:number;signals:number} {
		let writtenThemes=0,writtenSignals=0;
		this.ctx.storage.transactionSync(()=>{
			this.ctx.storage.sql.exec("DELETE FROM theme_signals WHERE owner=? AND account=? AND source_type='gmail_subject'",owner,account);
			for (const theme of themes.slice(0,200)) {
				if (theme.owner !== owner) continue;
				this.ctx.storage.sql.exec('INSERT INTO themes (id,owner,canonical_name,aliases,description,status,merged_into,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET aliases=excluded.aliases,description=excluded.description,status=excluded.status,merged_into=excluded.merged_into,updated_at=excluded.updated_at WHERE themes.owner=excluded.owner',theme.id,owner,theme.canonicalName,JSON.stringify(theme.aliases.slice(0,20)),cap(theme.description,240),theme.status,theme.mergedInto ?? null,theme.createdAt,theme.updatedAt);
				writtenThemes++;
			}
			for (const signal of signals.slice(0,5_000)) {
				if (signal.owner !== owner) continue;
				this.ctx.storage.sql.exec('INSERT INTO theme_signals (id,owner,account,person_id,theme_id,source_type,visibility,observed_at,ingested_at,confidence,summary,evidence_ref,content_hash,extractor_version,model_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',signal.id,owner,account,signal.personId ?? null,signal.themeId,signal.sourceType,signal.visibility,signal.observedAt,signal.ingestedAt,Math.max(0,Math.min(1,signal.confidence)),cap(signal.summary,240),cap(signal.evidenceRef,500),signal.contentHash,signal.extractorVersion,signal.modelId ?? null);
				writtenSignals++;
			}
			this.ctx.storage.sql.exec('DELETE FROM themes WHERE owner=? AND NOT EXISTS (SELECT 1 FROM theme_signals WHERE theme_signals.owner=themes.owner AND theme_signals.theme_id=themes.id)',owner);
		});
		return {themes:writtenThemes,signals:writtenSignals};
	}

	private publicSignalIds(owner:string,source:'obsidian'|'mail'):Set<string> {
		return new Set(this.ctx.storage.sql.exec<{signal_id:string}>("SELECT r.signal_id FROM public_signal_refs r JOIN public_sources p ON p.owner=r.owner AND p.id=r.source_id WHERE r.owner=? AND COALESCE(json_extract(p.data,'$.graphSource'),'mail')=?",owner,source).toArray().map(row=>row.signal_id));
	}
	private themes(owner:string,all=false):Theme[] {
		const rows=this.ctx.storage.sql.exec<SqlRow>('SELECT * FROM themes WHERE owner=? ORDER BY canonical_name',owner).toArray().map(themeFromRow);
		if(all)return rows;
		const localIds=this.publicSignalIds(owner,'obsidian');
		const localThemes=new Set(this.signals(owner,true).filter(signal=>localIds.has(signal.id)).map(signal=>signal.themeId));
		return rows.filter(theme=>!localThemes.has(theme.id));
	}
	private signals(owner:string,all=false):ThemeSignal[] {
		const rows=this.ctx.storage.sql.exec<SqlRow>('SELECT * FROM theme_signals WHERE owner=? ORDER BY observed_at DESC,id',owner).toArray().map(signalFromRow);
		// Resolve only persisted owner-scoped public references; never trust pushed URLs.
		const sources=new Map(this.ctx.storage.sql.exec<{signal_id:string;data:string}>("SELECT r.signal_id,p.data FROM public_signal_refs r JOIN public_sources p ON p.owner=r.owner AND p.id=r.source_id WHERE r.owner=?",owner).toArray().map(row=>[row.signal_id,JSON.parse(row.data) as PublicSourceState]));
		for(const signal of rows){
			const source=sources.get(signal.id);
			if(!source||source.owner!==owner||signal.visibility!=='public'||!['public_url','public_feed'].includes(signal.sourceType)||signal.evidenceRef!==`public-source:${source.id}`)continue;
			try{signal.provenance={canonicalUrl:publicURL(source.canonicalUrl).href,publisherHost:publicURL(`https://${source.publisherHost}`).hostname,observedAt:signal.observedAt,retrievedAt:signal.ingestedAt,timeBasis:'observed'};}catch{/* An invalid legacy source remains an opaque reference. */}
		}
		if(all)return rows;
		const localIds=this.publicSignalIds(owner,'obsidian');return rows.filter(signal=>!localIds.has(signal.id));
	}
	private feedback(owner:string):RelevanceFeedback[] { return this.ctx.storage.sql.exec<SqlRow>('SELECT * FROM relevance_feedback WHERE owner=? ORDER BY created_at,id',owner).toArray().map(feedbackFromRow); }
	private async requiredOwner():Promise<string> { const owner = await this.owner(); if (!owner) throw Error('missing_owner'); return owner; }
}

function defaultTheme(owner:string,id:string,now:string):Theme {
	const canonicalName = canonicalThemeName(id.replace(/^theme-/,'').replace(/[-_]+/g,' ')) || 'untitled';
	const name = canonicalName.split(' ').map(word => word[0].toUpperCase()+word.slice(1)).join(' ');
	return {id,owner,canonicalName,aliases:[name],description:`Theme: ${name}`,status:'active',createdAt:now,updatedAt:now};
}
function publicCheckpoint(s:PublicSourceState):PublicSourceState {
	return {id:s.id,owner:s.owner,graphSource:s.graphSource??'mail',canonicalUrl:s.canonicalUrl,publisherHost:s.publisherHost,personId:s.personId,visibility:'public',status:s.status,generation:s.generation,pendingRefresh:s.pendingRefresh,dueAt:s.dueAt,updatedAt:s.updatedAt,observedAt:s.observedAt,retrievedAt:s.retrievedAt,timeBasis:s.timeBasis,etag:s.etag,lastModified:s.lastModified,contentHash:s.contentHash,extractorVersion:PUBLIC_EXTRACTOR_VERSION,sourceType:s.sourceType,error:s.error,attempts:s.attempts,textBytes:s.textBytes,assertions:s.assertions};
}
function themeFromRow(row:SqlRow):Theme { return {id:String(row.id),owner:String(row.owner),canonicalName:String(row.canonical_name),aliases:parseAliases(row.aliases),description:String(row.description),status:row.status as Theme['status'],mergedInto:asString(row.merged_into),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}; }
function signalFromRow(row:SqlRow):ThemeSignal { return {id:String(row.id),owner:String(row.owner),personId:asString(row.person_id),themeId:String(row.theme_id),sourceType:row.source_type as ThemeSignal['sourceType'],visibility:row.visibility as ThemeSignal['visibility'],observedAt:String(row.observed_at),ingestedAt:String(row.ingested_at),confidence:Number(row.confidence),summary:String(row.summary),evidenceRef:String(row.evidence_ref),contentHash:String(row.content_hash),extractorVersion:String(row.extractor_version),modelId:asString(row.model_id)}; }
function feedbackFromRow(row:SqlRow):RelevanceFeedback { return {id:String(row.id),owner:String(row.owner),themeId:String(row.theme_id),personId:asString(row.person_id),action:row.action as RelevanceFeedback['action'],replacementThemeId:asString(row.replacement_theme_id),expiresAt:asString(row.expires_at),createdAt:String(row.created_at)}; }
function parseAliases(value:unknown):string[] { try { const aliases=JSON.parse(String(value)); return Array.isArray(aliases) ? aliases.filter((item):item is string => typeof item === 'string').slice(0,20) : []; } catch { return []; } }
function asString(value:unknown):string|undefined { return typeof value === 'string' ? value : undefined; }
function cap(value:string,length:number):string { return value.slice(0,length); }
function stableId(value:string):string { let hash=0x811c9dc5; for(let index=0;index<value.length;index++)hash=Math.imul(hash^value.charCodeAt(index),0x01000193); return (hash>>>0).toString(16).padStart(8,'0'); }
function isGraphNode(value:unknown):value is GraphNode { return !!value && typeof value === 'object' && typeof (value as {id?:unknown}).id === 'string'; }
function isGraphEdge(value:unknown):value is {source:string;target:string} { return !!value && typeof value === 'object' && typeof (value as {source?:unknown}).source === 'string' && typeof (value as {target?:unknown}).target === 'string'; }
function pushedEdgeKind(edge:{source:string;target:string}):GraphEdge['kind'] {
	const value=edge as {kind?:unknown;types?:unknown};
	const types=[value.kind,...(Array.isArray(value.types)?value.types:[])].filter((item):item is string=>typeof item==='string').map(item=>item.toLowerCase());
	if(types.some(item=>item==='interpretation'||item==='association'))return 'interpretation';
	return types.some(item=>['personal','relationship','worked_with','met','introduced','introduced_by','collaborated'].includes(item))?'personal':'cooccurrence';
}
