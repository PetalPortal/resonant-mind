// The command list and every command's options, in one place, so --help cannot drift from the parsers
// (a test checks each option listed here against the command's own parser).

export const COMMAND_GROUPS = Object.freeze([
  ['Source and bundle', [
    ['inspect-source', ['--source-kind postgres|sqlite|d1-export', '--source <env:NAME | path>', '--report <file>']],
    ['export', ['--source-kind postgres|sqlite|d1-export', '--source <env:NAME | path>', '--migration-id <id>', '--bundle <dir>', '[--source-report <file>]', '[--source-fingerprint <sha256>]', '[--passphrase-file <file>]', '[--allow-plaintext-bundle --acknowledge-plaintext-risk]']],
    ['verify-bundle', ['--bundle <dir>', '[--passphrase-file <file>]']],
  ]],
  ['Decisions and plan', [
    ['draft-decisions', ['--bundle <dir>', '--out <file>', '[--passphrase-file <file>]']],
    ['apply-decisions', ['--bundle <dir>', '--decisions <edited draft>', '--reviewed-by <name>', '--out <file>', '[--passphrase-file <file>]']],
    ['compile-policy', ['--bundle <dir>', '--decisions <reviewed file>', '--out <file>', '[--passphrase-file <file>]']],
    ['plan-relational', ['--bundle <dir>', '--compiled-policy <file>', '--out <file>', '[--passphrase-file <file>]']],
  ]],
  ['Fresh v4 target', [
    ['inspect-target', ['--target <env:NAME>', '--source <env:NAME | path>', '[--source-kind postgres|sqlite|d1-export]']],
    ['prepare-target', ['--target <env:NAME>', '--source <env:NAME | path>', '[--source-kind postgres|sqlite|d1-export]', '--migration-id <id>', '--bundle-manifest-sha256 <sha256>', '--compiled-policy-sha256 <sha256>', '[--plan <file>]']],
    ['dry-run', ['--target <env:NAME>', '--plan <file>', '--staging-schema <name>', '--receipt-out <file>']],
    ['import', ['--target <env:NAME>', '--plan <file>', '--dry-run <dry-run receipt>', '--staging-schema <name>', '--receipt-out <file>']],
  ]],
  ['Images and re-embedding (external work)', [
    ['plan-images', ['(--input <inventory file> | --source <dir>)', '--out <file>', '--migration-id <id>', '[--bundle-manifest-sha256 <sha256>]', '[--compiled-policy-sha256 <sha256>]']],
    ['copy-images', ['--plan <file>', '--adapter filesystem|r2', '--receipt-out <file>', '[--source <dir> --target <dir>]', '[--external-receipt <file> --trusted-public-key <file>]']],
    ['plan-reembed', ['--input <relational plan>', '--migration-id <id>', '--out <file>', '[--images <image plan>]', '[--bundle-manifest-sha256 <sha256>]', '[--compiled-policy-sha256 <sha256>]']],
  ]],
  ['Validation', [
    ['validate', ['--bundle <dir>', '--decisions <reviewed file>', '--plan <file>', '--source-kind postgres|sqlite|d1-export', '--source <env:NAME | path>', '--target <env:NAME>', '--migration-id <id>', '--dry-run-receipt <file>', '--import-receipt <file>', '--out <file>', '[--passphrase-file <file>]', '[--image-plan <file> --image-receipt <file>]', '[--reembed-plan <file> --reembed-receipts <file>]', '[--trusted-public-key <file>]']],
    ['status', ['--report <validation report>', '[--cutover-evidence <file>]', '[--operator-cutover-ack]']],
  ]],
]);

export const COMMANDS = Object.freeze(COMMAND_GROUPS.flatMap(([, commands]) => commands.map(([name]) => name)));

function renderCommand(name, options, width) {
  const lines = [];
  let line = `  ${name.padEnd(width)}`;
  const indent = ' '.repeat(line.length);
  for (const option of options) {
    if (line.length + option.length + 1 > 110 && line.trim() !== '') { lines.push(line.replace(/\s+$/u, '')); line = indent; }
    line += `${line.endsWith(' ') ? '' : ' '}${option}`;
  }
  lines.push(line.replace(/\s+$/u, ''));
  return lines.join('\n');
}

const WIDTH = Math.max(...COMMANDS.map((name) => name.length)) + 1;

export function usageFor(command) {
  for (const [, commands] of COMMAND_GROUPS) for (const [name, options] of commands) if (name === command) return `Usage: npm run migrate:v32 -- ${command} [--json]\n\n${renderCommand(name, options, WIDTH)}\n\nOptions in [brackets] are optional. A connection is always an env:NAME reference; a passphrase is always a file.\n`;
  return undefined;
}

export function fullHelp() {
  const sections = COMMAND_GROUPS.map(([title, commands]) => `${title}\n${commands.map(([name, options]) => renderCommand(name, options, WIDTH)).join('\n')}`);
  return `Usage: npm run migrate:v32 -- <command> [options] [--json]
       npm run migrate:v32 -- <command> --help

A connection is always an env:NAME reference to an environment variable (never a URL, password or token on
the command line); a passphrase is always a file (--passphrase-file). Options in [brackets] are optional.
--json prints the result, or the structured refusal, as JSON on stdout.

${sections.join('\n\n')}

Interrupted pre-commit runs are not auto-resumed; restart against a fresh target.
`;
}
