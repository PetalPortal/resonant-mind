#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNodeVersion } from './lib/runtime.mjs';

const commands = [
  'inspect-source',
  'export',
  'verify-bundle',
  'compile-policy',
  'inspect-target',
  'prepare-target',
  'dry-run',
  'import',
  'plan-images',
  'copy-images',
  'plan-reembed',
  'validate',
  'status',
];

const help = `Usage: npm run migrate:v32 -- <command>

Commands:
${commands.map((command) => `  ${command}`).join('\n')}
`;

export function main({
  argv = process.argv.slice(2),
  nodeMajor,
  writeStdout = (value) => process.stdout.write(value),
  writeStderr = (value) => process.stderr.write(value),
  runCommand,
} = {}) {
  try {
    assertNodeVersion(nodeMajor);
  } catch (error) {
    if (error?.code !== 'RMIG-E-NODE-VERSION') {
      throw error;
    }
    writeStderr(`${error.code}: ${error.message}\n`);
    return 2;
  }

  const [command, ...commandArgs] = argv;
  if (command === undefined || command === '--help') {
    writeStdout(help);
    return 0;
  }

  if (!commands.includes(command)) {
    writeStderr(
      'RMIG-E-COMMAND-UNKNOWN: Unknown migration command. Run with --help to list commands.\n',
    );
    return 2;
  }

  if (runCommand === undefined) {
    writeStderr(
      `RMIG-E-COMMAND-NOT-IMPLEMENTED: Migration command "${command}" is not implemented yet.\n`,
    );
    return 2;
  }

  return runCommand(command, commandArgs);
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
  process.exitCode = main();
}
