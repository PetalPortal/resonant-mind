import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_ROOT = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'migration', 'v3.2');
const SHA256 = /^[0-9a-f]{64}$/u;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read fixture provenance: ${error.message}`);
  }
}

function gitTagAvailable(root, tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

function gitBytes(root, tag, source) {
  return execFileSync('git', ['show', `${tag}:${source}`], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function verifyV32Fixtures({ fixtureRoot = DEFAULT_ROOT, repositoryRoot = REPOSITORY_ROOT } = {}) {
  const provenance = readJson(join(fixtureRoot, 'PROVENANCE.json'));
  if (provenance.tag !== 'v3.2.0' || !Array.isArray(provenance.files) || provenance.files.length !== 4) {
    throw new Error('Fixture provenance must describe exactly the four v3.2.0 schema files.');
  }
  const tagChecked = gitTagAvailable(repositoryRoot, provenance.tag);
  const files = provenance.files.map((entry) => {
    if (typeof entry.path !== 'string' || typeof entry.source !== 'string' || !SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.bytes)) {
      throw new Error('Fixture provenance contains an invalid file entry.');
    }
    const path = join(fixtureRoot, entry.path);
    const bytes = readFileSync(path);
    const actualSha256 = sha256(bytes);
    const actualBytes = bytes.byteLength;
    if (actualSha256 !== entry.sha256 || actualBytes !== entry.bytes) {
      throw new Error(`Fixture does not match provenance: ${entry.path}`);
    }
    let matchesTag = null;
    if (tagChecked) {
      const tagged = gitBytes(repositoryRoot, provenance.tag, entry.source);
      matchesTag = tagged.equals(bytes);
      if (!matchesTag) throw new Error(`Fixture does not match ${provenance.tag}:${entry.source}: ${entry.path}`);
    }
    return {
      path: entry.path,
      source: entry.source,
      sha256: actualSha256,
      bytes: actualBytes,
      matches_provenance: true,
      matches_tag: matchesTag,
    };
  });
  return { tag: provenance.tag, files, git_tag_checked: tagChecked };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = verifyV32Fixtures();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
