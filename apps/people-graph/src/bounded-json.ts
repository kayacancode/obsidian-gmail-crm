export async function boundedJSON(response:Response,maxBytes:number):Promise<unknown>{
 const declared=Number(response.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>maxBytes){await response.body?.cancel().catch(()=>{});throw Error('invalid_response');}
 const reader=response.body?.getReader();if(!reader)throw Error('invalid_response');
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let bytes=0,text='';
 try{
  while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>maxBytes)throw Error('invalid_response');text+=decoder.decode(chunk.value,{stream:true});}
  text+=decoder.decode();return JSON.parse(text);
 }catch{throw Error('invalid_response');}
 finally{text='';await reader.cancel().catch(()=>{});reader.releaseLock();}
}
