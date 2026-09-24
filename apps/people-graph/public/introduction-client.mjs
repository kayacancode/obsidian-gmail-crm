export function createIntroductionClient({workspaceId,fetcher}){
 const controller=new AbortController();let generation=0;
 async function call(suffix='',body){const run=generation;if(controller.signal.aborted)throw new DOMException('Account changed','AbortError');const data=await fetcher('/api/workspaces/'+encodeURIComponent(workspaceId)+'/intro-requests'+suffix,body,controller.signal);if(run!==generation||controller.signal.aborted)throw new DOMException('Account changed','AbortError');return data;}
 return {list:cursor=>call(cursor?'?cursor='+encodeURIComponent(cursor):''),read:id=>call('/'+encodeURIComponent(id)),create:input=>call('',input),reply:(id,input)=>call('/'+encodeURIComponent(id)+'/reply',input),destroy(){generation++;controller.abort();}};
}
