export type PeopleFailurePhase='lens_read'|'memory_read'|'graph_read'|'helper_context_read'|'ranking'|'lens_recheck'|'memory_recheck'|'authenticate'|'request'|'mcp'|'matches'|'lookup'|'capture'|'save'|'lens'|'context'|'memory'|'merges'|'accounts'|'draft'|'connection'|'helpers'|'search'|'feedback'|'granola'|'relevance'|'shares'|'workspaces'|'booking'|'integrations'|'devices'|'graph';
type PeopleFailureEvent='people_matches_failed'|'people_agent_failed'|'people_machine_failed';

export function peopleFailureKind(error:unknown){
 let name='';try{if(error instanceof Error&&typeof error.name==='string')name=error.name;}catch{}
 return ['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError'].includes(name)?name:'unknown';
}

/** Error text is classification input only. Never emit it, its stack, or request/source data. */
export function peopleFailureDiagnostic(event:PeopleFailureEvent,phase:PeopleFailurePhase,error:unknown,started:number){
 let message='';try{if(error instanceof Error&&typeof error.message==='string')message=error.message;}catch{}
 const kind=peopleFailureKind(error);
 const category=['owner_lens_conflict','person_context_conflict'].includes(message)?'conflict'
  :/memory limit|cpu limit|too many subrequests|resource (?:limit|exhausted)|overloaded/i.test(message)?'resource_limit'
  :kind==='AbortError'||kind==='TimeoutError'||/\btimeout\b|timed out|deadline exceeded/i.test(message)?'timeout'
  :/\bRPC\b|does not implement|not implemented|not a function/i.test(message)?'rpc'
  :/SQLITE|\bSQL\b|no such (?:table|column)/i.test(message)?'storage'
  :/serializ|\bclone(?:d)?\b/i.test(message)?'serialization':'other';
 const elapsedMs=Math.max(0,Math.min(3_600_000,Date.now()-started));
 console.warn(JSON.stringify({event,phase,kind,category,elapsedMs}));
}
