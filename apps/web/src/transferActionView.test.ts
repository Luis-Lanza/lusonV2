import { expect, it } from 'vitest';
import { transferActionLabels, transferActionCategoryLabels } from './transferActionView';

it('labels unified reviews distinctly without changing existing review meanings', () => {
  expect(Reflect.get(transferActionLabels, 'review_unified_reconciliation')).toBe('Revisar conciliación unificada');
  expect(Reflect.get(transferActionCategoryLabels, 'review_unified_reconciliation')).toBe('Conciliaciones unificadas por revisar');
  expect(transferActionLabels).toMatchObject({ approve: 'Aprobar o rechazar', dispatch: 'Despachar', receive: 'Recibir',
    review_count: 'Revisar conteo', review_restitution: 'Revisar restitución', review_dispatch_reconciliation: 'Revisar regularización' });
});
