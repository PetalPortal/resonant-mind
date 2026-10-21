import { MigrationRefusal } from './refusal.mjs';

const MINIMUM_NODE_MAJOR = 22;

function currentNodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

export function assertNodeVersion(nodeMajor = currentNodeMajor()) {
  if (
    typeof nodeMajor !== 'number' ||
    !Number.isFinite(nodeMajor) ||
    !Number.isInteger(nodeMajor) ||
    nodeMajor < MINIMUM_NODE_MAJOR
  ) {
    throw new MigrationRefusal({
      code: 'RMIG-E-NODE-VERSION',
      phase: 'runtime',
      summary: `Node.js ${MINIMUM_NODE_MAJOR} or newer is required; received major ${String(nodeMajor)}.`,
      safe_details: {
        minimum_major: MINIMUM_NODE_MAJOR,
        received_major: typeof nodeMajor === 'number' && Number.isFinite(nodeMajor)
          ? nodeMajor
          : String(nodeMajor),
      },
      report_path: null,
    });
  }
}
