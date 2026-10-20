/** Support responses from an older MailSync instance during a mixed-version rollout. */
export function repairLegacyGmailContext<T extends {nodes:Array<{id:string}>;themes:any[];themeSignals:any[];relevance?:any}>(graph:T):T{
 if(!Array.isArray(graph.themes)||!Array.isArray(graph.themeSignals))return graph;
 const id='gmail-conversation-context';
 if(graph.themes.some(t=>t.id===id)||!graph.themeSignals.some(s=>s.themeId===id&&s.evidenceRef?.startsWith('gmail-context:')&&s.sourceType==='gmail_body_derived'))return graph;
 const themes=[{id,canonicalName:'Gmail conversation context',aliases:[],description:'Private work context from recent incoming emails',status:'active'},...graph.themes].slice(0,200);
 const themeIds=new Set(themes.map(t=>t.id)),nodeIds=new Set(graph.nodes.map(n=>n.id));
 const themeSignals=graph.themeSignals.filter(s=>themeIds.has(s.themeId)&&(!s.personId||nodeIds.has(s.personId))).slice(0,5000).map(s=>s.themeId===id?{...s,summary:s.summary.slice(0,240)}:s);
 const signalIds=new Set(themeSignals.map(s=>s.id));
 // A ranking explanation must not reference evidence omitted by the response cap.
 const relevance=graph.relevance?{...graph.relevance,themes:graph.relevance.themes.filter((t:any)=>themeIds.has(t.themeId)&&t.components.every((c:any)=>signalIds.has(c.signalId)))}:undefined;
 return {...graph,themes,themeSignals,...(relevance?{relevance}:{})};
}
