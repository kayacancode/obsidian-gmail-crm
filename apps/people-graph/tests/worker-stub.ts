export class DurableObject<E>{ctx:any;env:E;constructor(ctx:any,env:E){this.ctx=ctx;this.env=env;}}
export class FakeAI {
 calls:{model:string;input:any}[]=[];
 constructor(public response:unknown={response:{themes:[{topicId:'agent_memory',confidence:0.8}]}}){}
 async run(model:string,input:any){this.calls.push({model,input});if(this.response instanceof Error)throw this.response;return this.response;}
}
