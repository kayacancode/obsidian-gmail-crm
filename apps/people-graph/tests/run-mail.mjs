import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'people-mail-'));
try{await build({stdin:{contents:"import './tests/mail.test.ts'; import './tests/sync.test.ts'; import './tests/routes.test.ts';",resolveDir:process.cwd()},alias:{'cloudflare:workers':'./tests/worker-stub.ts'},outfile:join(dir,'test.mjs'),bundle:true,platform:'node',format:'esm'});process.exitCode=spawnSync(process.execPath,['--test',join(dir,'test.mjs')],{stdio:'inherit'}).status??1;}finally{await rm(dir,{recursive:true,force:true});}
