import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/style.css';
import TransferPending, { transferViewOwner } from '../../src/TransferPending';
import { unifiedFixture, unifiedAgreement, wire } from '../../src/transferUnifiedReconciliationFixtures';
import { parseSession } from '../../src/model';
import type { TransferAuthority } from '../../src/useInventory';

// E5, original A7/credit5: reused coherent public-codec fixture, NOT E10/D9/A8/R1.
const query = new URLSearchParams(location.search);
const actor = Number(query.get('actor'));
if (actor !== 1 && actor !== 2) throw new Error('actor must be 1 or 2');
const scene = query.get('scene') ?? 'proposal';
const f = scene === 'counterpart' ? unifiedAgreement('pending', '4', '3', '1', actor === 1 ? 2 : 1) : unifiedFixture();
const calls: { method: string; path: string; body: string | null }[] = [];
const failures: string[] = [];
let authority: TransferAuthority = { ready: true, epoch: 1, sessionGeneration: 1,
  session: parseSession(JSON.stringify({ authenticated: true, csrf_token: 'a'.repeat(43), expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: actor, username: 'synthetic', display_name: 'Synthetic', must_change_password: false,
      location: { id: actor, name: actor === 1 ? 'Warehouse' : 'Branch' } } })) };
const controller = { authorityEpoch: 1, getTransferAuthority: () => authority,
  subscribeTransferInvalidation: () => () => {},
  settleUnauthorized: async () => 'unavailable' as const };
// Real API adapters, codecs, caller, hook and recovery store consume this bounded transport.
// All POSTs intentionally lose their response without claiming any durable backend effect.
globalThis.fetch = async (input, init) => {
  const path = String(input), method = init?.method ?? 'GET';
  calls.push({ method, path, body: typeof init?.body === 'string' ? init.body : null });
  if (method === 'POST' && /^\/api\/transfers\/123\/unified-reconciliations\/(propose|accept|reject)$/.test(path)) {
    throw new TypeError('Synthetic lost reply');
  }
  let value: unknown;
  if (method === 'GET' && path === '/api/transfers/123/unified-reconciliations') value = f.raw;
  else if (method === 'GET' && path === '/api/transfers/123') value = f.record;
  else if (method === 'GET' && path.startsWith('/api/transfers/counts')) value = { pending_total: '0', action_count: '0' };
  else if (method === 'GET' && (path === '/api/transfers' || path.startsWith('/api/transfers?'))) {
    const params = new URL(path, location.origin).searchParams;
    value = { page: Number(params.get('page') ?? 1), page_size: Number(params.get('page_size') ?? 25), status: params.get('status') ?? 'all', total_count: '1', records: [f.record] };
  } else { failures.push(`${method} ${path}`); throw new Error('Unrecognized synthetic request'); }
  return new Response(wire(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
let switchAuthority = () => {};
Object.assign(window, { __UNIFIED: { calls, failures, baseline: { expected: '5', actual: '7', credit: '5' },
  switchAuthority: () => switchAuthority() } });
function Fixture() {
  const [, update] = useState(0);
  switchAuthority = () => { authority = { ...authority, epoch: authority.epoch + 1, ready: false }; update(n => n + 1); };
  const owner = `1/${actor}/${actor}`;
  return <main className="inventory-main"><TransferPending controller={controller} ownerTag={owner}
    initialDetail={{ ownerTag: transferViewOwner(authority) ?? owner, id: '123' }} onInventory={() => { throw new Error('Unexpected navigation'); }} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
