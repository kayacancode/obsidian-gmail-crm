// Assemble real, private UI captures using the requested proving-it-works tool.
// Usage: node docs/verification/build-evidence.mjs ARTIFACT_DIR /path/to/bin/movie
import {access,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const [artifactDir,movie]=process.argv.slice(2);
if(!artifactDir||!movie)throw Error('Provide the private artifact directory and proving-it-works movie launcher.');
const root=resolve(artifactDir),window=join(root,'window');
const beats=[
 ['full-sync-running','A real full Gmail re-sync','sync-progress.png'],
 ['full-sync-complete','Full sync completed','sync-complete.png'],
 ['shared-network','Betaworks shared graph inside Obsidian','shared.png'],
 ['personal-return','Switch back to the personal network','personal-return.png'],
 ['shared-return','Switch back to Betaworks and refresh','shared-return.png'],
];
const scenes=[];
for(const [id,label,file] of beats){
 const image=join(window,file);await access(image);
 scenes.push({id:id+'-title',card:label,duration:2},{id,image,duration:4});
}
const sceneFile=join(root,'scenes.json'),output=join(root,'gmail-crm-live-verification.mp4');
await writeFile(sceneFile,JSON.stringify({size:'1440x1080',fps:10,scenes},null,2));
const built=spawnSync(resolve(movie),['build',sceneFile,output],{stdio:'inherit'});
if(built.status!==0)process.exit(built.status??1);
const checked=spawnSync(resolve(movie),['check',output,'--no-expect-audio','--no-expect-subtitles'],{stdio:'inherit'});
process.exitCode=checked.status??1;
