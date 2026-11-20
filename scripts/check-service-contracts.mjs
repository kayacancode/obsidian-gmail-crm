import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
for (const name of ['measured-contact.ts', 'relevance-contract.ts']) {
  let service;
  try {service = await readFile(new URL('../services/shared/' + name, import.meta.url), 'utf8');}
  catch {throw new Error('Initialize pinned service sources first: git submodule update --init --recursive');}
  assert.equal(await readFile(new URL('../shared/' + name, import.meta.url), 'utf8'), service, 'Plugin/server contract mismatch: ' + name);
}
console.log('Pinned plugin/server contracts match.');
