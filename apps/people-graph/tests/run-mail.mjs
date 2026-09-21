import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'people-mail-'));
try{await build({stdin:{contents:"import './tests/mail.test.ts'; import './tests/relevance-model.test.ts'; import './tests/relevance-store.test.ts'; import './tests/theme-extractor.test.ts'; import './tests/gmail-body.test.ts'; import './tests/public-sources.test.ts'; import './tests/sync.test.ts'; import './tests/routes.test.ts'; import './tests/relevance-routes.test.ts'; import './tests/relevance-security.test.ts'; import './tests/granola.test.ts'; import './tests/granola-client.test.ts'; import './tests/granola-sync.test.ts'; import './tests/granola-extractor.test.ts'; import './tests/draft-note.test.ts';",resolveDir:process.cwd()},alias:{'cloudflare:workers':'./tests/worker-stub.ts'},outfile:join(dir,'test.mjs'),bundle:true,platform:'node',format:'esm'});process.exitCode=spawnSync(process.execPath,['--test',...(process.env.TEST_NAME?['--test-name-pattern',process.env.TEST_NAME]:[]),join(dir,'test.mjs')],{stdio:'inherit'}).status??1;}finally{await rm(dir,{recursive:true,force:true});}
