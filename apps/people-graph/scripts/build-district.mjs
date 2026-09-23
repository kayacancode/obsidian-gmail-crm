import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';
await build({entryPoints:['src/visuals/district.mjs'],bundle:true,format:'esm',minify:true,outfile:'public/studio/district.bundle.mjs',legalComments:'eof'});
await copyFile('node_modules/three/LICENSE','public/studio/three-LICENSE.txt');
