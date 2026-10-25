import {extractEmailIntroductions} from './email-introduction';
import type {GmailMessage} from './mail-model';

export interface StoredIntroduction {
 account:string; scope:string; messageId:string; threadId:string;
 participants:[{email:string;name:string},{email:string;name:string}];
 introducer:{email:string;name:string}; observedAt:string; subject:string;
}
/** Source metadata only. Full introduction quotations never enter graph projections. */
export class EmailIntroductionStore {
 constructor(private storage:DurableObjectStorage){storage.sql.exec('CREATE TABLE IF NOT EXISTS email_introductions (account TEXT NOT NULL,message TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account,message))');}
 clear(){this.storage.sql.exec('DELETE FROM email_introductions');}
 record(message:GmailMessage,account:string,scope:string,targetEmails:string[]){
  const evidence=extractEmailIntroductions(message).find(item=>item.participants.some(p=>targetEmails.includes(p.email)));
  if(!evidence)return;
  const {quote:_,...metadata}=evidence;
  this.storage.sql.exec('INSERT OR REPLACE INTO email_introductions VALUES (?,?,?)',account,message.id!,JSON.stringify({...metadata,account,scope}));
 }
 records(scopes:Map<string,string>):StoredIntroduction[]{
  return this.storage.sql.exec<{data:string}>('SELECT data FROM email_introductions ORDER BY account,message LIMIT 5000').toArray().map(row=>JSON.parse(row.data) as StoredIntroduction).filter(row=>scopes.get(row.account)===row.scope);
 }
}
