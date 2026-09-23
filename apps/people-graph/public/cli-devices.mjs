export function createCliDevices({root,request}){
 let owner=null,generation=0;
 function clear(){owner=null;generation++;root.replaceChildren();root.hidden=true;}
 async function load(){const run=++generation;root.hidden=false;const heading=document.createElement('h2');heading.textContent='Connected CLI devices';const status=document.createElement('p');status.setAttribute('role','status');status.textContent='Loading devices…';root.replaceChildren(heading,status);
  try{const data=await request('/api/cli/devices',null,'GET');if(run!==generation)return;status.textContent=data.devices.length?'Read-only access to this People network.':'Run peoplegraph login to connect your terminal.';for(const device of data.devices){const row=document.createElement('div'),name=document.createElement('p'),button=document.createElement('button');name.textContent=device.name+' · expires '+new Date(device.expiresAt*1000).toLocaleDateString();button.textContent='Revoke access';button.onclick=async()=>{button.disabled=true;try{await request('/api/cli/devices/revoke',{id:device.id});if(run===generation)await load();}catch{if(run===generation){status.textContent='Could not revoke access. Please retry.';button.disabled=false;}}};row.append(name,button);root.append(row);}}
  catch{if(run===generation)status.textContent='Could not load CLI devices. Reload to retry.';}
 }
 return {setAccount(value){if(owner!==value){clear();owner=value;if(owner)void load();}},clear};
}
