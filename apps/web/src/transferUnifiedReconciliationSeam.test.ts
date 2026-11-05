// Opt-in integration: the parent supplies stdout from the real authenticated Go router
// harness. There is deliberately no copied fixture or fallback, and the Go half is opt-in
// too: TestURHTTPCodecSeam skips unless LUSON_UNIFIED_SEAM_EXPORT=1 and an admitted
// fixture are present. Absent that artifact this suite skips rather than throwing, so the
// default run stays honest instead of permanently red on a clean checkout.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTransferRecord } from './transferModel';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';

const output = process.env.LUSON_UNIFIED_SEAM_STDOUT;
describe.skipIf(!output)('actual Go HTTP → strict TS codec (needs LUSON_UNIFIED_SEAM_STDOUT)', () => {
  it('preserves original/legacy evidence and applies sample/prior-restoration accounting S3-S7', () => {
    const lines = readFileSync(output!, 'utf8').split('\n').filter(l => l.startsWith('LUSON_UNIFIED_SEAM='));
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
      // Variant 3 is a dispatched line in the current sample, not an unexpected one:
      // the codec must keep the original receipt quantities exactly, and must invent no
      // reconciliation work for a variant whose received quantity matches the dispatch.
      const originalLine = record.receipt.items.find(item => item.variant_id === 3)!;
      const untouched = after.original.find(l => l.variant_id === 3)!;
      expect(untouched).toMatchObject({
        expected_quantity: originalLine.expected_quantity,
        actual_quantity: originalLine.actual_quantity,
        available_quantity: originalLine.available_quantity,
      });
      expect(after.current.find(l => l.variant_id === 3)).toEqual(before.current.find(l => l.variant_id === 3));
      // A dispatched variant whose quantities match carries no reconciliation proposal
      // and never becomes unified, so the codec must not invent work for it.
      expect(after.lines.find(l => l.variant_id === 3)!.proposals).toHaveLength(0);
      expect(after.current.find(l => l.variant_id === 3)!.owner).toBe('legacy');
      expect(after.current.find(l => l.variant_id === 2)).toEqual(before.current.find(l => l.variant_id === 2));
      expect(Object.isFrozen(after)).toBe(true);
      expect(Object.isFrozen(current)).toBe(true);
      expect(Object.isFrozen(proposal.application)).toBe(true);
      expect(Object.isFrozen(after.legacy.restitution.lines)).toBe(true);
    }
  });
});
