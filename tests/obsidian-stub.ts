export async function requestUrl(options: unknown):Promise<unknown> {
 const handler=(globalThis as unknown as { requestHandler?:(options:unknown)=>unknown }).requestHandler;
 if(!handler)throw new Error('Unexpected Obsidian request');
 return handler(options);
}
export class Plugin {}
export class ItemView {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class TFile {}
export class TFolder {}
export const normalizePath = (path:string)=>path;
