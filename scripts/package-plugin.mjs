import {readFile, mkdir, copyFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const readJSON=async path=>JSON.parse(await readFile(new URL('../'+path,import.meta.url),'utf8'));
const manifest=await readJSON('manifest.json'),pkg=await readJSON('package.json'),versions=await readJSON('versions.json');
assert.match(manifest.version,/^\d+\.\d+\.\d+$/);
assert.ok(!/\bplugin\b/i.test(manifest.name), 'Obsidian directory names must not contain the word Plugin');
assert.equal(pkg.version,manifest.version,'Package and manifest versions must match');
assert.equal(versions[manifest.version],manifest.minAppVersion,'Missing or incorrect versions.json entry');
assert.equal(manifest.isDesktopOnly,true);
assert.ok(manifest.description.length<=250&&manifest.description.endsWith('.'));
for(const name of ['README.md','PRIVACY.md','LICENSE'])assert.ok((await readFile(new URL('../'+name,import.meta.url),'utf8')).trim());
const destination=new URL('../dist/plugin/',import.meta.url);await mkdir(destination,{recursive:true});
const hashes=[];
for(const name of ['main.js','manifest.json','styles.css']){
 const source=new URL('../'+name,import.meta.url),bytes=await readFile(source);
 assert.ok(bytes.length>0);await copyFile(source,new URL(name,destination));
 hashes.push(createHash('sha256').update(bytes).digest('hex')+'  '+name);
}
await writeFile(new URL('SHA256SUMS',destination),hashes.join('\n')+'\n');
console.log(`Packaged People Data Sync ${manifest.version} in dist/plugin/`);
