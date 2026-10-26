import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('./install-peoplegraph.sh', import.meta.url));
const binary = '#!/bin/sh\nprintf \'peoplegraph linux x86_64 fixture\\n\'\n';
const assets = {
  'peoplegraph-linux-x86_64': binary,
  'peoplegraph-macos-arm64': '#!/bin/sh\nprintf \'peoplegraph macos arm64 fixture\\n\'\n',
  'peoplegraph-macos-x86_64': '#!/bin/sh\nprintf \'peoplegraph macos x86_64 fixture\\n\'\n',
  'peoplegraph-SKILL.md': '---\nname: peoplegraph\n---\nFixture skill\n',
  'people-agent-onboarding.md': '# Getting started\n',
  'people-memory-integration.md': '# Private context\n',
  'peoplegraph-web-login.md': '# Web login\n',
};

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'peoplegraph-installer-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const stubs = path.join(dir, 'stubs');
  const downloads = path.join(dir, 'downloads');
  for (const name of [home, stubs, downloads]) mkdirSync(name);
  for (const [name, value] of Object.entries(assets)) writeFileSync(path.join(downloads, name), value);
  const checksums = Object.entries(assets).map(([name, value]) =>
    `${createHash('sha256').update(value).digest('hex')}  ${name}\n`).join('');
  writeFileSync(path.join(downloads, 'SHA256SUMS'), checksums);
  // Only the external HTTP boundary is replaced. Real shell, hashing, and file writes run.
  writeFileSync(path.join(stubs, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
if (process.env.FAIL_NETWORK === '1') process.exit(7);
if (url === 'https://api.github.com/repos/kayacancode/obsidian-gmail-crm/releases?per_page=100') {
  process.stdout.write('[{"tag_name":"peoplegraph-v0.3.12"}]\\n');
  process.exit(0);
}
const prefix = 'https://github.com/kayacancode/obsidian-gmail-crm/releases/download/peoplegraph-v' + (process.env.EXPECT_VERSION || '0.3.12') + '/';
if (!url || !url.startsWith(prefix)) process.exit(22);
const filename = path.join(process.env.DOWNLOADS, url.slice(prefix.length));
if (!fs.existsSync(filename)) process.exit(22);
const contents = fs.readFileSync(filename);
const output = args.indexOf('-o');
if (output >= 0) fs.writeFileSync(args[output + 1], contents);
else process.stdout.write(contents);
`, { mode: 0o755 });
  writeFileSync(path.join(stubs, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo "${TEST_OS:-Linux}";; -m) echo "${TEST_ARCH:-x86_64}";; *) exit 1;; esac\n', { mode: 0o755 });
  writeFileSync(path.join(stubs, 'codesign'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const bin = path.join(home, '.local/bin/peoplegraph');
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, 'previous working binary');
  const skill = path.join(home, '.codex/skills/peoplegraph/SKILL.md');
  mkdirSync(path.dirname(skill), { recursive: true });
  writeFileSync(skill, 'previous working skill');
  return {
    dir, home, downloads, bin, skill,
    run(args = [], env = {}) {
      return spawnSync('/bin/bash', [installer, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), DOWNLOADS: downloads, PATH: `${stubs}:${process.env.PATH}`, ...env },
      });
    },
    unchanged() {
      assert.equal(readFileSync(bin, 'utf8'), 'previous working binary');
      assert.equal(readFileSync(skill, 'utf8'), 'previous working skill');
    },
  };
}

test('installs the pinned binary without changing agent skills by default', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(f.bin, 'utf8'), binary);
  assert.equal(readFileSync(f.skill, 'utf8'), 'previous working skill');
  assert.equal(existsSync(path.join(f.home, '.claude')), false);
});

test('explicit agent choices install the skill and its offline guides for all selected agents', t => {
  const f = fixture(t);
  const result = f.run(['--skill', 'codex', '--skill', 'claude', '--skill', 'agents']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const directory of ['.codex', '.claude', '.agents']) {
    const target = path.join(f.home, directory, 'skills/peoplegraph');
    assert.equal(readFileSync(path.join(target, 'SKILL.md'), 'utf8'), assets['peoplegraph-SKILL.md']);
    for (const guide of ['people-agent-onboarding.md', 'people-memory-integration.md', 'peoplegraph-web-login.md']) {
      assert.equal(readFileSync(path.join(target, 'references', guide), 'utf8'), assets[guide]);
    }
  }
});

test('supports explicit binary and skill paths and a version override', t => {
  const f = fixture(t);
  const binDir = path.join(f.dir, 'custom bin');
  const skillDir = path.join(f.dir, 'custom skill');
  const result = f.run(['--version', '0.4.0', '--bin-dir', binDir, '--skill-dir', skillDir], { EXPECT_VERSION: '0.4.0' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(path.join(binDir, 'peoplegraph'), 'utf8'), binary);
  assert.equal(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), assets['peoplegraph-SKILL.md']);
  f.unchanged();
});

for (const [os, arch, asset] of [['Darwin', 'arm64', 'peoplegraph-macos-arm64'], ['Darwin', 'x86_64', 'peoplegraph-macos-x86_64'], ['Linux', 'x86_64', 'peoplegraph-linux-x86_64']]) {
  test(`installs the supported ${os} ${arch} asset`, t => {
    const f = fixture(t);
    const result = f.run([], { TEST_OS: os, TEST_ARCH: arch });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(f.bin, 'utf8'), assets[asset]);
  });
}

for (const scenario of ['network', 'empty release', 'missing checksums', 'empty checksums', 'bad binary checksum', 'bad skill checksum', 'missing guide', 'duplicate checksum']) {
  test(`${scenario} fails without replacing an existing binary or skill`, t => {
    const f = fixture(t);
    const manifest = path.join(f.downloads, 'SHA256SUMS');
    if (scenario === 'empty release') {
      for (const name of [...Object.keys(assets), 'SHA256SUMS']) rmSync(path.join(f.downloads, name));
    }
    if (scenario === 'missing checksums') rmSync(manifest);
    if (scenario === 'empty checksums') writeFileSync(manifest, '');
    if (scenario === 'bad binary checksum') writeFileSync(path.join(f.downloads, 'peoplegraph-linux-x86_64'), 'damaged binary');
    if (scenario === 'bad skill checksum') writeFileSync(path.join(f.downloads, 'peoplegraph-SKILL.md'), 'damaged skill');
    if (scenario === 'missing guide') rmSync(path.join(f.downloads, 'people-agent-onboarding.md'));
    if (scenario === 'duplicate checksum') writeFileSync(manifest, readFileSync(manifest, 'utf8').repeat(2));
    const result = f.run(['--skill', 'codex'], { FAIL_NETWORK: scenario === 'network' ? '1' : '0' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    f.unchanged();
  });
}

for (const args of [['--skill', 'unknown'], ['--version', '../main'], ['--skill-dir'], ['--unknown']]) {
  test(`rejects invalid arguments ${args.join(' ')}`, t => {
    const f = fixture(t);
    const result = f.run(args);
    assert.notEqual(result.status, 0);
    f.unchanged();
  });
}

test('unsupported platforms fail before replacing an existing install', t => {
  const f = fixture(t);
  const result = f.run([], { TEST_OS: 'Linux', TEST_ARCH: 'aarch64' });
  assert.notEqual(result.status, 0);
  f.unchanged();
});
