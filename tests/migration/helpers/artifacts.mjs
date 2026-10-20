import { readArtifact } from '../../../scripts/v32-to-v4/commands/artifacts.mjs';

/** Opens a compiled policy or relational plan the way the commands do: encrypted with the passphrase file, or plaintext JSON. */
export function readArtifactFile(path, kind, passphraseFile) {
  return readArtifact('validate', path, 'The artifact', { kind, passphraseFile });
}
