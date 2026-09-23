// Fictional people and deterministic example relationships. Never real user data.
const groups=[['Studio','Design systems','Amara Chen','Theo Park','Nina Brooks','Luca Reed','Zoe Bell','Iris Lane','Eli Ross','Maya Stone','Leo Hart','Sana Ray'],['Frontier','AI agents','Kai Morgan','Ada Flores','Noah Kim','Eva Cole','Omar Lin','Mila Cruz','Ben Gray','Aria West','Sam Fox','Jules King'],['Canopy','Climate tech','Rae Ellis','Finn Wood','Lena Moss','Max Vale','Asha Green','Ian Bloom','Joy Lake','Remy Dawn','Tara Sun','Alex Pine'],['Common Ground','Community','Esme Hall','Jude Banks','Mina Wells','Ari Scott','Bea Miles','Dev Young','Sol James','Kit Davis','Liv Hunt','Jay Moore'],['Seed House','Fundraising','Ren Blake','Alma Ford','Nico Page','Imani Shaw','Otis Lane','Cleo Nash','Dara Kent','Ash Quinn','Wren Lee','Rory Moss']];
export function demo() {
 const nodes=groups.flatMap(([company,topic,...names],g)=>names.map((name,i)=>({id:`${g}-${i}`,name,company,strength:20+(g*17+i*11)%80,lastContact:new Date(Date.now()-(i===0?8:(g*27+i*19)%260)*86400000).toISOString().slice(0,10)})));
 const edges=[];
 groups.forEach(([company,topic,...names],g)=>names.forEach((_,i)=>{
  if(i) edges.push({source:`${g}-0`,target:`${g}-${i}`,weight:1+i%4,types:[i%3===0?'introduced':'shared_meeting'],contexts:[`${topic}: ${i%3===0?'a warm introduction':'working session'}`]});
  if(i>1) edges.push({source:`${g}-${i-1}`,target:`${g}-${i}`,weight:1,types:['mentioned'],contexts:[`${topic} discussion notes`]});
 }));
 for(let g=0;g<5;g++) for(let j=g+1;j<5;j++) edges.push({source:`${g}-0`,target:`${j}-0`,weight:3,types:['introduced'],contexts:[`${groups[g][1]} × ${groups[j][1]}: founder introduction`]});
 return {nodes,edges,pushedAt:new Date().toISOString()};
}
