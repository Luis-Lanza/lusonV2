import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';
import { unifiedAgreement, wire } from './transferUnifiedReconciliationFixtures';
import TransferUnifiedReconciliationHistory from './TransferUnifiedReconciliationHistory';

describe('unified reconciliation audit', () => {
  it.each(['pending', 'rejected', 'applied'] as const)('separates original and current evidence for %s', state => {
    const f = unifiedAgreement(state);
    const snapshot = parseUnifiedReconciliations(wire(f.raw), f.record);
    render(<TransferUnifiedReconciliationHistory snapshot={snapshot} />);
    const history = screen.getByRole('region', { name: 'Historial de conciliación unificada' });
    expect(within(history).getAllByText(/Declaradas originalmente: 5/).length).toBeGreaterThan(0);
    expect(within(history).getAllByText(/Recibidas originalmente: 7/).length).toBeGreaterThan(0);
    expect(within(history).getAllByText(state === 'applied' ? 'Acuerdo vigente' : 'Sin acuerdo unificado aplicado')).toHaveLength(state === 'applied' ? 1 : snapshot.lines.length);
    expect(within(history).getByText({ pending: 'Pendiente de contraparte', rejected: 'Rechazada · sin aplicación',
      applied: 'Aplicada atómicamente' }[state])).toBeInTheDocument();
    expect(within(history).getByText(/Salieron: 4 · Llegaron: 3 · Retenidas: 1/)).toBeInTheDocument();
    expect(within(history).queryByRole('button')).not.toBeInTheDocument();
  });
  it('does not fabricate missing evidence', () => {
    const { container } = render(<TransferUnifiedReconciliationHistory snapshot={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
