import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../../scripts/v32-to-v4/cli.mjs';
import { assertNodeVersion } from '../../scripts/v32-to-v4/lib/runtime.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = resolve(repositoryRoot, 'scripts/v32-to-v4/cli.mjs');

const expectedHelp = `Usage: npm run migrate:v32 -- <command>

Commands:
  inspect-source
  export
  verify-bundle
  compile-policy
  inspect-target
  prepare-target
  dry-run
  import
  plan-images
  copy-images
  plan-reembed
  validate
  status
`;

function spawnCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function captureMain(overrides = {}) {
  let stdout = '';
  let stderr = '';
  const status = main({
    argv: [],
    nodeMajor: 22,
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
    ...overrides,
  });
  return { status, stdout, stderr };
}

describe('v3.2 to v4 migration CLI', () => {
  it('prints the deterministic full command list for --help', () => {
    const result = spawnCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(expectedHelp);
    expect(result.stdout).not.toContain('\n  plan\n');
    expect(result.stdout).not.toContain('cutover-status');
  });

  it('prints help when no command is supplied', () => {
    const result = spawnCli([]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(expectedHelp);
  });

  it('refuses an unknown command with a stable safe error', () => {
    const result = spawnCli(['not-a-command\nunsafe-detail']);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'RMIG-E-COMMAND-UNKNOWN: Unknown migration command. Run with --help to list commands.\n',
    );
    expect(result.stderr).not.toContain('unsafe-detail');
    expect(result.stderr).not.toContain('Error:');
  });

  it('refuses an advertised command until its handler is implemented', () => {
    const result = spawnCli(['inspect-source', '--source', 'do-not-open']);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'RMIG-E-COMMAND-NOT-IMPLEMENTED: Migration command "inspect-source" is not implemented yet.\n',
    );
  });

  it.each([21, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 22.5, '22', null])(
    'rejects invalid or unsupported Node major %j with a stable error code',
    (nodeMajor) => {
      expect(() => assertNodeVersion(nodeMajor)).toThrow(
        expect.objectContaining({ code: 'RMIG-E-NODE-VERSION' }),
      );
    },
  );

  it.each([22, 23, 100])('accepts integer Node major %i', (nodeMajor) => {
    expect(() => assertNodeVersion(nodeMajor)).not.toThrow();
  });

  it('turns a Node-version refusal into exit code 2 without a stack trace', () => {
    const result = captureMain({ argv: ['inspect-source'], nodeMajor: 21 });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'RMIG-E-NODE-VERSION: Node.js 22 or newer is required; received major 21.\n',
    );
    expect(result.stderr).not.toContain('at ');
  });

  it('checks the Node gate before invoking a command handler or accessing a source', () => {
    const runCommand = vi.fn(() => {
      throw new Error('source accessed');
    });

    const result = captureMain({
      argv: ['inspect-source', '--source', 'do-not-open'],
      nodeMajor: 21,
      runCommand,
    });

    expect(result.status).toBe(2);
    expect(runCommand).not.toHaveBeenCalled();
    expect(result.stderr).not.toContain('source accessed');
  });

  it('invokes the injected handler only after the Node gate passes', () => {
    const runCommand = vi.fn(() => 0);

    const result = captureMain({
      argv: ['inspect-source', '--source', 'fixture'],
      nodeMajor: 22,
      runCommand,
    });

    expect(result.status).toBe(0);
    expect(runCommand).toHaveBeenCalledWith('inspect-source', ['--source', 'fixture']);
  });
});
