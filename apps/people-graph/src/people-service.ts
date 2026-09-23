import type {MailEnv} from './mail-sync';
import {refreshShares} from './share-routes';
import {normalizePushedGraph} from './relevance-routes';
export interface PeopleEnv extends MailEnv {DB:D1Database}
/** Single loader for the website and CLI: owner is authenticated by the caller. */
export async function loadPeopleNetwork(env:PeopleEnv,owner:string,source?:string){
 if(source!=='obsidian'){
  await refreshShares(env,owner);
  const graph=await env.MAIL.getByName(owner).graph();
  if(graph?.nodes?.length)return {account:owner,graph};
 }
 const row=await env.DB.prepare('SELECT json, updated_at FROM graphs WHERE email = ?').bind(owner).first<{json:string;updated_at:number}>();
 if(!row)return {account:owner,graph:null};
 let graph;try{graph=normalizePushedGraph(JSON.parse(row.json));}catch{throw Error('invalid_graph');}
 if(!graph)throw Error('invalid_graph');
 const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
 return {account:owner,updatedAt:row.updated_at,graph:await stub.augmentPushedGraph(graph,'my')};
}
