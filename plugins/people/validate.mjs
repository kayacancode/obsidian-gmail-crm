import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {dirname, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

// Offline package checks only. Live OAuth and installed-plugin tests are separate.
const root = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const localFile = async path => {
  assert.equal(typeof path, 'string', 'A package path must be a string');
  assert.ok(path.startsWith('./') && !path.split('/').includes('..'), `Unsafe package path: ${path}`);
  const target = resolve(root, path), rel = relative(root, target);
  assert.ok(!isAbsolute(rel) && !rel.startsWith('..'), `Path leaves package: ${path}`);
  assert.ok((await stat(target)).isFile(), `Missing package file: ${path}`);
};
const https = value => {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', 'MCP and listing URLs must use HTTPS');
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'URLs must not contain credentials, queries, or fragments');
};
const noSecrets = value => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(clientSecret|client_secret|access_token|refresh_token|authorization|headers|env|command|args)$/i.test(key), `Package must not include ${key}`);
    noSecrets(child);
  }
};

try {
  const manifest = await json('plugin.json'), mcp = await json('mcp.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(manifest.name, /^[a-z][a-z0-9-]{0,63}$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(typeof manifest.description === 'string' && manifest.description.trim());
  const ui = manifest.extensions['com.openai'].interface;
  for (const [field, max] of [['displayName', 30], ['shortDescription', 30], ['longDescription', 4000], ['developerName', 80]]) {
    assert.ok(typeof ui[field] === 'string' && ui[field].length > 0 && ui[field].length <= max, `Invalid ${field}`);
  }
  await localFile(ui.logo);
  await localFile(ui.composerIcon);
  for (const [key, value] of Object.entries(ui)) if (key.endsWith('URL')) https(value);
  assert.ok(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length <= 3);
  for (const prompt of ui.defaultPrompt) assert.ok(typeof prompt === 'string' && prompt.length <= 128 && !prompt.includes('@'));
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(mcp.mcpServers), ['people']);
  const server = mcp.mcpServers.people;
  assert.equal(server.type, 'streamable-http');
  https(server.url);
  assert.equal(new URL(server.url).pathname, '/api/people-mcp');
  const auth = server.extensions['com.openai'].auth;
  assert.equal(auth.type, 'oauth');
  assert.deepEqual(auth.client, {mode: 'dcr'});
  assert.deepEqual(auth.baseScopes, ['people:read', 'people:write', 'offline_access']);
  noSecrets(manifest);
  noSecrets(mcp);
  await localFile('./skills/people/SKILL.md');
  const skill = await readFile(resolve(root, 'skills/people/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: people\ndescription: .+\n---\n/);
  // JSON is a YAML subset: this keeps dependency metadata parseable without a build dependency.
  const metadata = await json('skills/people/agents/openai.yaml');
  assert.equal(metadata.policy.allow_implicit_invocation, true);
  assert.equal(metadata.dependencies.tools.length, 1);
  assert.deepEqual(metadata.dependencies.tools[0], {
    type: 'mcp', value: 'people', description: 'Authenticated People network and private relationship context',
    transport: 'streamable_http', url: server.url,
  });
  console.log('People plugin structure valid. Hosted OAuth and ChatGPT installation are not checked.');
} catch (error) {
  console.error('People plugin validation failed:', error.message);
  process.exitCode = 1;
}
