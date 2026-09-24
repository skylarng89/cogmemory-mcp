// Dependency-free release orchestration: reusable from jobs and old-tag recovery.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const NPM = 'https://registry.npmjs.org';
const MCP = 'https://registry.modelcontextprotocol.io';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const digest = (bytes, algorithm = 'sha512') => createHash(algorithm).update(bytes).digest('base64');
const repositoryURL = value => (typeof value === 'string' ? value : value?.url ?? '')
  .replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
const output = (key, value) => {
  console.log(`${key}: ${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

export function prepare(source, destination, tag, sourceSha, repository) {
  const pkg = json(join(source, 'package.json'));
  const server = json(join(source, 'server.json'));
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || tag !== `v${pkg.version}`) {
    throw new Error(`Release tag ${tag} must match package.json version v${pkg.version}`);
  }
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Expected an immutable source commit SHA');
  if (pkg.mcpName !== server.name || server.packages?.length !== 1 ||
      server.packages[0].registryType !== 'npm' || server.packages[0].identifier !== pkg.name) {
    throw new Error('package.json and server.json must identify the same single npm package and MCP server');
  }
  const expectedRepo = `https://github.com/${repository}`;
  if (repositoryURL(pkg.repository) !== expectedRepo || repositoryURL(server.repository) !== expectedRepo) {
    throw new Error('Release repository metadata does not match this GitHub repository');
  }
  // Old tags may contain stale server.json versions; package.json is authoritative.
  server.version = pkg.version;
  server.packages[0].version = pkg.version;
  mkdirSync(destination, { recursive: true });
  writeJson(join(destination, 'server.json'), server);
  const manifest = {
    name: pkg.name, version: pkg.version, mcpName: pkg.mcpName,
    sourceSha, repository: expectedRepo,
    serverDigest: digest(readFileSync(join(destination, 'server.json'))),
  };
  writeJson(join(destination, 'release.json'), manifest);
  return manifest;
}

// npm publishing a .tgz reads metadata from the archive, not from a git checkout.
export function stampPackage(source, directory) {
  const manifest = loadRelease(directory);
  const path = join(source, 'package.json');
  const pkg = json(path);
  if (pkg.name !== manifest.name || pkg.version !== manifest.version || pkg.mcpName !== manifest.mcpName) {
    throw new Error('Package changed after release metadata was prepared');
  }
  writeJson(path, { ...pkg, gitHead: manifest.sourceSha });
}

export function recordTarball(directory) {
  const files = readdirSync(directory).filter(file => file.endsWith('.tgz'));
  if (files.length !== 1) throw new Error('Expected exactly one npm tarball in the release artifact');
  const manifest = loadRelease(directory);
  manifest.tarball = files[0];
  manifest.integrity = `sha512-${digest(readFileSync(join(directory, files[0])))}`;
  writeJson(join(directory, 'release.json'), manifest);
  return manifest;
}

export function loadRelease(directory) {
  const manifest = json(join(directory, 'release.json'));
  if (digest(readFileSync(join(directory, 'server.json'))) !== manifest.serverDigest) {
    throw new Error('Release server.json checksum mismatch');
  }
  if (manifest.tarball) {
    if (basename(manifest.tarball) !== manifest.tarball || !manifest.tarball.endsWith('.tgz')) {
      throw new Error('Invalid release tarball path');
    }
    if (`sha512-${digest(readFileSync(join(directory, manifest.tarball)))}` !== manifest.integrity) {
      throw new Error('Release tarball checksum mismatch');
    }
  }
  return manifest;
}

class RegistryError extends Error {
  constructor(message, retryable) { super(message); this.retryable = retryable; }
}

export async function getJSON(url, fetcher = fetch, timeoutMs = 15_000) {
  let response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } }); }
  catch (error) { throw new RegistryError(`Registry request failed: ${error.message}`, true); }
  if (response.status === 404) return null;
  if (!response.ok) throw new RegistryError(`Registry HTTP ${response.status} for ${url}`, response.status === 429 || response.status >= 500);
  try { return await response.json(); }
  catch { throw new RegistryError(`Invalid JSON response from ${url}`, false); }
}

export function verifyNpm(remote, manifest) {
  if (remote.name !== manifest.name || remote.version !== manifest.version || remote.mcpName !== manifest.mcpName ||
      repositoryURL(remote.repository) !== manifest.repository) {
    throw new Error('Existing npm release metadata does not match the selected release');
  }
  if (manifest.integrity) {
    if (remote.dist?.integrity !== manifest.integrity) throw new Error('Existing npm version contains a different tarball; refusing to treat it as this release');
  } else if (remote.gitHead !== manifest.sourceSha) {
    // MCP-only recovery has no locally rebuilt tarball to compare.
    throw new Error('npm gitHead does not match the selected tag; cannot verify MCP-only recovery');
  }
  return remote;
}

function dependencies(options = {}) {
  return { fetcher: fetch, sleep, now: Date.now, log: console.log, run: runCommand, ...options };
}
const npmURL = manifest => `${NPM}/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
const mcpURL = server => `${MCP}/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`;

// Bound both request duration and sleep by the public-availability deadline.
export async function waitForNpm(manifest, options = {}) {
  const d = dependencies(options);
  const deadline = d.now() + (options.timeoutMs ?? 600_000);
  for (;;) {
    if (d.now() >= deadline) throw new Error(`Timed out waiting for ${manifest.name}@${manifest.version} on public npm. Rerun the MCP job when processing finishes.`);
    try {
      const remote = await getJSON(npmURL(manifest), d.fetcher, Math.min(15_000, deadline - d.now()));
      if (remote) return verifyNpm(remote, manifest);
    } catch (error) { if (!error.retryable) throw error; d.log(error.message); }
    if (d.now() >= deadline) throw new Error(`Timed out waiting for ${manifest.name}@${manifest.version} on public npm. Rerun the MCP job when processing finishes.`);
    d.log(`Waiting for ${manifest.name}@${manifest.version} to become publicly available...`);
    await d.sleep(Math.min(options.intervalMs ?? 15_000, deadline - d.now()));
  }
}

async function lookupWithRetry(url, d) {
  for (let attempt = 1; ; attempt++) {
    try { return await getJSON(url, d.fetcher); }
    catch (error) {
      if (!error.retryable || attempt === 3) throw error;
      d.log(error.message);
      await d.sleep(5_000 * attempt);
    }
  }
}

export async function publishNpm(directory, options = {}) {
  const d = dependencies(options);
  const manifest = loadRelease(directory);
  if (!manifest.tarball || !manifest.integrity) throw new Error('npm publishing requires a verified build tarball');
  const existing = await lookupWithRetry(npmURL(manifest), d);
  if (existing) { verifyNpm(existing, manifest); return 'already-published'; }
  const result = await d.run('npm', ['publish', resolve(directory, manifest.tarball), '--provenance', '--access', 'public', '--ignore-scripts']);
  if (result.code === 0) return 'submitted'; // Accepted does not yet mean publicly readable.
  if (/EPUBLISHCONFLICT|cannot publish over|previously published versions/i.test(result.text)) {
    await waitForNpm(manifest, d);
    return 'already-published';
  }
  throw new Error(`npm publication failed (exit ${result.code}); inspect the npm output above`);
}

export function verifyMcp(response, expected) {
  const actual = response.server;
  // Registry-owned publication timestamps/status live outside `server`.
  const clean = value => {
    const copy = structuredClone(value);
    delete copy.$schema;
    return copy;
  };
  if (!actual || !isDeepStrictEqual(clean(actual), clean(expected))) {
    throw new Error('Existing MCP version has different metadata; refusing to overwrite or silently skip it');
  }
  const status = response._meta?.['io.modelcontextprotocol.registry/official']?.status;
  if (status && status !== 'active') throw new Error(`Existing MCP version is ${status}, not active`);
}

const transientPublish = text => /status (?:429|5\d\d)|timed? ?out|ECONNRESET|ECONNREFUSED|temporary failure|version .*not found \(status: 404\)/i.test(text);
const duplicatePublish = text => /status 409|already exists|already published/i.test(text);

export async function publishMcp(directory, publisher, options = {}) {
  const d = dependencies(options);
  const manifest = loadRelease(directory);
  const server = json(join(directory, 'server.json'));
  await waitForNpm(manifest, d);
  const url = mcpURL(server);
  let existing = await lookupWithRetry(url, d);
  if (existing) { verifyMcp(existing, server); return 'already-registered'; }
  const login = await d.run(publisher, ['login', 'github-oidc'], { cwd: resolve(directory) });
  if (login.code !== 0) throw new Error('MCP Registry OIDC login failed');
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await d.run(publisher, ['publish', 'server.json'], { cwd: resolve(directory) });
    if (result.code === 0) {
      // Verify publication; do not republish a successful submission just because reads lag.
      for (let check = 0; check < 6; check++) {
        existing = await lookupWithRetry(url, d);
        if (existing) { verifyMcp(existing, server); return 'registered'; }
        if (check < 5) await d.sleep(15_000);
      }
      throw new Error('MCP accepted publication but verification timed out. Rerun the MCP job to verify it.');
    }
    // A lost response or another publisher can leave an already-created registration.
    existing = await lookupWithRetry(url, d);
    if (existing) { verifyMcp(existing, server); return 'already-registered'; }
    if (attempt === 4 || (!transientPublish(result.text) && !duplicatePublish(result.text))) {
      throw new Error(`MCP publication failed (exit ${result.code}); inspect publisher output above`);
    }
    await d.sleep(15_000 * attempt);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
  if (text) console.log(text);
  return { code: result.status ?? 1, text };
}

export function releaseSummary(needs, tag, mode) {
  const rows = [
    ['Build / metadata', needs.build], ['npm', needs.publish_npm], ['MCP Registry', needs.publish_mcp],
  ].map(([name, job]) => `| ${name} | ${job?.result ?? 'unknown'} | ${job?.outputs?.status || '—'} |`);
  return [
    '## Release results', '', `Tag: ${tag}; mode: ${mode}`, '',
    '| Stage | Job result | Detail |', '|---|---|---|', ...rows, '',
    'An npm submission can still be processing. MCP success requires the exact npm release to be publicly readable.', '',
  ].join('\n');
}

async function main() {
  const [command, directory, destination, tag] = process.argv.slice(2);
  switch (command) {
    case 'prepare': {
      const sha = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const manifest = prepare(directory, destination, tag, sha, process.env.GITHUB_REPOSITORY);
      output('version', manifest.version);
      break;
    }
    case 'stamp-package': stampPackage(directory, destination); break;
    case 'record-tarball': recordTarball(directory); break;
    case 'npm': output('status', await publishNpm(directory)); break;
    case 'mcp': output('status', await publishMcp(directory, resolve(process.env.PUBLISHER_PATH))); break;
    case 'summary': {
      const summary = releaseSummary(JSON.parse(process.env.RELEASE_RESULTS), process.env.RELEASE_TAG, process.env.RELEASE_MODE);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      break;
    }
    default: throw new Error('Expected prepare, stamp-package, record-tarball, npm, mcp, or summary');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
