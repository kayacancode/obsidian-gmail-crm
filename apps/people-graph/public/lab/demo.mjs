export function demo(){
 const names=['Ada Mercer','Noah Kim','Maya Flores','Eli Bennett','Zoe Okafor','Theo Park','Nina Shah','Leo Moreau','Iris Chen','Max Rivera','Lena Brooks','Omar Reed','Aria Singh','Finn Cole','Milo Stone','Eva Santos','Jude Wells','Ava Laurent','Remy Lin','Kai Ellis','Isla Ford','Luca Gray','Sana Moore','Alex Quinn','June Patel','Otto Lane','Alma Fox','Ezra Bell','Tess Wu','Ravi James','Cleo West','Hugo Cruz','Esme Hart','Ben Moss','Yara Moon','Sam Blake','Rosa Dale','Ian Vega','Nora Lake','Sol Avery','Wren King','Ari Scott','Mae Young','Louis Vale','Dara Woods','Kit Green','Anya Ross','Jay Snow'];
 const companies=['Fieldwork AI','Common Ground','Northstar Studio','Open Current','Human Systems','Orbit Research'];
 const subjects=['Context engineering workshop','Community systems roundtable','Design research collaboration','Climate technology conversation','Creative tooling session','Open models discussion'];
 const nodes=names.map((name,i)=>({id:'demo-'+i,name,company:companies[i%6],role:['Researcher','Founder','Designer','Engineer'][i%4],strength:15+(i*29)%85,lastContact:new Date(Date.UTC(2026,8,9)-((i*17)%340)*86400000).toISOString()}));
 const edges=[];for(let i=0;i<nodes.length;i++)for(const delta of [6,13]){const j=(i+delta)%nodes.length;edges.push({source:nodes[i].id,target:nodes[j].id,weight:1+i%5,types:['shared_context'],contexts:[subjects[i%6]]});}
 return {nodes,edges,source:'demo',pushedAt:'2026-09-09',note:'Fictional people and relationships created for visual exploration.'};
}
