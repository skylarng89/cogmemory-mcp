import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, stampPackage, recordTarball, loadRelease, verifyNpm, waitForNpm, publishNpm, publishMcp, verifyMcp, getJSON, releaseSummary } from './release.mjs';

function fixture(t, { packed = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cogmemory-release-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'source'), directory = join(base, 'artifact');
  mkdirSync(source);
  const pkg = { name: 'cogmemory-mcp', version: '1.15.0', mcpName: 'io.github.skylarng89/cogmemory-mcp', repository: { type: 'git', url: 'git+https://github.com/skylarng89/cogmemory-mcp.git' } };
  const server = { $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', name: pkg.mcpName, version: '1.14.0', description: 'Test server', repository: { url: 'https://github.com/skylarng89/cogmemory-mcp', source: 'github' }, packages: [{ registryType: 'npm', identifier: pkg.name, version: '1.14.0', transport: { type: 'stdio' } }] };
  writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(source, 'server.json'), JSON.stringify(server));
  let manifest = prepare(source, directory, 'v1.15.0', 'a'.repeat(40), 'skylarng89/cogmemory-mcp');
  if (packed) {
    writeFileSync(join(directory, 'cogmemory-mcp-1.15.0.tgz'), 'fake verified tarball');
    manifest = recordTarball(directory);
  }
  const metadata = JSON.parse(readFileSync(join(directory, 'server.json'), 'utf8'));
  const npm = { ...pkg, gitHead: manifest.sourceSha, dist: { integrity: manifest.integrity } };
  return { source, directory, pkg, metadata, manifest, npm };
}
const response = value => value === null ? new Response(null, { status: 404 }) : Response.json(value);
function sequence(...values) {
  return async () => {
    assert(values.length > 0, 'Unexpected registry request');
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : response(value);
  };
}
const noPublish = () => assert.fail('No publishing command expected');
const quick = { sleep: async () => {}, log: () => {} };

test('preparation validates tag and synchronizes stale registry metadata', t => {
  const f = fixture(t);
  assert.equal(f.metadata.version, '1.15.0');
  assert.equal(f.metadata.packages[0].version, '1.15.0');
  assert.throws(() => prepare(f.source, f.directory, 'v1.16.0', f.manifest.sourceSha, 'skylarng89/cogmemory-mcp'), /must match/);
  assert.throws(() => prepare(f.source, f.directory, 'main', f.manifest.sourceSha, 'skylarng89/cogmemory-mcp'), /must match/);
  assert.throws(() => prepare(f.source, f.directory, 'v1.15.0', f.manifest.sourceSha, 'someone/else'), /repository metadata/);
});

test('packed package retains the exact source commit for future MCP-only recovery', t => {
  const f = fixture(t);
  stampPackage(f.source, f.directory);
  assert.equal(JSON.parse(readFileSync(join(f.source, 'package.json'))).gitHead, f.manifest.sourceSha);
});

test('modified artifact tarballs and server metadata fail closed', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, f.manifest.tarball), 'changed');
  assert.throws(() => loadRelease(f.directory), /tarball checksum/);
  writeFileSync(join(f.directory, 'server.json'), '{}');
  assert.throws(() => loadRelease(f.directory), /server.json checksum/);
});

test('fresh npm publication submits the prebuilt tarball without lifecycle rebuilds', async t => {
  const f = fixture(t);
  let commands = 0;
  const status = await publishNpm(f.directory, { ...quick, fetcher: sequence(null), run: async (command, args) => {
    commands++;
    assert.equal(command, 'npm');
    assert.equal(args[0], 'publish');
    assert.equal(args[1], join(f.directory, f.manifest.tarball));
    assert(args.includes('--ignore-scripts'));
    assert(args.includes('--provenance'));
    return { code: 0, text: 'Package is being processed' };
  } });
  assert.equal(status, 'submitted');
  assert.equal(commands, 1);
});

test('npm rerun skips only an identical published tarball', async t => {
  const f = fixture(t);
  assert.equal(await publishNpm(f.directory, { ...quick, fetcher: sequence(f.npm), run: noPublish }), 'already-published');
  const different = structuredClone(f.npm); different.dist.integrity = 'sha512-other';
  await assert.rejects(publishNpm(f.directory, { ...quick, fetcher: sequence(different), run: noPublish }), /different tarball/);
});

test('a pending previous npm submission can resolve after a publish conflict', async t => {
  const f = fixture(t);
  assert.equal(await publishNpm(f.directory, { ...quick, fetcher: sequence(null, null, f.npm), run: async () => ({ code: 1, text: 'EPUBLISHCONFLICT' }) }), 'already-published');
});

test('npm auth errors are not swallowed or retried as successful publication', async t => {
  const f = fixture(t);
  await assert.rejects(publishNpm(f.directory, { ...quick, fetcher: sequence(null), run: async () => ({ code: 1, text: 'E403 Forbidden' }) }), /publication failed/);
});

test('npm lookup outage never triggers a blind publish', async t => {
  const f = fixture(t);
  const unavailable = () => new Response(null, { status: 503 });
  await assert.rejects(publishNpm(f.directory, { ...quick, fetcher: sequence(unavailable(), unavailable(), unavailable()), run: noPublish }), /HTTP 503/);
});

test('npm propagation polling accepts delayed visibility and transient network errors', async t => {
  const f = fixture(t);
  let pauses = 0;
  const got = await waitForNpm(f.manifest, { ...quick, fetcher: sequence(null, new Error('connection reset'), new Response(null, { status: 429 }), f.npm), sleep: async () => { pauses++; } });
  assert.equal(got.version, f.manifest.version);
  assert.equal(pauses, 3);
});

test('npm propagation polling stops at its deadline', async t => {
  const f = fixture(t);
  let clock = 0;
  await assert.rejects(waitForNpm(f.manifest, { ...quick, timeoutMs: 30, intervalMs: 10, now: () => clock, sleep: async ms => { clock += ms; }, fetcher: async () => response(null) }), /Timed out/);
  assert.equal(clock, 30);
});

test('permanent npm read errors fail immediately', async t => {
  const f = fixture(t);
  await assert.rejects(waitForNpm(f.manifest, { ...quick, fetcher: sequence(new Response(null, { status: 401 })), sleep: noPublish }), /HTTP 401/);
  await assert.rejects(getJSON('https://test.invalid', async () => new Response('broken JSON')), /Invalid JSON/);
});

test('MCP-only recovery verifies npm identity and exact tagged commit', t => {
  const f = fixture(t, { packed: false });
  assert.equal(verifyNpm(f.npm, f.manifest).version, '1.15.0');
  assert.throws(() => verifyNpm({ ...f.npm, gitHead: 'b'.repeat(40) }, f.manifest), /gitHead/);
  assert.throws(() => verifyNpm({ ...f.npm, mcpName: 'other/server' }, f.manifest), /metadata/);
});

test('MCP-only artifact cannot accidentally publish npm', async t => {
  const f = fixture(t, { packed: false });
  await assert.rejects(publishNpm(f.directory, { ...quick, run: noPublish }), /requires a verified build tarball/);
});

test('MCP rerun verifies a matching registration without login or publishing', async t => {
  const f = fixture(t, { packed: false });
  const status = await publishMcp(f.directory, '/publisher', { ...quick, fetcher: sequence(f.npm, { server: f.metadata }), run: noPublish });
  assert.equal(status, 'already-registered');
});

test('MCP metadata mismatches or inactive registrations are never treated as success', t => {
  const f = fixture(t);
  assert.throws(() => verifyMcp({ server: { ...f.metadata, description: 'other' } }, f.metadata), /different metadata/);
  assert.throws(() => verifyMcp({ server: f.metadata, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } }, f.metadata), /not active/);
  const withoutSchema = structuredClone(f.metadata); delete withoutSchema.$schema;
  verifyMcp({ server: withoutSchema, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-01-01' } } }, f.metadata);
});

test('MCP publication waits for npm, authenticates, publishes, and verifies visibility', async t => {
  const f = fixture(t);
  const calls = [];
  const status = await publishMcp(f.directory, '/publisher', { ...quick, fetcher: sequence(null, f.npm, null, null, { server: f.metadata }), run: async (command, args, options) => {
    calls.push(args);
    assert.equal(options.cwd, f.directory);
    return { code: 0, text: '' };
  } });
  assert.equal(status, 'registered');
  assert.deepEqual(calls, [['login', 'github-oidc'], ['publish', 'server.json']]);
});

test('MCP retries transient upstream npm visibility failures', async t => {
  const f = fixture(t);
  let publishes = 0;
  const status = await publishMcp(f.directory, '/publisher', { ...quick, fetcher: sequence(f.npm, null, null, { server: f.metadata }), run: async (_cmd, args) => {
    if (args[0] === 'login') return { code: 0, text: '' };
    publishes++;
    return publishes === 1 ? { code: 1, text: "server returned status 400: version '1.15.0' was not found (status: 404)" } : { code: 0, text: '' };
  } });
  assert.equal(status, 'registered');
  assert.equal(publishes, 2);
});

test('MCP duplicate/conflict responses are verified instead of blindly ignored', async t => {
  const f = fixture(t);
  const status = await publishMcp(f.directory, '/publisher', { ...quick, fetcher: sequence(f.npm, null, { server: f.metadata }), run: async (_cmd, args) => args[0] === 'login' ? { code: 0, text: '' } : { code: 1, text: 'server returned status 409' } });
  assert.equal(status, 'already-registered');
});

test('permanent MCP schema and auth failures do not retry publication', async t => {
  const f = fixture(t);
  let publishes = 0;
  await assert.rejects(publishMcp(f.directory, '/publisher', { ...quick, fetcher: sequence(f.npm, null, null), run: async (_cmd, args) => {
    if (args[0] === 'login') return { code: 0, text: '' };
    publishes++;
    return { code: 1, text: 'server returned status 400: invalid schema' };
  } }), /MCP publication failed/);
  assert.equal(publishes, 1);
  await assert.rejects(publishMcp(f.directory, '/publisher', { ...quick, fetcher: sequence(f.npm, null), run: async () => ({ code: 1, text: '403' }) }), /OIDC login failed/);
});

test('MCP transient publication attempts are bounded', async t => {
  const f = fixture(t);
  let publishes = 0;
  await assert.rejects(publishMcp(f.directory, '/publisher', { ...quick, fetcher: sequence(f.npm, null, null, null, null, null), run: async (_cmd, args) => {
    if (args[0] === 'login') return { code: 0, text: '' };
    publishes++; return { code: 1, text: 'server returned status 503' };
  } }), /MCP publication failed/);
  assert.equal(publishes, 4);
});

test('summary reports failures, skipped jobs, and submitted-but-unverified npm accurately', () => {
  const report = releaseSummary({ build: { result: 'success', outputs: { status: 'build-and-tests-passed' } }, publish_npm: { result: 'success', outputs: { status: 'submitted' } }, publish_mcp: { result: 'failure' } }, 'v1.15.0', 'full');
  assert.match(report, /npm \| success \| submitted/);
  assert.match(report, /MCP Registry \| failure \| —/);
  assert.doesNotMatch(report, /✅|Published/);
  assert.match(releaseSummary({ publish_npm: { result: 'skipped' } }, 'v1.15.0', 'mcp-only'), /npm \| skipped/);
});
