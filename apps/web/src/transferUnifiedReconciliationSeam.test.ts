// Opt-in integration: the parent supplies stdout from the real authenticated
// Go router harness. There is deliberately no copied fixture or fallback.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTransferRecord } from './transferModel';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';

const output = process.env.LUSON_UNIFIED_SEAM_STDOUT;
describe('actual Go HTTP → strict TS codec (requires LUSON_UNIFIED_SEAM_STDOUT)', () => {
  it('preserves original/legacy evidence and applies sample/prior-restoration accounting S3-S7', () => {
    if (!output) throw new Error('Run TestURHTTPCodecSeam and set LUSON_UNIFIED_SEAM_STDOUT to its captured stdout; no fixture fallback exists');
    const lines = readFileSync(output, 'utf8').split('\n').filter(l => l.startsWith('LUSON_UNIFIED_SEAM='));
    expect(lines).toHaveLength(1);
    const captures = JSON.parse(lines[0].slice('LUSON_UNIFIED_SEAM='.length));
    expect(captures.map((c: { name: string }) => c.name)).toEqual(['sample', 'prior-restoration']);
    for (const c of captures) {
      const record = parseTransferRecord(JSON.stringify(c.original));
      expect(record.status).toBe('received');
      if (record.status !== 'received') throw new Error('received context required');
      const contextBefore = JSON.stringify(c.original);
      const originalReceipt = record.receipt.items.map(i => ({ ...i }));
      const before = parseUnifiedReconciliations(JSON.stringify(c.before), record);
      const after = parseUnifiedReconciliations(JSON.stringify(c.after), record);
      expect(after.original).toEqual(before.original);
      expect(after.legacy).toEqual(before.legacy);
      expect(record.receipt.items).toEqual(originalReceipt);
      expect(JSON.stringify(c.original)).toBe(contextBefore);
      expect(before.current.every(l => l.owner === 'legacy' && l.source === 'legacy')).toBe(true);
      expect(before.operations).toEqual([]);
      expect(before.lines.every(l => l.proposals.length === 0)).toBe(true);
      const current = after.current.find(l => l.variant_id === 1)!;
      const proposal = after.lines.find(l => l.variant_id === 1)!.proposals[0];
      const prior = c.name === 'prior-restoration';
      expect(before.current.find(l => l.variant_id === 1)!.source_debit).toBe(prior ? 9n : 10n);
      expect(proposal.application?.source_delta).toBe(prior ? 0n : 1n);
      expect(proposal.application?.destination_delta).toBe(0n);
      expect(proposal.state).toBe('applied');
      expect(current).toMatchObject({ owner: 'unified', source: 'unified', effective_dispatch: 9n,
        effective_actual: 8n, effective_credit: 8n, source_debit: 9n, retained_quantity: 1n,
        origin_unknown: 0n, transit_unknown: 1n, excess: 0n });
      expect(after.legacy.restitution.lines.find(l => l.variant_id === 1)!.applied_retained_quantity).toBe(prior ? 1n : 0n);
      const unexpected = after.original.find(l => l.variant_id === 3)!;
      expect(unexpected).toMatchObject({ expected_quantity: 0n, actual_quantity: 7n, available_quantity: 0n });
      expect(after.current.find(l => l.variant_id === 3)).toEqual(before.current.find(l => l.variant_id === 3));
      expect(after.lines.some(l => l.variant_id === 3)).toBe(false);
      expect(after.current.find(l => l.variant_id === 2)).toEqual(before.current.find(l => l.variant_id === 2));
      expect(Object.isFrozen(after)).toBe(true);
      expect(Object.isFrozen(current)).toBe(true);
      expect(Object.isFrozen(proposal.application)).toBe(true);
      expect(Object.isFrozen(after.legacy.restitution.lines)).toBe(true);
    }
  });
});
