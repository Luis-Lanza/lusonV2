import { expect, it } from 'vitest';
import { transferActionLabels, transferActionCategoryLabels } from './transferActionView';

it('labels exactly the four remaining categories and no retired review meaning', () => {
  expect(transferActionLabels).toEqual({ approve: 'Aprobar o rechazar', dispatch: 'Despachar', receive: 'Recibir',
    review_unified_reconciliation: 'Revisar conciliación unificada' });
  expect(transferActionCategoryLabels).toEqual({ approve: 'Por aprobar', dispatch: 'Por despachar', receive: 'Por recibir',
    review_unified_reconciliation: 'Conciliaciones unificadas por revisar' });
  for (const retired of ['review_count', 'review_restitution', 'review_dispatch_reconciliation']) {
    expect(Reflect.get(transferActionLabels, retired)).toBeUndefined();
    expect(Reflect.get(transferActionCategoryLabels, retired)).toBeUndefined();
  }
});
