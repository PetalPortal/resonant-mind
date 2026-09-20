import { MigrationRefusal } from '../lib/refusal.mjs';
/** Provider-neutral object-store contract used by migration phases. */
export function assertObjectStore(store) {
  for (const method of ['inventory', 'openRead', 'put', 'verify']) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`Object store must implement ${method}().`);
  }
  return store;
}

export class ObjectStore {
  async inventory() { throw new Error('ObjectStore.inventory() is not implemented.'); }
  async openRead(_key) { throw new Error('ObjectStore.openRead() is not implemented.'); }
  async put(_key, _body, _metadata) { throw new Error('ObjectStore.put() is not implemented.'); }
  async verify(_key, _expected) { throw new Error('ObjectStore.verify() is not implemented.'); }
}

/**
 * Adapter boundary for a separately executed provider operation. Release one
 * deliberately has no Cloudflare dependency or credential/network path.
 */
export class ExternalReceiptObjectStore extends ObjectStore {
  constructor(receipt) { super(); this.receipt = receipt; }
  async inventory() { return this.receipt?.inventory ?? []; }
  async openRead() { throw new Error('External receipt stores are not readable locally.'); }
  async put() { throw new Error('External receipt stores cannot be written by release one.'); }
  async verify(key, expected = {}) {
    const found = this.receipt?.entries?.find((entry) => entry.key === key || entry.target_key === key);
    return Boolean(found && (!expected.sha256 || found.sha256 === expected.sha256) && (!expected.size || found.size === expected.size));
  }
}

export class R2ObjectStore extends ObjectStore {
  constructor() { super(); }
  refuse() { throw new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary: 'Release one does not access R2 directly; provide an external signed inventory/copy receipt.', safe_details: { adapter: 'r2', guide: 'docs/migration-from-mind-cloud.md' }, report_path: null }); }
  async inventory() { this.refuse(); }
  async openRead() { this.refuse(); }
  async put() { this.refuse(); }
  async verify() { this.refuse(); }
}

export async function createObjectStore({ adapter = 'filesystem', root, receipt } = {}) {
  if (adapter === 'filesystem') { const { FilesystemObjectStore } = await import('./filesystem-store.mjs'); return new FilesystemObjectStore(root); }
  if (adapter === 'external-receipt') return new ExternalReceiptObjectStore(receipt);
  if (adapter === 'r2') return new R2ObjectStore();
  throw new TypeError('Unknown object-store adapter.');
}