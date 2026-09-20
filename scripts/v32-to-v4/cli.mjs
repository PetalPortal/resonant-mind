#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNodeVersion } from './lib/runtime.mjs';
import { humanInspectReport, inspectSource, parseInspectSourceArgs } from './commands/inspect-source.mjs';
import { exportCommand, humanExportResult, parseExportArgs } from './commands/export.mjs';
import { humanVerifyResult, parseVerifyBundleArgs, verifyBundleCommand } from './commands/verify-bundle.mjs';
import { canonicalJson } from './lib/canonical-json.mjs';
import { compilePolicyCommand, humanCompilePolicyResult, parseCompilePolicyArgs } from './commands/compile-policy.mjs';
import {
  exitCodeFor,
  isMigrationRefusal,
  MigrationRefusal,
  serializeRefusal,
} from './lib/refusal.mjs';

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
  inspect-source
  export         --source-kind ... --source ... --migration-id ... --bundle ... [--passphrase-file ...]
                 [--allow-plaintext-bundle --acknowledge-plaintext-risk]
  verify-bundle  --bundle ... [--passphrase-file ...]
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

export function main({
  argv = process.argv.slice(2),
  nodeMajor,
  writeStdout = (value) => process.stdout.write(value),
  writeStderr = (value) => process.stderr.write(value),
  runCommand,
} = {}) {
  let json = false;
  try {
    json = argv.includes('--json');
    const positionalArgv = argv.filter((argument) => argument !== '--json');
    assertNodeVersion(nodeMajor);
    const [command, ...commandArgs] = positionalArgv;
    if (command === undefined || command === '--help') {
      writeStdout(help);
      return 0;
    }

    if (!commands.includes(command)) {
      throw new MigrationRefusal({
        code: 'RMIG-E-COMMAND-UNKNOWN',
        phase: 'runtime',
        summary: 'Unknown migration command. Run with --help to list commands.',
        safe_details: {},
        report_path: null,
      });
    }

    if (runCommand !== undefined) return runCommand(command, commandArgs);
    if (command === 'export') {
      const parsed = parseExportArgs(commandArgs);
      return exportCommand(parsed).then((result) => {
        if (json) writeStdout(`${canonicalJson(result.manifest)}\n`);
        else writeStdout(humanExportResult(result));
        return 0;
      });
    }
    if (command === 'verify-bundle') {
      const parsed = parseVerifyBundleArgs(commandArgs);
      return Promise.resolve(verifyBundleCommand(parsed)).then((result) => {
        if (json) writeStdout(`${canonicalJson(result.manifest)}\n`);
        else writeStdout(humanVerifyResult(result));
        return 0;
      });
    }
    if (command === 'compile-policy') {
      const parsed = parseCompilePolicyArgs(commandArgs);
      const result = compilePolicyCommand(parsed);
      writeStdout(json ? `${canonicalJson(result)}\n` : humanCompilePolicyResult(result));
      return 0;
    }
    if (command !== 'inspect-source') {
      throw new MigrationRefusal({
        code: 'RMIG-E-COMMAND-NOT-IMPLEMENTED',
        phase: command,
        summary: `Migration command "${command}" is not implemented yet.`,
        safe_details: {},
        report_path: null,
      });
    }
    const parsed = parseInspectSourceArgs(commandArgs);
    return inspectSource(parsed).then((report) => {
      if (json) writeStdout(`${canonicalJson(report)}\n`);
      else writeStdout(humanInspectReport(report, parsed.reportPath));
      return 0;
    });
  } catch (error) {
    if (isMigrationRefusal(error)) {
      const serialized = serializeRefusal(error, { json });
      (json ? writeStdout : writeStderr)(serialized);
      return exitCodeFor(error);
    }
    const summary = 'Unexpected internal migration error.';
    if (json) {
      writeStdout(canonicalJson({ code: 'RMIG-E-INTERNAL', summary }));
    } else {
      writeStderr(`RMIG-E-INTERNAL: ${summary}\n`);
    }
    return exitCodeFor(error);
  }
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
  const result = main();
  process.exitCode = result instanceof Promise
    ? await result.catch((error) => {
      if (isMigrationRefusal(error)) {
        process.stderr.write(serializeRefusal(error));
        return exitCodeFor(error);
      }
      process.stderr.write('RMIG-E-INTERNAL: Unexpected internal migration error.\n');
      return 1;
    })
    : result;
}
