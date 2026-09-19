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
    const error = new Error(
      `Node.js ${MINIMUM_NODE_MAJOR} or newer is required; received major ${String(nodeMajor)}.`,
    );
    error.code = 'RMIG-E-NODE-VERSION';
    throw error;
  }
}
