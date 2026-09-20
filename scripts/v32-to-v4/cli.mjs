#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNodeVersion } from './lib/runtime.mjs';
import { humanInspectReport, inspectSource, parseInspectSourceArgs } from './commands/inspect-source.mjs';
import { exportCommand, humanExportResult, parseExportArgs } from './commands/export.mjs';
import { humanVerifyResult, parseVerifyBundleArgs, verifyBundleCommand } from './commands/verify-bundle.mjs';
import {
  maybeInjectCheckpointFault,
} from './lib/checkpoints.mjs';
import { canonicalJson } from './lib/canonical-json.mjs';
import { compilePolicyCommand, humanCompilePolicyResult, parseCompilePolicyArgs } from './commands/compile-policy.mjs';
import { targetCommand, humanTargetResult } from './commands/target.mjs';
import { parsePlanImagesArgs, planImagesCommand, humanPlanImagesResult } from './commands/plan-images.mjs';
import { parseCopyImagesArgs, copyImagesCommand, humanCopyImagesResult } from './commands/copy-images.mjs';
import { parsePlanReembedArgs, planReembedCommand, humanPlanReembedResult } from './commands/plan-reembed.mjs';
import { parseValidateArgs, validateCommand, humanValidateResult } from './commands/validate.mjs';
import { parseStatusArgs, statusCommand, humanStatusResult } from './commands/status.mjs';
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

Interrupted pre-commit runs are not auto-resumed; restart against a fresh target.
`;

function stripCheckpointOptions(argv) {
  const checkpointOption = argv.find((value) => ['--checkpoint-dir', '--checkpoint-migration-id', '--checkpoint-artifact-sha256'].includes(value));
  if (checkpointOption !== undefined) throw new MigrationRefusal({ code: 'RMIG-E-CHECKPOINT', phase: 'runtime', summary: 'Checkpoint/resume is not a supported success path. Interrupted pre-commit runs must restart against a fresh target; do not reuse a partial target.', safe_details: { option: checkpointOption }, report_path: null });
  return { clean: argv, values: {} };
}
function recordCheckpoint(result) { return result; }
function applyCheckpointInputs(_command, args) { return args; }

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
    const [command, ...rawCommandArgs] = positionalArgv;
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

    const { clean: commandArgs } = stripCheckpointOptions(rawCommandArgs);
    maybeInjectCheckpointFault('__command-start__');
    if (runCommand !== undefined) return runCommand(command, commandArgs);
    if (command === 'export') {
      const parsed = parseExportArgs(commandArgs);
      return exportCommand(parsed).then((result) => {
        const checked = recordCheckpoint(result, 'bundle-finalized');
        if (json) writeStdout(`${canonicalJson(checked.manifest)}\n`);
        else writeStdout(humanExportResult(checked));
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
      const checked = recordCheckpoint(result, 'policy-compiled');
      writeStdout(json ? `${canonicalJson(checked)}\n` : humanCompilePolicyResult(checked));
      return 0;
    }
    if (['inspect-target', 'prepare-target', 'dry-run', 'import'].includes(command)) {
      return targetCommand(command, applyCheckpointInputs(command, commandArgs)).then((result) => {
        const checkpointName = command === 'prepare-target' ? 'target-prepared' : command === 'dry-run' ? 'dry-run-accepted' : command === 'import' ? 'import-committed' : 'source-inspected';
        const checked = recordCheckpoint(result, checkpointName);
        writeStdout(json ? `${canonicalJson(checked)}\n` : humanTargetResult(checked));
        return 0;
      });
    }
    if (command === 'plan-images') return planImagesCommand(parsePlanImagesArgs(commandArgs)).then((result) => { const checked = recordCheckpoint(result, 'source-inspected'); writeStdout(json ? `${canonicalJson(checked)}\n` : humanPlanImagesResult(checked)); return 0; });
    if (command === 'copy-images') return copyImagesCommand(parseCopyImagesArgs(commandArgs)).then((result) => { const checked = recordCheckpoint(result, 'images-complete'); writeStdout(json ? `${canonicalJson(checked)}\n` : humanCopyImagesResult(checked)); return 0; });
    if (command === 'plan-reembed') return Promise.resolve(planReembedCommand(parsePlanReembedArgs(commandArgs))).then((result) => { const checked = recordCheckpoint(result, 'reembed-complete'); writeStdout(json ? `${canonicalJson(checked)}\n` : humanPlanReembedResult(checked)); return 0; });
    if (command === 'validate') return Promise.resolve(validateCommand(parseValidateArgs(commandArgs))).then((result) => { const checked = recordCheckpoint(result, 'validation-complete'); writeStdout(json ? `${canonicalJson(checked)}\n` : humanValidateResult(checked)); return 0; });
    if (command === 'status') return Promise.resolve(statusCommand({ ...parseStatusArgs(commandArgs), operatorCutoverAcknowledged: commandArgs.includes('--operator-cutover-ack') })).then((result) => { writeStdout(json ? `${canonicalJson(result)}\n` : humanStatusResult(result)); return 0; });
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
      const checked = recordCheckpoint(report, 'source-inspected');
      if (json) writeStdout(`${canonicalJson(checked)}\n`);
      else writeStdout(humanInspectReport(checked, parsed.reportPath));
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
