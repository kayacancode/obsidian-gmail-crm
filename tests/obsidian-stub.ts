export async function requestUrl(options: unknown):Promise<unknown> {
 const handler=(globalThis as unknown as { requestHandler?:(options:unknown)=>unknown }).requestHandler;
 if(!handler)throw new Error('Unexpected Obsidian request');
 return handler(options);
}
