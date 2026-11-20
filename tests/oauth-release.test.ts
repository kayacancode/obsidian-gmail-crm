// Obsidian supplies the browser window in Electron; the test runner supplies its timer equivalent.
Object.defineProperty(globalThis, 'window', {value: globalThis, configurable: true});
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GmailApi} from '../src/gmail-api';
import {startOAuthCallbackServer} from '../src/oauth-server';
import {DEFAULT_SETTINGS} from '../src/types';

test('Google OAuth binds the authorization URL and token exchange with PKCE',async()=>{
 const api=new GmailApi({...DEFAULT_SETTINGS},async()=>{});
 const url=new URL(api.getAuthUrl('test-state'));
 assert.equal(url.searchParams.get('state'),'test-state');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 let verifier='';
 (globalThis as any).requestHandler=async(options:any)=>{
  verifier=new URLSearchParams(options.body).get('code_verifier')!;
  return {json:{access_token:'access',refresh_token:'refresh',expires_in:3600},status:200};
 };
 try{await api.exchangeCode('code');}finally{delete (globalThis as any).requestHandler;}
 assert.equal(createHash('sha256').update(verifier).digest('base64url'),url.searchParams.get('code_challenge'));
 await assert.rejects(api.exchangeCode('again'),/Start Google sign-in/);
});
test('local callback rejects foreign state and accepts only the pending sign-in',async()=>{
 const pending=startOAuthCallbackServer('expected');
 // The listener binds asynchronously; yielding once lets it finish listening.
 await new Promise(resolve=>setImmediate(resolve));
 const invalid=await fetch('http://127.0.0.1:42813/callback?code=foreign&state=wrong');
 assert.equal(invalid.status,400);
 const valid=await fetch('http://127.0.0.1:42813/callback?code=ours&state=expected');
 assert.equal(valid.status,200);assert.equal(await pending,'ours');
});

test('overlapping Connect clicks preserve the original pending OAuth flow',async()=>{
 const {default:GmailCrmPlugin}=await import('../src/main');
 const plugin=Object.create(GmailCrmPlugin.prototype) as any;
 let state='',starts=0,exchanges=0;
 plugin.gmailApi={getAuthUrl:(value:string)=>{state=value;starts++;return 'https://accounts.google.com/';},exchangeCode:async()=>{exchanges++;}};
 plugin.startAutoSync=()=>{};plugin.syncContacts=async()=>{};
 const first=plugin.startOAuthFlow();
 await plugin.startOAuthFlow();
 await new Promise(resolve=>setImmediate(resolve));
 await fetch('http://127.0.0.1:42813/callback?code=ours&state='+state);
 await first;
 assert.equal(starts,1);assert.equal(exchanges,1);assert.equal(plugin.oauthInProgress,false);
});
