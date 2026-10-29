import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import TransferCountCorrections, { type TransferCountCorrectionsProps } from './TransferCountCorrections';
import { parseSession } from './model';
import type { TransferAuthority, TransferController } from './useInventory';
import type { CountCorrectionLine, CountProposal } from './transferCountCorrectionModel';
import { createTransferCountCorrectionRecovery, type CountCorrectionAttempt } from './transferCountCorrectionRecovery';
import { TransferAPIError } from './transferAPI';

const stamp = '2026-04-02T00:00:00.000000001Z';
const big = 9007199254740993n;
function line(variant_id = 201): CountCorrectionLine {
  return { variant_id, expected_quantity: variant_id === 201 ? big : 0n,
    effective_dispatch: variant_id === 201 ? big : 0n, reconciliation_revision: 0n, actual_quantity: big, available_quantity: big,
    workflow_revision: 4n, applied_revision: 3n, effective_actual: 5n, effective_credit: 5n, proposals: [] };
}
function proposal(state: CountProposal['state'] = 'pending', initiator = 2): CountProposal {
  return { revision: 4n, operation_key: 'proposal_key_0001', initiator_location_id: initiator as 2 | 3,
    actual_quantity: 7n, base_revision: 3n, base_credit: 5n, reason: 'Reconteo original', recorded_at: stamp, state,
    decision: state === 'applied' || state === 'rejected' ? { operation_key: 'decision_key_0001', actor_location_id: 3,
      accepted: state === 'applied', reason: 'Decisión exacta', recorded_at: stamp } : null,
    application: state === 'applied' ? { effective_credit: 7n, delta: 2n, recorded_at: stamp } : null };
}
function fixture(actor = 2) {
  const authority: TransferAuthority = { ready: true, epoch: 1, sessionGeneration: 1,
    session: parseSession(JSON.stringify({ authenticated: true, csrf_token: 'c'.repeat(43), expires_at: '2030-01-01T00:00:00Z',
      identity: { account_id: actor === 1 ? 1 : 2, username: 'synthetic', display_name: 'Operador de conteo', must_change_password: false,
        location: { id: actor, name: 'Asignada' } } })) };
  const listeners = new Set<() => void>();
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  // Writable injected view models changes that real hook getters expose.
  const corrections: { -readonly [K in keyof TransferCountCorrectionsProps['corrections']]: TransferCountCorrectionsProps['corrections'][K] } = { snapshot: { request_id: 1n, lines: [line()], operations: [] },
    busy: false, error: null, masked: false, attempts: [], refresh: vi.fn(async () => {}),
    propose: vi.fn(async () => {}), decide: vi.fn(async () => {}), retry: vi.fn(async () => {}), recover: vi.fn(async () => {}) };
  const props: TransferCountCorrectionsProps = { controller, corrections, requestID: '1', record: {
    id: '1', reference: 'TR-001', kind: 'request_stock', status: 'received', created_at: stamp,
    creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 3, origin_location_name: 'Sucursal B',
    destination_location_id: 2, destination_location_name: 'Sucursal A', approver_location_id: 1, approver_location_name: 'Almacén',
    decision_location_id: 1, decided_at: stamp, dispatch_location_id: 3, dispatched_at: stamp,
    receipt_location_id: 2, received_at: stamp, receipt: { items: [{ variant_id: 201, expected_quantity: big,
      actual_quantity: big, available_quantity: big }], exceptions: [] },
    items: [{ variant_id: 201, brand: 'TOYO', model: 'Exact', capacity_ah: '75.125', polarity: 'L', quantity: big }] } };
  return { props, authority, corrections, controller, hint: () => { for (const l of listeners) l(); } };
}
function draft(actual = '9007199254740994', reason = '  Conteo exacto  ') {
  fireEvent.click(screen.getByRole('button', { name: 'Proponer corrección' }));
  fireEvent.change(screen.getByLabelText('Cantidad corregida'), { target: { value: actual } });
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: reason } });
}
function review() { fireEvent.click(screen.getByRole('button', { name: /^Revisar (corrección|aceptación|rechazo)$/ })); return screen.getByRole('dialog'); }
const decisionReason = () => screen.getByRole('textbox', { name: /^Motivo de (aceptación|rechazo)/ });
it.each([['7', '8', '7', '0'], ['6', '8', '6', '-1'], ['0', '8', '0', '-7']] as const)(
  'T4c caps preview at current dispatch %s, not original five', (dispatch, actual, credit, delta) => {
    const f = fixture(); f.props.record.items[0].quantity = 5n;
    Object.assign(f.corrections.snapshot!.lines[0], { expected_quantity: 5n, effective_dispatch: BigInt(dispatch),
      reconciliation_revision: 1n, effective_actual: 7n, effective_credit: 7n });
    render(<TransferCountCorrections {...f.props} />); draft(actual); const modal = review();
    expect(within(modal).getByRole('row', { name: `Crédito de esta recepción 7 ${credit}` })).toBeVisible();
    expect(modal).toHaveTextContent(`Efecto en destino: ${delta}`);
    expect(f.corrections.propose).not.toHaveBeenCalled(); expect(f.corrections.decide).not.toHaveBeenCalled();
  });
it.each((['propose', 'accept'] as const).flatMap(action => (['effective_dispatch', 'reconciliation_revision'] as const).map(field => ({ action, field }))))(
  'T4c retires $action review on $field changes without a count revision', ({ action, field }) => {
  const f = fixture(action === 'accept' ? 3 : 2); const confirmed = f.corrections.snapshot!.lines[0];
  Object.assign(confirmed, { effective_dispatch: 7n, reconciliation_revision: 1n,
    proposals: action === 'accept' ? [proposal()] : [] });
  render(<TransferCountCorrections {...f.props} />);
  if (action === 'propose') draft('8');
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar propuesta' }));
    fireEvent.change(decisionReason(), { target: { value: 'checked' } });
  }
  const modal = review(); Object.assign(confirmed, { [field]: confirmed[field] + 1n });
  fireEvent.click(within(modal).getByRole('button', { name: action === 'propose' ? 'Enviar propuesta' : 'Confirmar aceptación' }));
  expect(f.corrections.propose).not.toHaveBeenCalled(); expect(f.corrections.decide).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('El conteo cambió');
});
it.each(['effective_dispatch', 'reconciliation_revision'] as const)('T4c permits rejection without acceptance-only %s evidence', async field => {
  const f = fixture(3); Object.assign(f.corrections.snapshot!.lines[0], { proposals: [proposal()], [field]: undefined });
  render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  expect(screen.getByRole('button', { name: 'Aceptar propuesta' })).toBeDisabled();
  expect(screen.getByRole('dialog')).toHaveTextContent('No disponible');
  fireEvent.click(screen.getByRole('button', { name: 'Rechazar propuesta' }));
  fireEvent.change(decisionReason(), { target: { value: 'No acuerdo' } }); review();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirmar rechazo' })));
  expect(f.corrections.decide).toHaveBeenCalledExactlyOnceWith('reject', expect.objectContaining({ reason: 'No acuerdo', expected_revision: '4' }));
  expect(f.corrections.propose).not.toHaveBeenCalled(); expect(f.corrections.retry).not.toHaveBeenCalled();
});
it('uses one shared management table and plain empty history rather than product cards', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />);
  const table = screen.getByRole('table', { name: 'Gestión de conteo' });
  expect(within(table).getAllByRole('columnheader').map(h => h.textContent)).toEqual([
    'Producto', 'Conteo vigente', 'Crédito en destino', 'Historial', 'Acción',
  ]);
  const row = within(table).getByRole('rowgroup', { name: 'TOYO · Exact · 75.125 Ah · L' });
  expect(within(row).getByText('Sin correcciones')).toBeVisible();
  expect(within(row).queryByRole('button', { name: /Historial/ })).toBeNull();
  expect(row.querySelector('details')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Conteo efectivo confirmado' })).toHaveClass('sr-only');
  expect(screen.queryByRole('article')).toBeNull();
});
it('shows proven before counts and keeps application evidence behind revision detail', () => {
  const f = fixture();
  Object.assign(f.corrections.snapshot!.lines[0], { proposals: [{ ...proposal('applied'), revision: 3n, base_revision: 0n }, proposal()] });
  render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Historial completo · 2 revisiones' }));
  const history = screen.getByRole('table', { name: 'Historial de TOYO · Exact · 75.125 Ah · L' });
  expect(within(history).getByText(`${big} → 7`)).toBeVisible();
  expect(within(history).getByText('7 → 7')).toBeVisible();
  expect(within(history).getByText(/Aplicación: crédito 7/)).not.toBeVisible();
  fireEvent.click(within(history).getByRole('button', { name: 'Ver detalle de revisión 3' }));
  expect(within(history).getByText(/Aplicación: crédito 7/)).toBeVisible();
  expect(within(history).getByText('Motivo de decisión: Decisión exacta')).toBeVisible();
  for (const method of ['refresh', 'recover', 'retry', 'propose', 'decide'] as const) expect(f.corrections[method]).not.toHaveBeenCalled();
});
it('describes the received correction context with a flow-neutral transfer noun', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />);
  expect(within(screen.getByRole('region', { name: 'Correcciones de conteo' })).getByText(
    'La recepción original es inmutable. La transferencia sigue Recibida; estas correcciones conservan su evidencia original.')).toBeVisible();
});
it.each(['accept', 'reject'] as const)('captures approved %s evidence, admission and separate reasons within consultation', action => {
  const f = fixture(3); const key = vi.spyOn(crypto, 'getRandomValues');
  const original = '  Original\n  propuesta  '; const raw = ' \u00a0🙂 decisión\t ';
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [{ ...proposal(), reason: original }] }] };
  render(<><button>Outside</button><TransferCountCorrections {...f.props} /></>);
  const trigger = screen.getByRole('button', { name: 'Consultar propuesta' }); fireEvent.click(trigger);
  const modal = screen.getByRole('dialog');
  const enter = (branch: 'accept' | 'reject') => fireEvent.click(screen.getByRole('button', { name: branch === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta' }));
  const back = () => fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
  enter(action);
  expect(screen.getByRole('dialog')).toBe(modal);
  expect(modal).toHaveAccessibleName(`${action === 'accept' ? 'Aceptar' : 'Rechazar'} propuesta de conteo`);
  expect(modal).toHaveTextContent('TR-001 · Propuesta de Sucursal A'); expect(modal).toHaveTextContent('Decisión de Sucursal B');
  expect(modal).toHaveTextContent(`Enviadas: ${big}`);
  expect(within(modal).getByRole('row', { name: 'Cantidad recibida 5 7' })).toBeInTheDocument();
  expect(within(modal).getByRole('row', { name: 'Crédito de esta recepción 5 7' })).toBeInTheDocument();
  expect(modal.querySelector('.count-review-reason')?.textContent).toBe(original);
  expect(decisionReason()).toHaveValue(''); expect(decisionReason()).toHaveFocus();
  expect(within(modal).getAllByRole('textbox')).toHaveLength(1); expect(within(modal).queryByRole('checkbox')).toBeNull();
  expect(decisionReason()).toHaveAttribute('placeholder', `Explicá por qué ${action === 'accept' ? 'aceptás' : 'rechazás'} esta corrección`);
  const admission = screen.getByRole('button', { name: action === 'accept' ? 'Revisar aceptación' : 'Revisar rechazo' });
  for (const invalid of ['', '   ', '\0', 'x'.repeat(2001), '\ud800']) {
    fireEvent.change(decisionReason(), { target: { value: invalid } }); expect(admission).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Editar corrección' }));
    expect(screen.queryByRole('button', { name: /Confirmar (aceptación|rechazo)/ })).toBeNull();
  }
  expect(key).not.toHaveBeenCalled();
  fireEvent.change(decisionReason(), { target: { value: '\u00a0' } }); expect(admission).toBeEnabled();
  fireEvent.change(decisionReason(), { target: { value: raw } }); expect(admission).toBeEnabled();
  back(); expect(screen.getByRole('dialog')).toBe(modal);
  expect(screen.getByRole('heading', { name: 'Propuesta de corrección de conteo' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveAttribute('inert');
  enter(action); expect(decisionReason()).toHaveValue(raw); back();
  enter(action === 'accept' ? 'reject' : 'accept'); expect(decisionReason()).toHaveValue('');
  fireEvent.change(decisionReason(), { target: { value: 'Opposite private reason' } }); back();
  enter(action); expect(decisionReason()).toHaveValue(raw); back();
  enter(action === 'accept' ? 'reject' : 'accept'); expect(decisionReason()).toHaveValue('Opposite private reason'); back();
  expect(key).not.toHaveBeenCalled(); enter(action); review();
  expect(key).toHaveBeenCalledTimes(1); expect(modal.querySelector('.count-decision-reason')?.textContent).toBe(raw);
  expect(f.corrections.decide).not.toHaveBeenCalled(); expect(f.corrections.refresh).not.toHaveBeenCalled();
  fireEvent.keyDown(modal, { key: 'Escape' }); expect(trigger).toHaveFocus();
  fireEvent.click(trigger); enter(action); expect(decisionReason()).toHaveValue(''); back();
  enter(action === 'accept' ? 'reject' : 'accept'); expect(decisionReason()).toHaveValue('');
  key.mockRestore();
});
it.each(['accept', 'reject'] as const)('reviews pinned %s evidence and edits raw reason with a fresh identity', async action => {
  const user = userEvent.setup(); const f = fixture(3); const key = vi.spyOn(crypto, 'getRandomValues');
  const raw = ' \u00a0🙂 decisión\t '; const original = '  Original\n propuesta  ';
  Object.assign(f.corrections.snapshot!.lines[0], { proposals: [{ ...proposal(), reason: original }] });
  render(<><button>Outside</button><TransferCountCorrections {...f.props} /></>);
  const trigger = screen.getByRole('button', { name: 'Consultar propuesta' }); fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta' }));
  fireEvent.change(decisionReason(), { target: { value: raw } }); const modal = review();
  expect(modal).toHaveAccessibleName(`Confirmar ${action === 'accept' ? 'aceptación' : 'rechazo'} de conteo`);
  expect(modal).toHaveTextContent('TR-001 · Propuesta de Sucursal A'); expect(modal).toHaveTextContent('Decisión de Sucursal B');
  expect(modal).toHaveTextContent(`Enviadas: ${big}`);
  expect(within(modal).getByRole('row', { name: 'Cantidad recibida 5 7' })).toBeInTheDocument();
  expect(within(modal).getByRole('row', { name: 'Crédito de esta recepción 5 7' })).toBeInTheDocument();
  expect(within(modal).getByRole('columnheader', { name: action === 'accept' ? 'Al aceptar' : 'Propuesto' })).toBeInTheDocument();
  expect(modal.querySelector('.count-review-reason')?.textContent).toBe(original);
  expect(modal.querySelector('.count-decision-reason')?.textContent).toBe(raw);
  expect(within(modal).queryByRole('textbox')).toBeNull(); expect(within(modal).queryByRole('checkbox')).toBeNull();
  expect(modal).toHaveTextContent(action === 'accept' ? 'Efecto en destino: +2' : 'La cantidad propuesta no se aplicará.');
  expect(modal).toHaveTextContent('La recepción original se conserva.');
  expect(modal).toHaveTextContent('El crédito no es inventario actual.');
  const technical = within(modal).getByText('Evidencia técnica de la decisión').closest('details')!;
  expect(technical).not.toHaveAttribute('open');
  const identity = technical.textContent; const edit = within(modal).getByRole('button', { name: 'Editar motivo' });
  expect(edit).toHaveFocus();
  await user.tab({ shift: true }); expect(within(modal).getByText('Evidencia técnica de la decisión')).toHaveFocus();
  await user.tab(); expect(edit).toHaveFocus();
  fireEvent.keyDown(modal, { key: 'Escape', keyCode: 229 }); expect(modal).toBeInTheDocument();
  fireEvent.click(edit); expect(screen.getByRole('dialog')).toBe(modal);
  expect(decisionReason()).toHaveValue(raw); expect(decisionReason()).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveAttribute('inert');
  expect(modal).not.toHaveTextContent('Evidencia técnica de la decisión'); expect(key).toHaveBeenCalledTimes(1);
  review(); expect(key).toHaveBeenCalledTimes(2);
  expect(within(modal).getByText('Evidencia técnica de la decisión').closest('details')!.textContent).not.toBe(identity);
  expect(modal.querySelector('.count-decision-reason')?.textContent).toBe(raw);
  fireEvent.click(within(modal).getByRole('button', { name: 'Editar motivo' }));
  fireEvent.click(within(modal).getByRole('button', { name: 'Volver' }));
  fireEvent.click(within(modal).getByRole('button', { name: action === 'accept' ? 'Rechazar propuesta' : 'Aceptar propuesta' }));
  expect(decisionReason()).toHaveValue('');
  fireEvent.change(decisionReason(), { target: { value: 'Other branch private' } });
  fireEvent.click(within(modal).getByRole('button', { name: 'Volver' }));
  fireEvent.click(within(modal).getByRole('button', { name: action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta' }));
  expect(decisionReason()).toHaveValue(raw); review();
  expect(f.corrections.decide).not.toHaveBeenCalled(); expect(f.corrections.propose).not.toHaveBeenCalled();
  expect(f.corrections.refresh).not.toHaveBeenCalled(); expect(f.corrections.recover).not.toHaveBeenCalled();
  fireEvent.keyDown(modal, { key: 'Escape' }); expect(trigger).toHaveFocus();
  fireEvent.click(trigger); fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Rechazar propuesta' : 'Aceptar propuesta' }));
  expect(decisionReason()).toHaveValue(''); key.mockRestore();
});
it.each(['accept', 'reject'] as const)('T4c preserves submitting only the freshly prepared %s identity after editing', async action => {
  const f = fixture(3); Object.assign(f.corrections.snapshot!.lines[0], { proposals: [proposal()] });
  const view = render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta' }));
  fireEvent.change(decisionReason(), { target: { value: '  First raw 🙂  ' } }); const modal = review();
  const oldKey = within(modal).getByText(/^Clave /).textContent!.slice(6);
  fireEvent.click(within(modal).getByRole('button', { name: 'Editar motivo' }));
  const raw = ' \u00a0 Edited\t🙂  '; fireEvent.change(decisionReason(), { target: { value: raw } }); review();
  const newKey = within(modal).getByText(/^Clave /).textContent!.slice(6); expect(newKey).not.toBe(oldKey);
  Object.assign(f.props.record, { reference: 'Changed live reference', destination_location_name: 'Changed live location' });
  view.rerender(<TransferCountCorrections {...f.props} />);
  expect(modal).toHaveTextContent('TR-001 · Propuesta de Sucursal A'); expect(modal).not.toHaveTextContent('Changed live');
  await act(async () => fireEvent.click(within(modal).getByRole('button', { name: action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo' })));
  expect(f.corrections.decide).toHaveBeenCalledExactlyOnceWith(action, {
    variant_id: 201, expected_revision: '4', operation_key: newKey, reason: raw });
  expect(f.corrections.refresh).not.toHaveBeenCalled();
});
const staleReviewMutations = ['owner', 'request', 'record', 'snapshot', 'quantity', 'reason', 'key', 'actual', 'credit', 'workflow', 'applied', 'busy', 'mask', 'uncertain', 'initiator', 'base', 'baseCredit', 'stamp', 'removed', 'requestPin', 'membership'] as const;
// 2 actions × 2 render modes × 2 operations × 21 mutations = 168 independent cases.
it.each((['accept', 'reject'] as const).flatMap(action => [false, true].flatMap(rerender =>
  ['Editar motivo', action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo'].flatMap(operation =>
    staleReviewMutations.map(mutation => ({ action, rerender, operation, mutation }))))))(
  'refuses stale $action review (render=$rerender) at $operation [mutation=$mutation]', ({ action, rerender, operation, mutation }) => {
    const f = fixture(3); const pending = proposal(); const confirmed = { ...line(), proposals: [pending] };
    Object.assign(f.corrections.snapshot!, { lines: [confirmed] }); const view = render(<TransferCountCorrections {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
    fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta' }));
    fireEvent.change(decisionReason(), { target: { value: '  Private raw  ' } }); const modal = review();
    const button = within(modal).getByRole('button', { name: operation });
    const key = vi.spyOn(crypto, 'getRandomValues');
    if (mutation === 'owner') f.authority.sessionGeneration = 2;
    if (mutation === 'request') Object.assign(f.props.record, { id: '2' });
    if (mutation === 'record') {
      if (rerender) f.props.record = { ...f.props.record };
      else Object.assign(f.props.record, { status: 'approved' });
    }
    if (mutation === 'snapshot') f.corrections.snapshot = { ...f.corrections.snapshot! };
    if (mutation === 'quantity') Object.assign(pending, { actual_quantity: 9n });
    if (mutation === 'reason') Object.assign(pending, { reason: 'Replacement' });
    if (mutation === 'key') Object.assign(pending, { operation_key: 'replacement_key' });
    if (mutation === 'actual') confirmed.effective_actual++;
    if (mutation === 'credit') confirmed.effective_credit++;
    if (mutation === 'workflow') confirmed.workflow_revision++;
    if (mutation === 'applied') confirmed.applied_revision++;
    if (mutation === 'busy') f.corrections.busy = true;
    if (mutation === 'mask') f.corrections.masked = true;
    if (mutation === 'uncertain') f.corrections.attempts = [attempt('uncertain')];
    if (mutation === 'initiator') Object.assign(pending, { initiator_location_id: 3 });
    if (mutation === 'base') Object.assign(pending, { base_revision: 2n });
    if (mutation === 'baseCredit') Object.assign(pending, { base_credit: 4n });
    if (mutation === 'stamp') Object.assign(pending, { recorded_at: 'changed' });
    if (mutation === 'removed') confirmed.proposals = [];
    if (mutation === 'requestPin') Object.assign(f.corrections.snapshot!, { request_id: 2n });
    if (mutation === 'membership' && f.props.record.status === 'received') Object.assign(f.props.record.receipt, { items: [] });
    if (rerender) {
      view.rerender(<TransferCountCorrections {...f.props} />);
      expect(screen.queryByRole('button', { name: 'Editar motivo' }), mutation).toBeNull();
      expect(screen.queryByRole('button', { name: /Confirmar (aceptación|rechazo)/ }), mutation).toBeNull();
    } else fireEvent.click(button);
    expect(screen.queryByRole('textbox'), mutation).toBeNull();
    expect(f.corrections.decide, mutation).not.toHaveBeenCalled(); expect(key, mutation).not.toHaveBeenCalled();
    expect(f.corrections.refresh, mutation).not.toHaveBeenCalled(); key.mockRestore(); view.unmount();
});
it.each([
  { actual: 1n, credit: 1n, delta: '-1', unexpected: false },
  { actual: 9n, credit: 2n, delta: '0', unexpected: false },
  { actual: 9n, credit: 0n, delta: '0', unexpected: true },
])('keeps final decision stock/credit semantics for $actual (audit=$unexpected)', ({ actual, credit, delta, unexpected }) => {
  for (const action of ['accept', 'reject'] as const) {
    const f = fixture(3); f.props.record.items = unexpected ? [] : [{ ...f.props.record.items[0], quantity: 2n }];
    const dispatch = unexpected ? 0n : 2n;
    // An unreconciled dispatch of two cannot have current credit five.
    const receipt = { variant_id: 201, expected_quantity: dispatch, actual_quantity: 2n, available_quantity: dispatch };
    if (f.props.record.status !== 'received') throw new Error('received fixture');
    f.props.record.receipt = { items: [receipt], exceptions: unexpected ? [{ variant_id: 201, kind: 'unexpected', quantity: 2n }] : [] };
    Object.assign(f.corrections.snapshot!.lines[0], { ...receipt, effective_dispatch: dispatch, reconciliation_revision: 0n,
      effective_actual: 2n, effective_credit: dispatch,
      proposals: [{ ...proposal(), actual_quantity: actual, base_credit: dispatch }] });
    const view = render(<TransferCountCorrections {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
    fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta' }));
    fireEvent.change(decisionReason(), { target: { value: '  Verified reason  ' } }); const modal = review();
    expect(within(modal).getByRole('row', { name: `Crédito de esta recepción ${dispatch} ${credit}` })).toBeInTheDocument();
    expect(modal).toHaveTextContent(`Efecto en destino: ${action === 'reject' ? '0' : delta}`);
    if (action === 'reject') {
      expect(modal).toHaveTextContent('Sin cambios en el conteo efectivo ni en el stock.');
      expect(modal).not.toHaveTextContent('El faltante permanece');
    } else expect(modal).toHaveTextContent('si las validaciones del sistema son satisfactorias');
    if (unexpected) expect(modal).toHaveTextContent('Solo auditoría: crédito y efecto cero.');
    expect(f.corrections.decide).not.toHaveBeenCalled(); view.unmount();
  }
});
it('keeps count evidence secondary while exposing the exact pending reason before consultation', () => {
  const f = fixture(3); const raw = '  Original\n\n  pendiente 🙂  ';
  Object.assign(f.corrections.snapshot!.lines[0], { proposals: [
    { ...proposal('applied'), revision: 3n }, { ...proposal(), reason: raw },
  ] });
  const before = structuredClone(f.corrections.snapshot);
  render(<TransferCountCorrections {...f.props} />);
  const card = screen.getByRole('rowgroup', { name: 'TOYO · Exact · 75.125 Ah · L' });
  const reason = card.querySelector('.count-pending .count-evidence');
  expect(reason?.textContent).toBe(raw); expect(reason).toBeVisible();
  const historyToggle = within(card).getByRole('button', { name: 'Historial completo · 2 revisiones' });
  const history = document.getElementById(historyToggle.getAttribute('aria-controls')!)!;
  const effect = within(card).getByText('Efecto aplicado en destino: +2');
  const technical = within(card).getByText('Evidencia técnica del conteo');
  expect(effect.closest('.count-history-disclosure')).toBe(history);
  expect(technical.closest('.count-history-disclosure')).toBe(history);
  expect(effect).not.toBeVisible(); expect(technical).not.toBeVisible();
  fireEvent.click(historyToggle);
  expect(effect).not.toBeVisible(); expect(technical).toBeVisible();
  fireEvent.click(within(card).getByRole('button', { name: 'Ver detalle de revisión 3' }));
  expect(effect).toBeVisible();
  expect(history).toHaveTextContent('Aplicación: crédito 7 · Efecto +2');
  expect(history.querySelector('time')).toHaveAttribute('datetime', stamp);
  expect(f.corrections.snapshot).toEqual(before);
  for (const method of ['refresh', 'recover', 'retry', 'propose', 'decide'] as const) expect(f.corrections[method]).not.toHaveBeenCalled();
});
it.each([2, 3])('summarizes pending count once for endpoint %i without stock inference', actor => {
  const f = fixture(actor);
  Object.assign(f.corrections.snapshot!.lines[0], { effective_actual: big, proposals: [proposal()] });
  const before = structuredClone(f.corrections.snapshot);
  render(<TransferCountCorrections {...f.props} />);
  const card = screen.getByRole('rowgroup', { name: 'TOYO · Exact · 75.125 Ah · L' });
  expect(within(card).getByText(`Conteo vigente: ${big} → Propuesto: 7`)).toBeVisible();
  expect(within(card).getByText('La propuesta pendiente no modifica el conteo ni el stock.')).toBeVisible();
  expect(within(card).getByText(actor === 2 ? 'Esperando revisión de Sucursal B' : 'Propuesta de Sucursal A · Requiere tu revisión')).toBeVisible();
  expect(within(card).queryByText(/Efecto aplicado/)).toBeNull();
  expect(within(card).queryByRole('button', { name: actor === 2 ? 'Consultar propuesta' : 'Reemplazar propuesta' })).toBeNull();
  expect(f.corrections.snapshot).toEqual(before);
  for (const method of ['refresh', 'recover', 'retry', 'propose', 'decide'] as const) expect(f.corrections[method]).not.toHaveBeenCalled();
});
it('keeps revision results secondary and discloses all original audit evidence locally', () => {
  const f = fixture();
  Object.assign(f.corrections.snapshot!.lines[0], { proposals: [{ ...proposal('applied'), revision: 3n }] });
  render(<TransferCountCorrections {...f.props} />);
  const summary = screen.getByRole('button', { name: 'Historial completo · 1 revisión' });
  const history = document.getElementById(summary.getAttribute('aria-controls')!)!;
  expect(summary).toHaveAttribute('aria-expanded', 'false');
  expect(within(history).getByText('Revisión 3')).not.toBeVisible();
  fireEvent.click(summary);
  expect(within(history).getByText('Revisión 3')).toBeVisible();
  expect(within(history).getByText('Aplicada')).toBeVisible();
  expect(within(history).getByText('Cantidad 7')).toBeVisible();
  expect(history).not.toHaveTextContent('5 → 7'); // The persisted base credit is not a before count.
  const detail = within(history).getByRole('button', { name: 'Ver detalle de revisión 3' });
  expect(within(history).getByText('Motivo: Reconteo original')).not.toBeVisible();
  fireEvent.click(detail);
  expect(within(history).getByText('Motivo: Reconteo original')).toBeVisible();
  expect(history).toHaveTextContent('Motivo de decisión: Decisión exacta');
  expect(history).toHaveTextContent('decision_key_0001');
  for (const method of ['refresh', 'recover', 'retry', 'propose', 'decide'] as const) expect(f.corrections[method]).not.toHaveBeenCalled();
});
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Enviar propuesta' }));
afterEach(() => vi.unstubAllGlobals());

it('starts consultation at its semantic heading and traps keyboard navigation from that target', async () => {
  const user = userEvent.setup(); const f = fixture(3);
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  render(<><button>Outside</button><TransferCountCorrections {...f.props} /></>);
  const trigger = screen.getByRole('button', { name: 'Consultar propuesta' }); fireEvent.click(trigger);
  const modal = screen.getByRole('dialog');
  const heading = within(modal).getByRole('heading', { name: 'Propuesta de corrección de conteo', level: 3 });
  expect(heading).toHaveAttribute('tabindex', '-1'); expect(heading).toHaveFocus();
  expect(modal).toHaveAttribute('aria-labelledby', heading.id);
  const close = within(modal).getByRole('button', { name: 'Cerrar corrección' });
  await user.tab({ shift: true }); expect(close).toHaveFocus();
  await user.tab(); expect(within(modal).getByRole('button', { name: 'Rechazar propuesta' })).toHaveFocus();
  await user.tab(); expect(within(modal).getByRole('button', { name: 'Aceptar propuesta' })).toHaveFocus();
  await user.tab(); expect(close).toHaveFocus();
  heading.focus(); await user.tab();
  expect(within(modal).getByRole('button', { name: 'Rechazar propuesta' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveAttribute('inert');
  await user.keyboard('{Escape}'); expect(trigger).toHaveFocus();
  expect(trigger.closest('[inert]')).toBeNull(); expect(f.corrections.decide).not.toHaveBeenCalled();
});
it.each(['accept', 'reject'] as const)('consults exact pending evidence before %s without interrupting isolation', action => {
  const f = fixture(3); const reason = '  Original\n\n  proposal  ';
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [{ ...proposal(), reason }] }] };
  render(<><button>Outside</button><TransferCountCorrections {...f.props} /></>);
  const trigger = screen.getByRole('button', { name: 'Consultar propuesta' }); fireEvent.click(trigger);
  const modal = screen.getByRole('dialog', { name: 'Propuesta de corrección de conteo' });
  const heading = within(modal).getByRole('heading', { name: 'Propuesta de corrección de conteo', level: 3 });
  const header = heading.closest('header'); expect(header).not.toBeNull();
  expect(modal).toHaveAttribute('aria-labelledby', heading.id);
  expect(within(header!).getByRole('status')).toHaveTextContent('Pendiente de decisión');
  expect(within(modal).getAllByRole('status')).toHaveLength(1);
  expect(modal.querySelector('.count-consultation-body [role="status"]')).toBeNull();
  expect(modal).toHaveTextContent('TR-001 · Propuesta de Sucursal A');
  expect(modal).toHaveTextContent('Sucursal B debe revisar');
  expect(modal).toHaveTextContent('TOYO · Exact · 75.125 Ah · L');
  expect(modal).toHaveTextContent(`Enviadas: ${big}`);
  expect(within(modal).getByRole('row', { name: 'Cantidad recibida 5 7' })).toBeInTheDocument();
  expect(within(modal).getByRole('row', { name: 'Crédito de esta recepción 5 7' })).toBeInTheDocument();
  expect(modal).toHaveTextContent('Motivo de Sucursal A');
  expect(modal.querySelector('.count-review-reason')?.textContent).toBe(reason);
  expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument();
  const outside = screen.getByRole('button', { name: 'Outside' }); expect(outside).toHaveAttribute('inert');
  fireEvent.click(within(modal).getByRole('button', { name: action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta' }));
  expect(screen.getByRole('dialog')).toBe(modal); expect(outside).toHaveAttribute('inert');
  expect(decisionReason()).toHaveValue(''); expect(decisionReason()).toHaveFocus();
  fireEvent.change(decisionReason(), { target: { value: '  Separate decision  ' } });
  expect(review()).toBe(modal); expect(outside).toHaveAttribute('inert');
  expect(f.corrections.decide).not.toHaveBeenCalled(); expect(f.corrections.propose).not.toHaveBeenCalled();
  let inertAtFocus = true; trigger.addEventListener('focus', () => { inertAtFocus = trigger.closest('[inert]') !== null; });
  fireEvent.keyDown(modal, { key: 'Escape' }); expect(trigger).toHaveFocus(); expect(inertAtFocus).toBe(false);
});
it.each(['branch', 'prepare', 'back'] as const)('refuses stale consultation evidence at %s', stage => {
  const mutations = ['snapshot', 'revision', 'quantity', 'reason', 'confirmed', 'owner', 'mask', 'busy', 'uncertain', 'membership'];
  for (const mutation of mutations) {
    const f = fixture(3); const pending = proposal(); const confirmed = { ...line(), proposals: [pending] };
    f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [confirmed] };
    const view = render(<TransferCountCorrections {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
    if (stage !== 'branch') {
      fireEvent.click(screen.getByRole('button', { name: 'Aceptar propuesta' }));
      fireEvent.change(decisionReason(), { target: { value: 'Private decision' } });
    }
    if (mutation === 'snapshot') f.corrections.snapshot = { ...f.corrections.snapshot! };
    if (mutation === 'revision') { Object.assign(pending, { revision: 5n }); confirmed.workflow_revision = 5n; }
    if (mutation === 'quantity') Object.assign(pending, { actual_quantity: 8n });
    if (mutation === 'reason') Object.assign(pending, { reason: 'Replacement' });
    if (mutation === 'confirmed') confirmed.effective_credit = 4n;
    if (mutation === 'owner') f.authority.sessionGeneration = 2;
    if (mutation === 'mask') f.corrections.masked = true;
    if (mutation === 'busy') f.corrections.busy = true;
    if (mutation === 'uncertain') f.corrections.attempts = [attempt('uncertain')];
    if (mutation === 'membership' && f.props.record.status === 'received') Object.assign(f.props.record.receipt, { items: [] });
    if (stage === 'branch') fireEvent.click(screen.getByRole('button', { name: 'Aceptar propuesta' }));
    else if (stage === 'back') fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
    else fireEvent.submit(screen.getByRole('form', { name: 'Editar corrección' }));
    if (stage === 'back') expect(screen.queryByRole('heading', { name: 'Propuesta de corrección de conteo' }), mutation).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirmar aceptación' }), mutation).not.toBeInTheDocument();
    if (stage === 'branch') expect(screen.queryByLabelText('Motivo'), mutation).not.toBeInTheDocument();
    expect(f.corrections.decide, mutation).not.toHaveBeenCalled(); view.unmount();
  }
});
it.each(['consultation', 'capture', 'review'])('retires %s on replacement render and requires a fresh consultation', stage => {
  const f = fixture(3); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  const view = render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  if (stage !== 'consultation') {
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar propuesta' }));
    fireEvent.change(decisionReason(), { target: { value: 'Retired private decision' } });
    if (stage === 'review') review();
  }
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), workflow_revision: 5n,
    proposals: [{ ...proposal(), revision: 5n, actual_quantity: 9n, reason: 'Fresh replacement' }] }] };
  view.rerender(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue('Retired private decision')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Fresh replacement');
  expect(screen.getByRole('row', { name: 'Cantidad recibida 5 9' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Aceptar propuesta' }));
  expect(decisionReason()).toHaveValue('');
  expect(f.corrections.decide).not.toHaveBeenCalled();
});
it.each(['owner', 'mask', 'record', 'request', 'snapshot', 'context'])('does not resurrect consulted private evidence after %s round trip', mutation => {
  const f = fixture(3); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  const view = render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  for (const branch of ['Aceptar', 'Rechazar']) {
    fireEvent.click(screen.getByRole('button', { name: `${branch} propuesta` }));
    fireEvent.change(decisionReason(), { target: { value: `Private ${branch}` } });
    fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
  }
  const original = { ...f.props }; const snapshot = f.corrections.snapshot;
  if (mutation === 'snapshot') f.corrections.snapshot = { ...snapshot! };
  // Management visibility alone is not authority; disabling the workflow is.
  if (mutation === 'context') f.props.enabled = false;
  if (mutation === 'owner') f.authority.sessionGeneration = 2;
  if (mutation === 'mask') f.corrections.masked = true;
  if (mutation === 'record') f.props.record = { ...f.props.record };
  if (mutation === 'request') f.props.requestID = '2';
  view.rerender(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  f.corrections.masked = false; f.authority.sessionGeneration = 1; f.corrections.snapshot = snapshot;
  view.rerender(<TransferCountCorrections {...original} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  for (const branch of ['Aceptar', 'Rechazar']) {
    fireEvent.click(screen.getByRole('button', { name: `${branch} propuesta` }));
    expect(decisionReason()).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
  }
  expect(f.corrections.decide).not.toHaveBeenCalled();
});
it('keeps an unexpected received variant audit-only at consultation', () => {
  const f = fixture(3); f.props.record.items = [];
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  render(<TransferCountCorrections {...f.props} />); fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  const modal = screen.getByRole('dialog');
  expect(modal).toHaveTextContent('Variante inesperada 201'); expect(modal).toHaveTextContent('Solo auditoría: crédito y efecto cero');
  expect(modal).toHaveTextContent('Efecto en destino: 0');
  expect(within(modal).getByRole('row', { name: 'Crédito de esta recepción 5 0' })).toBeInTheDocument();
  expect(f.corrections.decide).not.toHaveBeenCalled();
});
it.each([[0n, 0n, 5n, '-5'], [big + 1n, big, 5n, '+9007199254740988'], [5n, 5n, 5n, '0']])(
  'consults quantity %s with capped credit %s and conditional delta', (actual, credit, current, delta) => {
    const f = fixture(3); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), effective_credit: current,
      proposals: [{ ...proposal(), actual_quantity: actual }] }] };
    render(<TransferCountCorrections {...f.props} />); fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
    const modal = screen.getByRole('dialog');
    expect(within(modal).getByRole('row', { name: `Crédito de esta recepción ${current} ${credit}` })).toBeInTheDocument();
    expect(modal).toHaveTextContent(`Efecto en destino: ${delta}`);
    expect(modal).toHaveTextContent('El crédito no es inventario actual');
    expect(modal).toHaveTextContent('Rechazar no modifica el conteo ni el stock');
    expect(f.corrections.decide).not.toHaveBeenCalled();
  });
it('T4c preserves pinned confirmed quantities and exact reason outside closed technical evidence', () => {
  const f = fixture();
  const confirmed = { ...line(), effective_actual: 9n, effective_credit: 7n, applied_revision: 1n };
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [confirmed] };
  const view = render(<TransferCountCorrections {...f.props} />); draft('8', '  First line\n\n  Second line  ');
  const modal = review();
  // Even an in-place injected view change cannot rewrite already reviewed evidence.
  confirmed.effective_actual = 99n; confirmed.effective_credit = 98n;
  view.rerender(<TransferCountCorrections {...f.props} />);
  const table = within(modal).getByRole('table', { name: 'Comparación de conteo' });
  expect(within(table).getAllByRole('row').map(row => row.textContent)).toEqual([
    'ConceptoVigente confirmadoPropuesto', 'Cantidad recibida98', 'Crédito de esta recepción78',
  ]);
  expect(modal.querySelector('.count-review-reason')?.textContent).toBe('  First line\n\n  Second line  ');
  const details = modal.querySelector('details')!;
  expect(details).not.toHaveAttribute('open');
  expect(details).toHaveTextContent('Revisión de flujo esperada: 4');
  expect(details).toHaveTextContent('Base aplicada: 1');
  expect(details).toHaveTextContent(/Clave [a-f0-9]{32}/);
  expect(modal).toHaveTextContent('Enviar propuesta no modifica stock');
  expect(modal).toHaveTextContent('Si Sucursal B acepta');
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('edits the same isolated modal without sending and mints a fresh identity only on prepare', async () => {
  const f = fixture(); let seed = 0;
  const random = vi.fn((bytes: Uint8Array) => { bytes.fill(++seed); return bytes; });
  vi.stubGlobal('crypto', { getRandomValues: random });
  render(<><button>Outside</button><TransferCountCorrections {...f.props} /></>);
  draft('9007199254740994', '  Raw\n  reason  ');
  expect(random).not.toHaveBeenCalled();
  const modal = review(); const firstEvidence = modal.querySelector('details')!.textContent;
  expect(random).toHaveBeenCalledTimes(1);
  for (let loop = 0; loop < 2; loop++) {
    fireEvent.click(within(modal).getByRole('button', { name: 'Editar datos' }));
    expect(screen.getByRole('dialog')).toBe(modal);
    expect(screen.getByRole('button', { name: 'Outside' })).toHaveAttribute('inert');
    expect(screen.getByLabelText('Batería a corregir')).toHaveValue('201');
    expect(screen.getByLabelText('Batería a corregir')).toHaveFocus();
    expect(screen.getByLabelText('Cantidad corregida')).toHaveValue('9007199254740994');
    expect(screen.getByLabelText('Motivo')).toHaveValue('  Raw\n  reason  ');
    expect(random).toHaveBeenCalledTimes(loop + 1);
    expect(f.corrections.propose).not.toHaveBeenCalled();
    expect(review()).toBe(modal);
  }
  expect(random).toHaveBeenCalledTimes(3);
  expect(modal.querySelector('details')!.textContent).not.toBe(firstEvidence);
  await act(async () => fireEvent.click(within(modal).getByRole('button', { name: 'Enviar propuesta' })));
  expect(f.corrections.propose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    actual_quantity: '9007199254740994', reason: '  Raw\n  reason  ', operation_key: '03'.repeat(16),
  }));
});
it.each(['owner', 'revision', 'mask', 'uncertain', 'busy'])('refuses edit-back after %s changes before rendering', mode => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft('8'); const modal = review();
  if (mode === 'owner') f.authority.sessionGeneration = 2;
  if (mode === 'revision') f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), workflow_revision: 5n }] };
  if (mode === 'mask') f.corrections.masked = true;
  if (mode === 'uncertain') f.corrections.attempts = [attempt('uncertain')];
  if (mode === 'busy') f.corrections.busy = true;
  fireEvent.click(within(modal).getByRole('button', { name: 'Editar datos' }));
  expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument();
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('prepares edited data against newly confirmed evidence instead of reusing the discarded pin', async () => {
  const f = fixture(); const view = render(<TransferCountCorrections {...f.props} />); draft('8'); const modal = review();
  fireEvent.click(within(modal).getByRole('button', { name: 'Editar datos' }));
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), workflow_revision: 6n, effective_actual: 3n, effective_credit: 2n }] };
  view.rerender(<TransferCountCorrections {...f.props} />);
  review();
  expect(within(modal).getByRole('row', { name: 'Cantidad recibida 3 8' })).toBeInTheDocument();
  expect(modal).toHaveTextContent('Efecto en destino: +6');
  await act(async () => confirm());
  expect(f.corrections.propose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expected_revision: '6', actual_quantity: '8' }));
});
it.each(['owner', 'incompatible', 'mask', 'uncertain', 'busy'])('revalidates %s before preparing an edited draft', mode => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft('8'); const modal = review();
  fireEvent.click(within(modal).getByRole('button', { name: 'Editar datos' }));
  const random = vi.fn(() => { throw new Error('must not prepare'); });
  vi.stubGlobal('crypto', { getRandomValues: random });
  if (mode === 'owner') f.authority.sessionGeneration = 2;
  if (mode === 'incompatible') f.corrections.snapshot = { ...f.corrections.snapshot!, request_id: 2n };
  if (mode === 'mask') f.corrections.masked = true;
  if (mode === 'uncertain') f.corrections.attempts = [attempt('uncertain')];
  if (mode === 'busy') f.corrections.busy = true;
  fireEvent.submit(screen.getByRole('form', { name: 'Editar corrección' }));
  expect(random).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Enviar propuesta' })).not.toBeInTheDocument();
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it.each([['0', '-5'], ['3', '-2'], ['8', '+3'], ['9007199254740994', '+9007199254740988']])(
  'T4c preserves proposed %s credit effect %s conditional on later acceptance', (quantity, delta) => {
    const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft(quantity);
    const modal = review();
    expect(within(modal).getByRole('table', { name: 'Comparación de conteo' })).toHaveTextContent('Crédito de esta recepción');
    expect(modal).toHaveTextContent(`Efecto en destino: ${delta}`);
    expect(modal).toHaveTextContent('Si Sucursal B acepta');
    expect(modal).toHaveTextContent('Enviar propuesta no modifica stock');
    expect(f.corrections.propose).not.toHaveBeenCalled();
  });

it('offers only eligible receipt batteries and clears cross-battery capture before reviewing', () => {
  const f = fixture();
  if (f.props.record.status !== 'received') throw new Error('fixture');
  f.props.record = { ...f.props.record, receipt: { ...f.props.record.receipt, items: [...f.props.record.receipt.items,
    { variant_id: 999, expected_quantity: 0n, actual_quantity: 2n, available_quantity: 0n }] } };
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [line(), line(999), line(777)] };
  render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Proponer corrección' })[0]);
  const selector = screen.getByLabelText('Batería a corregir');
  expect(within(selector).getAllByRole('option').map(o => o.getAttribute('value'))).toEqual(['201', '999']);
  expect(screen.getByLabelText('Cantidad corregida')).toHaveValue('');
  expect(screen.getByLabelText('Motivo')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Revisar corrección' })).toBeDisabled();
  expect(screen.getByRole('dialog')).toHaveTextContent(`Enviadas originalmente: ${big}`);
  expect(screen.getByRole('dialog')).toHaveTextContent('Conteo efectivo confirmado: 5');
  fireEvent.change(screen.getByLabelText('Cantidad corregida'), { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '  Exact reason  ' } });
  fireEvent.change(selector, { target: { value: '999' } });
  expect(screen.getByLabelText('Cantidad corregida')).toHaveValue('');
  expect(screen.getByLabelText('Motivo')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Revisar corrección' })).toBeDisabled();
  expect(screen.getByRole('dialog')).toHaveTextContent('Enviadas originalmente: 0');
  fireEvent.change(screen.getByLabelText('Cantidad corregida'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '  New exact reason  ' } });
  const modal = review();
  expect(modal).toHaveTextContent('Variante inesperada 999');
  expect(modal).toHaveTextContent('Crédito limitado: 0');
  expect(modal).not.toHaveTextContent('Exact reason');
  fireEvent.click(within(modal).getByRole('button', { name: 'Editar datos' }));
  expect(screen.getByLabelText('Batería a corregir')).toHaveValue('999');
  expect(screen.getByLabelText('Cantidad corregida')).toHaveValue('0');
  expect(screen.getByLabelText('Motivo')).toHaveValue('  New exact reason  ');
  review(); confirm();
  expect(f.corrections.propose).toHaveBeenCalledWith(expect.objectContaining({ variant_id: 999, actual_quantity: '0', reason: '  New exact reason  ' }));
});
it('uses applied effective actual and credit, not original receipt or proposed totals', () => {
  const f = fixture();
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), effective_actual: 9n,
    effective_credit: 7n, proposals: [proposal('applied')] }] };
  render(<TransferCountCorrections {...f.props} />); draft('9223372036854775807', '\t');
  const modal = screen.getByRole('dialog');
  expect(modal).toHaveTextContent(`Enviadas originalmente: ${big}`);
  expect(modal).toHaveTextContent('Conteo efectivo confirmado: 9');
  expect(modal).toHaveTextContent('Crédito efectivo de esta recepción: 7');
  expect(screen.getByRole('button', { name: 'Revisar corrección' })).toBeEnabled();
  expect(review()).toHaveTextContent('9223372036854775807');
});
it('excludes counterparty-pending and uncertain options while retaining own replacement', () => {
  const f = fixture();
  if (f.props.record.status !== 'received') throw new Error('fixture');
  f.props.record = { ...f.props.record, receipt: { ...f.props.record.receipt, items: [201, 202, 203].map(variant_id =>
    ({ variant_id, expected_quantity: 0n, actual_quantity: 0n, available_quantity: 0n })) } };
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [
    { ...line(), proposals: [proposal()] }, { ...line(202), proposals: [proposal('pending', 3)] }, line(203)] };
  f.corrections.attempts = [{ ...attempt('uncertain'), payload: { ...attempt('uncertain').payload, variant_id: 203 } }];
  render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reemplazar propuesta' }));
  expect(within(screen.getByLabelText('Batería a corregir')).getAllByRole('option').map(o => o.getAttribute('value'))).toEqual(['201']);
  expect(screen.getByRole('dialog')).toHaveTextContent('requiere un nuevo acuerdo');
});
it.each(['', '-1', '1.5', '1e2', '01', '9223372036854775808'])('disables proposal review for invalid quantity %j', value => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft(value, 'Valid reason');
  expect(screen.getByRole('button', { name: 'Revisar corrección' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Enviar propuesta' })).not.toBeInTheDocument();
});
it.each(['', '   ', '\0', 'a'.repeat(2001)])('uses exact reason admission for capture case %#', reason => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft('0', reason);
  expect(screen.getByRole('button', { name: 'Revisar corrección' })).toBeDisabled();
});
it.each(['busy', 'incompatible', 'counterparty', 'uncertain'])('cannot review or select an ineligible %s battery', mode => {
  const f = fixture(); const view = render(<TransferCountCorrections {...f.props} />); draft('0', 'Reason');
  if (mode === 'busy') f.corrections.busy = true;
  if (mode === 'incompatible') f.corrections.snapshot = { ...f.corrections.snapshot!, request_id: 2n };
  if (mode === 'counterparty') f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal('pending', 3)] }] };
  if (mode === 'uncertain') f.corrections.attempts = [attempt('uncertain')];
  view.rerender(<TransferCountCorrections {...f.props} />);
  const button = screen.queryByRole('button', { name: 'Revisar corrección' });
  if (button) expect(button).toBeDisabled();
  expect(f.corrections.propose).not.toHaveBeenCalled();
});

it('isolates capture continuously through review and restores prior attributes before focus', async () => {
  const f = fixture();
  const view = render(<><aside data-testid="outside" inert aria-hidden="false" />
    <main><button>Other workflow</button><TransferCountCorrections {...f.props} /></main></>);
  const outside = screen.getByTestId('outside');
  outside.setAttribute('inert', 'already');
  const other = screen.getByRole('button', { name: 'Other workflow' });
  const trigger = screen.getByRole('button', { name: 'Proponer corrección' });
  const focused = vi.fn(() => {
    expect(other).not.toHaveAttribute('inert');
    expect(outside).toHaveAttribute('inert', 'already');
    expect(outside).toHaveAttribute('aria-hidden', 'false');
  });
  trigger.addEventListener('focus', focused);
  draft('7');
  const modal = screen.getByRole('dialog', { name: 'Corregir conteo' });
  expect(modal).toHaveAttribute('aria-modal', 'true');
  expect(screen.getByLabelText('Batería a corregir')).toHaveFocus();
  expect(other).toHaveAttribute('inert');
  const releases: MutationRecord[] = [];
  const observer = new MutationObserver(records => releases.push(...records));
  observer.observe(other, { attributes: true, attributeOldValue: true });
  f.corrections.attempts = [attempt('failed')];
  view.rerender(<><aside data-testid="outside" inert aria-hidden="false" />
    <main><button>Other workflow</button><TransferCountCorrections {...f.props} /></main></>);
  await act(async () => {});
  const recovery = screen.getByRole('article', { name: 'Recuperación 201' });
  expect(recovery).toHaveAttribute('inert');
  expect(review()).toBe(modal);
  await act(async () => {});
  expect(releases).toHaveLength(0);
  expect(focused).not.toHaveBeenCalled();
  expect(screen.queryByRole('form', { name: 'Editar corrección' })).not.toBeInTheDocument();
  fireEvent.click(within(modal).getByRole('button', { name: 'Editar datos' }));
  await act(async () => {});
  expect(releases).toHaveLength(0);
  expect(focused).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Batería a corregir')).toHaveFocus();
  review();
  fireEvent.click(within(modal).getByRole('button', { name: 'Cerrar corrección' }));
  expect(focused).toHaveBeenCalledTimes(1);
  expect(recovery).not.toHaveAttribute('inert');
  expect(within(recovery).getByRole('button', { name: 'Consultar resultado' })).toBeEnabled();
  observer.disconnect();
});
it('cycles all capture controls, tolerates composition, and ignores backdrop clicks', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft('7');
  const modal = screen.getByRole('dialog');
  const input = screen.getByLabelText('Batería a corregir');
  const cancel = within(modal).getByRole('button', { name: 'Cancelar' });
  const close = within(modal).getByRole('button', { name: 'Cerrar corrección' });
  const select = document.createElement('select');
  select.append(document.createElement('option')); modal.append(select);
  fireEvent.keyDown(input, { key: 'Tab', shiftKey: true }); expect(select).toHaveFocus();
  select.focus(); fireEvent.keyDown(select, { key: 'Tab' }); expect(input).toHaveFocus();
  input.focus(); fireEvent.keyDown(input, { key: 'Tab' }); expect(input).toHaveFocus();
  const reason = screen.getByLabelText('Motivo'); reason.focus();
  fireEvent.keyDown(reason, { key: 'Tab', shiftKey: true }); expect(reason).toHaveFocus();
  for (const event of [{ key: 'Escape', isComposing: true }, { key: 'Escape', keyCode: 229 }]) {
    fireEvent.keyDown(reason, event); expect(modal).toBeInTheDocument();
  }
  fireEvent.click(modal.parentElement!); expect(modal).toBeInTheDocument();
  select.remove();
  input.setAttribute('disabled', '');
  screen.getByLabelText('Cantidad corregida').setAttribute('disabled', '');
  reason.focus(); fireEvent.keyDown(reason, { key: 'Tab', shiftKey: true }); expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Tab' }); expect(reason).toHaveFocus();
  cancel.focus(); fireEvent.keyDown(cancel, { key: 'Tab' }); expect(cancel).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Escape' }); expect(modal).not.toBeInTheDocument();
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it.each(['Aceptar', 'Rechazar'])('%s capture focuses reason and requires separate review before business action', action => {
  const f = fixture(3);
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  fireEvent.click(screen.getByRole('button', { name: `${action} propuesta` }));
  const modal = screen.getByRole('dialog');
  expect(decisionReason()).toHaveFocus();
  expect(screen.queryByLabelText('Cantidad corregida')).not.toBeInTheDocument();
  fireEvent.change(decisionReason(), { target: { value: 'Exact decision' } });
  expect(review()).toBe(modal);
  expect(within(modal).getByRole('button', { name: 'Editar motivo' })).toHaveFocus();
  expect(f.corrections.decide).not.toHaveBeenCalled();
  fireEvent.click(within(modal).getByRole('button', { name: 'Cerrar corrección' }));
  expect(screen.getByRole('button', { name: 'Consultar propuesta' })).toHaveFocus();
});
it('keeps focus inside an empty busy modal and keeps validation accessible inside capture', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft('01');
  fireEvent.submit(screen.getByRole('form', { name: 'Editar corrección' }));
  const modal = screen.getByRole('dialog');
  expect(within(modal).getByRole('alert')).toHaveTextContent('Ingresá cantidad');
  for (const control of modal.querySelectorAll('input, select, textarea, button')) control.setAttribute('disabled', '');
  fireEvent.keyDown(modal, { key: 'Tab' }); expect(modal).toHaveFocus();
  fireEvent.keyDown(modal, { key: 'Tab', shiftKey: true }); expect(modal).toHaveFocus();
});
it('does not transfer entry focus outside an active capture', () => {
  const f = fixture(); const view = render(<TransferCountCorrections {...f.props} />); draft();
  const input = screen.getByLabelText('Batería a corregir');
  view.rerender(<TransferCountCorrections {...f.props} contextVisible entryFocusKey={2} />);
  expect(input).toHaveFocus();
});
it.each(['disabled', 'removed'])('uses a connected heading fallback for a %s trigger', condition => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />);
  const trigger = screen.getByRole('button', { name: 'Proponer corrección' }); draft();
  if (condition === 'disabled') trigger.setAttribute('disabled', ''); else trigger.remove();
  fireEvent.click(screen.getByRole('button', { name: 'Cerrar corrección' }));
  expect(screen.getByRole('heading', { name: 'Correcciones de conteo' })).toHaveFocus();
});
it.each(['unmount', 'owner'])('cleans isolation on %s without stealing new focus', mode => {
  const f = fixture(); const view = render(<><button>New owner</button><TransferCountCorrections {...f.props} /></>);
  const next = screen.getByRole('button', { name: 'New owner' }); draft();
  expect(next).toHaveAttribute('inert'); next.focus();
  if (mode === 'unmount') view.rerender(<button>New owner</button>);
  else { f.authority.epoch++; act(() => f.hint()); }
  expect(next).not.toHaveAttribute('inert'); expect(next).toHaveFocus();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('blocks every dismissal and duplicate confirm while busy', () => {
  const f = fixture(); const view = render(<TransferCountCorrections {...f.props} />); draft(); const modal = review();
  f.corrections.busy = true; view.rerender(<TransferCountCorrections {...f.props} />);
  fireEvent.keyDown(modal, { key: 'Escape' });
  fireEvent.click(within(modal).getByRole('button', { name: 'Cerrar corrección' }));
  fireEvent.click(within(modal).getByRole('button', { name: 'Editar datos' }));
  confirm(); confirm(); expect(screen.getByRole('dialog')).toBe(modal);
  expect(f.corrections.propose).not.toHaveBeenCalled();
});

it('controls routine context without retiring drafts, review pins or explicit-entry focus', () => {
  const f = fixture(); const view = render(<TransferCountCorrections {...f.props} contextVisible={false} />);
  expect(screen.queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
  view.rerender(<TransferCountCorrections {...f.props} contextVisible entryFocusKey={1} />);
  expect(screen.getByRole('heading', { name: 'Correcciones de conteo' })).toHaveFocus();
  draft('7', 'Private retained reason');
  view.rerender(<TransferCountCorrections {...f.props} contextVisible={false} entryFocusKey={1} />);
  expect(screen.getByLabelText('Motivo')).toHaveValue('Private retained reason');
  const modal = review();
  view.rerender(<TransferCountCorrections {...f.props} contextVisible={false} entryFocusKey={1} />);
  expect(screen.getByRole('dialog')).toBe(modal);
  expect(modal).toHaveTextContent('Private retained reason');
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it.each(['masked', 'error', 'busy', 'unavailable'])('keeps collapsed %s evidence visible without initial focus', condition => {
  const f = fixture();
  if (condition === 'masked') f.corrections.masked = true;
  if (condition === 'error') f.corrections.error = new TransferAPIError('service_unavailable', 503);
  if (condition === 'busy') f.corrections.busy = true;
  if (condition === 'unavailable') f.corrections.snapshot = null;
  render(<TransferCountCorrections {...f.props} contextVisible={false} entryFocusKey={3} />);
  expect(screen.getByRole('heading', { name: 'Correcciones de conteo' })).not.toHaveFocus();
  expect(screen.getByRole(condition === 'error' ? 'alert' : 'status')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
});

it('keeps captured recovery and exact retry reachable in a collapsed healthy context', async () => {
  const f = fixture(); f.corrections.attempts = [attempt('uncertain')];
  render(<TransferCountCorrections {...f.props} contextVisible={false} />);
  const panel = screen.getByRole('article', { name: 'Recuperación 201' });
  expect(panel).toBeVisible(); expect(panel).toHaveTextContent('Captured private evidence');
  await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Reintentar carga exacta' })));
  expect(f.corrections.retry).toHaveBeenCalledExactlyOnceWith(201);
  expect(f.corrections.propose).not.toHaveBeenCalled();
});

it('allows a matching received line and previews capped credit against latest credit without writing', async () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />);
  expect(screen.getByRole('table', { name: 'Gestión de conteo' })).toBeInTheDocument();
  draft(); const modal = review();
  expect(modal).toHaveTextContent('9007199254740994');
  expect(modal).toHaveTextContent('Crédito limitado: 9007199254740993');
  expect(modal).toHaveTextContent('Efecto en destino: +9007199254740988');
  expect(f.corrections.propose).not.toHaveBeenCalled();
  await act(async () => confirm());
  expect(f.corrections.propose).toHaveBeenCalledExactlyOnceWith({ variant_id: 201,
    actual_quantity: '9007199254740994', expected_revision: '4', reason: '  Conteo exacto  ', operation_key: expect.stringMatching(/^[a-f0-9]{32}$/) });
});

it.each([2, 3])('allows physical endpoint %i, not creator or consulted inventory authority', actor => {
  const f = fixture(actor); render(<TransferCountCorrections {...f.props} />);
  expect(screen.getByRole('button', { name: 'Proponer corrección' })).toBeInTheDocument();
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('excludes a third warehouse even if it is the approver', () => {
  const f = fixture(1); render(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});
it.each(['disabled', 'unready', 'anonymous', 'not received', 'request mismatch', 'snapshot mismatch'])(
  'renders no private writes for %s', condition => {
    const f = fixture();
    if (condition === 'disabled') f.props.enabled = false;
    if (condition === 'unready') f.authority.ready = false;
    if (condition === 'anonymous') f.authority.session = null;
    if (condition === 'not received') f.props.record = { ...f.props.record, status: 'in_transit', receipt: undefined, receipt_location_id: undefined, received_at: undefined } as TransferCountCorrectionsProps['record'];
    if (condition === 'request mismatch') f.props.requestID = '2';
    if (condition === 'snapshot mismatch') f.corrections.snapshot = { ...f.corrections.snapshot!, request_id: 2n };
    render(<TransferCountCorrections {...f.props} />);
    expect(screen.queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
    expect(screen.queryByText('Reconteo original')).not.toBeInTheDocument();
    expect(f.corrections.propose).not.toHaveBeenCalled();
  });
it.each(['', ' ', '00', '01', '-1', '+1', '1.5', '1e3', '9223372036854775808'])(
  'rejects noncanonical or overflowing quantity %j without sending', quantity => {
    const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft(quantity); reviewInvalid();
    expect(f.corrections.propose).not.toHaveBeenCalled();
  });
function reviewInvalid(title = 'Corregir conteo') {
  // Exercise the handler's validation too, beyond native required-field gating.
  fireEvent.submit(screen.getByRole('form', { name: 'Editar corrección' }));
  expect(screen.getByRole('dialog')).toHaveAccessibleName(title);
  expect(screen.queryByRole('button', { name: 'Enviar propuesta' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toBeInTheDocument();
}
it.each(['0', '9223372036854775807'])('preserves canonical bounded quantity %s exactly', async actual => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft(actual); review();
  await act(async () => confirm());
  expect(f.corrections.propose).toHaveBeenCalledWith(expect.objectContaining({ actual_quantity: actual }));
});
it.each(['', '   ', '\0', 'x'.repeat(2001)])('requires model-valid proposal reason without normalization', reason => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft('0', reason); reviewInvalid();
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('reports secure random failure and never falls back to a key or write', () => {
  const f = fixture(); vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('private diagnostic'); } });
  render(<TransferCountCorrections {...f.props} />); draft('5'); reviewInvalid();
  expect(screen.getByRole('alert')).not.toHaveTextContent('private diagnostic');
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('T4c preserves absent original expected membership for audit-only unexpected counts', async () => {
  const f = fixture(); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [line(202)] };
  if (f.props.record.status !== 'received') throw new Error();
  f.props.record = { ...f.props.record, receipt: { ...f.props.record.receipt, items: [...f.props.record.receipt.items,
    { variant_id: 202, expected_quantity: 0n, actual_quantity: 7n, available_quantity: 0n }] } };
  render(<TransferCountCorrections {...f.props} />);
  expect(screen.getByText('Solo auditoría: crédito y efecto en stock cero. La procedencia e incorporación se resuelven por separado.').closest('details')).toBeNull();
  draft('9223372036854775807'); const modal = review();
  expect(modal).toHaveTextContent('Variante inesperada 202'); expect(modal).toHaveTextContent('Solo auditoría');
  expect(modal).toHaveTextContent('Crédito limitado: 0'); expect(modal).toHaveTextContent('Efecto en destino: 0');
  await act(async () => confirm());
  expect(f.corrections.propose).toHaveBeenCalledWith(expect.objectContaining({ variant_id: 202, actual_quantity: '9223372036854775807' }));
});
it('does not offer a line missing from the original receipt', () => {
  const f = fixture(); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [line(999)] };
  render(<TransferCountCorrections {...f.props} />); expect(screen.queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
});
it('shows all history states with exact evidence, Bolivia dates and application effect', () => {
  const f = fixture(); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals:
    (['superseded', 'rejected', 'applied', 'pending'] as const).map((state, index) => ({ ...proposal(state), revision: BigInt(index + 1) })) }] };
  render(<TransferCountCorrections {...f.props} />);
  for (const state of ['Reemplazada', 'Rechazada', 'Aplicada', 'Pendiente']) expect(screen.getByRole('region')).toHaveTextContent(state);
  expect(screen.getByRole('region')).toHaveTextContent('Aplicación: crédito 7 · Efecto +2');
  const times = screen.getByRole('region').querySelectorAll('time');
  expect(times).toHaveLength(7);
  for (const time of times) {
    expect(time.textContent).toBe('01/04/2026 · 20:00 (hora Bolivia)');
    expect(time).toHaveAttribute('datetime', stamp);
    expect(time).toHaveAttribute('title', stamp);
  }
  expect(screen.getByRole('region')).toHaveTextContent('Iniciador Sucursal A');
  expect(screen.getByRole('region')).toHaveTextContent('Decisión exacta');
  expect(screen.getByRole('region')).toHaveTextContent('La recepción original es inmutable');
  expect(screen.getByRole('region')).toHaveTextContent('sigue Recibida');
});
it('keeps effective quantities primary and all applied and technical evidence in secondary history', () => {
  const f = fixture();
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [
    { ...proposal('applied'), revision: 3n }, proposal(),
  ] }] };
  render(<TransferCountCorrections {...f.props} />);
  const card = screen.getByRole('rowgroup', { name: 'TOYO · Exact · 75.125 Ah · L' });
  const disclosures = Array.from(card.querySelectorAll('details.count-technical'));
  expect(disclosures).toHaveLength(3);
  for (const details of disclosures) {
    expect(details).not.toHaveAttribute('open');
    expect(details.firstElementChild?.tagName).toBe('SUMMARY');
    expect(details.firstElementChild).toHaveTextContent('Evidencia técnica');
  }
  expect(card.querySelector('[data-label="Conteo vigente"]')).toHaveTextContent('5');
  expect(card.querySelector('[data-label="Crédito en destino"]')).toHaveTextContent('5');
  const effect = within(card).getByText(/Efecto aplicado en destino: \+2/);
  expect(effect.closest('.count-history-disclosure')).not.toBeNull();
  expect(effect).not.toBeVisible();
  expect(disclosures[0].compareDocumentPosition(effect)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  for (const text of ['Pendiente', 'Iniciador Sucursal A', 'Motivo: Reconteo original',
    'Aceptada por Sucursal B', 'Motivo de decisión: Decisión exacta', 'Aplicación: crédito 7 · Efecto +2']) {
    for (const element of within(card.querySelector('.count-history-disclosure')! as HTMLElement).getAllByText(text, { exact: false })) {
      expect(element.closest('.count-history-disclosure')).not.toBeNull();
    }
  }
  for (const time of card.querySelectorAll('time')) {
    expect(time.closest('.count-history-disclosure')).not.toBeNull();
    expect(time).toHaveAttribute('datetime', stamp);
  }
  expect(within(card).getByText('Revisión de flujo').closest('details')).toBe(disclosures[0]);
  expect(disclosures[1]).toHaveTextContent('Base 3 · Crédito base 5');
  expect(disclosures[1]).toHaveTextContent('proposal_key_0001');
  expect(disclosures[1]).toHaveTextContent('decision_key_0001');
});

it('does not infer an applied effect from pending or historical applications', () => {
  const f = fixture();
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [
    { ...proposal('applied'), revision: 1n }, proposal(),
  ] }] };
  render(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByText(/Efecto aplicado en destino:/)).not.toBeInTheDocument();
  expect(screen.getByText(/Aplicación: crédito 7/).closest('.count-history-disclosure')).not.toBeNull();
});

it('native evidence disclosure is focusable and expands locally without reads or writes', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />);
  const summary = screen.getByText('Evidencia técnica del conteo');
  expect(summary.tagName).toBe('SUMMARY');
  summary.focus(); expect(summary).toHaveFocus();
  const details = summary.parentElement!;
  expect(details).not.toHaveAttribute('open');
  fireEvent.click(summary); expect(details).toHaveAttribute('open');
  expect(details).toHaveTextContent('Revisión de flujo4');
  expect(details).toHaveTextContent('Revisión aplicada3');
  fireEvent.click(summary); expect(details).not.toHaveAttribute('open');
  for (const method of ['refresh', 'recover', 'retry', 'propose', 'decide'] as const) {
    expect(f.corrections[method]).not.toHaveBeenCalled();
  }
});

it.each(['uncertain', 'conflict', 'failed'] as const)('keeps %s recovery instructions and captured reason outside technical disclosure', phase => {
  const f = fixture(); f.corrections.attempts = [attempt(phase, true)];
  f.corrections.error = new TransferAPIError('invalid_response', 500);
  render(<TransferCountCorrections {...f.props} />);
  const panel = screen.getByRole('article', { name: 'Recuperación 201' });
  const details = panel.querySelector('details')!;
  expect(details).not.toBeNull(); expect(details).not.toHaveAttribute('open');
  expect(details).toHaveTextContent('captured_key_0001');
  expect(details).toHaveTextContent('Revisión exacta 4');
  expect(details).toHaveTextContent('Cuenta 2');
  for (const element of [within(panel).getByText(/Resultado aún incierto\. No crees otra propuesta/),
    within(panel).getByText(/Motivo capturado:/), within(panel).getByText(/Cantidad capturada:/),
    within(panel).getByText('Proponer · Actor Sucursal A'), within(panel).getByRole('button', { name: 'Consultar resultado' }),
    screen.getByRole('alert')]) expect(element.closest('details')).toBeNull();
  if (phase !== 'failed') expect(within(panel).getByRole('button', { name: 'Reintentar carga exacta' }).closest('details')).toBeNull();
});

it('only pending initiator can replace and replacement obtains a new key and agreement', async () => {
  const f = fixture(); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  const h = render(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByRole('button', { name: 'Consultar propuesta' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reemplazar propuesta' }));
  fireEvent.change(screen.getByLabelText('Cantidad corregida'), { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Reemplazo' } });
  expect(review()).toHaveTextContent('requiere un nuevo acuerdo');
  await act(async () => confirm());
  expect(f.corrections.propose).toHaveBeenCalledWith(expect.objectContaining({ expected_revision: '4', operation_key: expect.not.stringMatching(/^proposal_key_0001$/) }));
  h.unmount(); const third = fixture(1); render(<TransferCountCorrections {...third.props} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it.each(['accept', 'reject'] as const)('counterparty %s is exact revision and requires its own exact reason', async action => {
  const f = fixture(3); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  render(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByRole('button', { name: 'Reemplazar propuesta' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  fireEvent.click(screen.getByRole('button', { name: `${action === 'accept' ? 'Aceptar' : 'Rechazar'} propuesta` }));
  fireEvent.change(decisionReason(), { target: { value: '   ' } }); reviewInvalid(`${action === 'accept' ? 'Aceptar' : 'Rechazar'} propuesta de conteo`);
  fireEvent.change(decisionReason(), { target: { value: '  Decisión conservada  ' } });
  const modal = review(); expect(modal).toHaveTextContent('Cantidad corregida: 7 · Revisión: 4 · Base aplicada: 3');
  expect(modal).toHaveTextContent(`Efecto en destino: ${action === 'accept' ? '+2' : '0'}`);
  expect(f.corrections.decide).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo' })); });
  expect(f.corrections.decide).toHaveBeenCalledExactlyOnceWith(action, { variant_id: 201, expected_revision: '4',
    reason: '  Decisión conservada  ', operation_key: expect.stringMatching(/^[a-f0-9]{32}$/) });
});
it('rejects a decision if pending is not the authoritative workflow revision', () => {
  const f = fixture(3); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), workflow_revision: 5n, proposals: [proposal()] }] };
  render(<TransferCountCorrections {...f.props} />); expect(screen.queryByRole('button', { name: 'Consultar propuesta' })).not.toBeInTheDocument();
});
it('keeps reviewed values fixed despite later editing events', async () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft('8', 'Initial exact reason');
  const input = screen.getByLabelText('Cantidad corregida'); const reason = screen.getByLabelText('Motivo'); review();
  fireEvent.change(input, { target: { value: '99' } }); fireEvent.change(reason, { target: { value: 'Different' } });
  await act(async () => confirm()); expect(f.corrections.propose).toHaveBeenCalledWith(expect.objectContaining({ actual_quantity: '8', reason: 'Initial exact reason' }));
});
it('cancels stale snapshot review instead of rebasing to a new revision', () => {
  const f = fixture(); const h = render(<TransferCountCorrections {...f.props} />); draft('8'); review();
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), workflow_revision: 5n }] };
  h.rerender(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument(); expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('final handler rechecks owner before state flush and refuses stale authority', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft(); review();
  f.authority.sessionGeneration = 2;
  confirm(); expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('final handler rechecks snapshot even without a rerender', () => {
  const f = fixture(3); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  fireEvent.click(screen.getByRole('button', { name: 'Aceptar propuesta' }));
  fireEvent.change(decisionReason(), { target: { value: 'Yes' } }); review();
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), workflow_revision: 5n, proposals: [{ ...proposal(), revision: 5n }] }] };
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptación' }));
  expect(f.corrections.decide).not.toHaveBeenCalled();
});
it.each(['account', 'location', 'epoch', 'generation', 'record', 'request', 'controller'])(
  'clears private forms immediately on %s transition and does not revive them on return', field => {
    const f = fixture(); const h = render(<TransferCountCorrections {...f.props} />); draft('8', 'Private draft never resurrect'); review();
    const original = { ...f.props }; const authority = { ...f.authority };
    if (field === 'epoch') f.authority.epoch++;
    if (field === 'generation') f.authority.sessionGeneration = 2;
    if (field === 'account' || field === 'location') {
      if (!f.authority.session?.authenticated) throw new Error();
      f.authority.session = { ...f.authority.session, identity: { ...f.authority.session.identity,
        ...(field === 'account' ? { account_id: 3 } : { location: { id: 3, name: 'Sucursal B' } }) } };
    }
    if (field === 'record') f.props.record = { ...f.props.record };
    if (field === 'request') f.props.requestID = '2';
    if (field === 'controller') f.props.controller = { ...f.controller, getTransferAuthority: () => f.authority };
    h.rerender(<TransferCountCorrections {...f.props} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Private draft never resurrect/)).not.toBeInTheDocument();
    Object.assign(f.authority, authority); h.rerender(<TransferCountCorrections {...original} />);
    expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument();
    expect(f.corrections.propose).not.toHaveBeenCalled();
  });
it('retires forms when authority changes and returns during invalidation callbacks', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft('8', 'Retired secret');
  act(() => { f.authority.sessionGeneration = 2; f.hint(); f.authority.sessionGeneration = 1; f.hint(); });
  expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument();
});
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve };
}
it('suppresses synchronous duplicate clicks and tolerates unmount before late completion', async () => {
  const f = fixture(); const d = deferred(); f.corrections.propose = vi.fn(() => d.promise);
  const h = render(<TransferCountCorrections {...f.props} />); draft(); review();
  const button = screen.getByRole('button', { name: 'Enviar propuesta' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(f.corrections.propose).toHaveBeenCalledTimes(1); h.unmount();
  await act(async () => { d.resolve(); await d.promise; }); expect(f.corrections.propose).toHaveBeenCalledTimes(1);
});
it('includes native disclosure in both Tab directions without leaking closed details or outside controls', async () => {
  const user = userEvent.setup(); const f = fixture();
  render(<><button>Outside</button><TransferCountCorrections {...f.props} /></>); draft('0');
  const modal = review(); const details = modal.querySelector('details')!;
  const summary = details.querySelector('summary')!;
  const child = document.createElement('button'); child.textContent = 'Expanded control'; details.append(child);
  // user-event does not model closed-details visibility; mirror it for simulated native Tab.
  child.hidden = true;
  for (const attribute of ['disabled', 'hidden', 'inert', 'aria-hidden']) {
    const excluded = document.createElement('button');
    excluded.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '');
    details.before(excluded);
  }
  const edit = within(modal).getByRole('button', { name: 'Editar datos' });
  const send = within(modal).getByRole('button', { name: 'Enviar propuesta' });
  const close = within(modal).getByRole('button', { name: 'Cerrar corrección' });
  expect(edit).toHaveFocus();
  await user.tab({ shift: true }); expect(summary).toHaveFocus();
  await user.tab({ shift: true }); expect(close).toHaveFocus();
  await user.tab(); expect(summary).toHaveFocus();
  await user.tab(); expect(edit).toHaveFocus();
  await user.tab(); expect(send).toHaveFocus();
  await user.tab(); expect(close).toHaveFocus();
  await user.tab(); expect(summary).toHaveFocus();
  await user.click(summary); expect(details).toHaveAttribute('open'); child.hidden = false;
  await user.tab(); expect(child).toHaveFocus();
  await user.tab(); expect(edit).toHaveFocus();
  await user.tab({ shift: true }); expect(child).toHaveFocus();
  await user.tab({ shift: true }); expect(summary).toHaveFocus();
  await user.click(summary); expect(details).not.toHaveAttribute('open');
  // jsdom permits focusing a closed descendant; it must not become a trap boundary.
  child.focus(); await user.tab({ shift: true }); expect(close).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveAttribute('inert');
  expect(modal).toContainElement(document.activeElement as HTMLElement);
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('labels the modal, focuses edit, wraps Tab/Escape and restores trigger focus', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />);
  const trigger = screen.getByRole('button', { name: 'Proponer corrección' }); draft('0'); const modal = review();
  expect(modal).toHaveAttribute('aria-modal', 'true'); expect(modal).toHaveAccessibleName('Revisar propuesta de conteo');
  const cancel = within(modal).getByRole('button', { name: 'Editar datos' });
  const close = within(modal).getByRole('button', { name: 'Cerrar corrección' });
  const summary = within(modal).getByText('Evidencia técnica de la propuesta');
  expect(cancel).toHaveFocus(); summary.focus();
  fireEvent.keyDown(summary, { key: 'Tab', shiftKey: true }); expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Tab' }); expect(summary).toHaveFocus();
  fireEvent.keyDown(cancel, { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('busy prevents confirming a reviewed draft', () => {
  const f = fixture(); const h = render(<TransferCountCorrections {...f.props} />); draft(); review();
  f.corrections.busy = true; h.rerender(<TransferCountCorrections {...f.props} />);
  expect(screen.getByRole('button', { name: 'Enviar propuesta' })).toBeDisabled(); expect(screen.getByRole('status')).toBeInTheDocument();
  confirm(); expect(f.corrections.propose).not.toHaveBeenCalled();
});
function attempt(phase: CountCorrectionAttempt['phase'], priorUncertainty = phase === 'uncertain'): CountCorrectionAttempt {
  return { requestID: 1n, action: 'propose', owner: { account: 2, location: 2, epoch: 1, generation: 1 }, phase,
    payload: { variant_id: 201, operation_key: 'captured_key_0001', expected_revision: 4n, actual_quantity: big,
      reason: '  Captured private evidence  ' }, result: null, failure: null, priorUncertainty };
}
it.each(['uncertain', 'conflict'] as const)('%s recovery shows captured payload and delegates exact retry without new key or proposal', async phase => {
  const f = fixture(); f.corrections.attempts = [attempt(phase, true)];
  vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('must not regenerate'); } });
  render(<TransferCountCorrections {...f.props} />); const panel = screen.getByRole('article', { name: 'Recuperación 201' });
  expect(panel).toHaveTextContent('captured_key_0001'); expect(panel).toHaveTextContent('Revisión exacta 4');
  expect(panel).toHaveTextContent(big.toString()); expect(panel).toHaveTextContent('Captured private evidence'); expect(panel).toHaveTextContent('Actor Sucursal A · Cuenta 2');
  expect(screen.queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
  await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Reintentar carga exacta' })); });
  expect(f.corrections.retry).toHaveBeenCalledExactlyOnceWith(201); expect(f.corrections.propose).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Consultar resultado' })); });
  expect(f.corrections.recover).toHaveBeenCalledExactlyOnceWith(201);
});
it.each(['failed', 'confirmed', 'inFlight'] as const)('accurately renders %s and no false retry control', phase => {
  const f = fixture(); f.corrections.attempts = [attempt(phase)]; render(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByRole('button', { name: 'Reintentar carga exacta' })).not.toBeInTheDocument();
  if (phase === 'inFlight') expect(screen.getByRole('button', { name: 'Consultar resultado' })).toBeDisabled();
  else expect(screen.getByRole('button', { name: 'Proponer corrección' })).toBeInTheDocument();
});
it('sticky prior uncertainty blocks a fresh proposal even after a definite failure', () => {
  const f = fixture(); f.corrections.attempts = [attempt('failed', true)]; render(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
  expect(screen.getByRole('article', { name: 'Recuperación 201' })).toHaveTextContent('Resultado aún incierto');
});
it('uncertainty on one line leaves another line independent', () => {
  const f = fixture(); f.corrections.attempts = [attempt('uncertain')];
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [line(), line(202)] };
  if (f.props.record.status !== 'received') throw new Error();
  f.props.record = { ...f.props.record, receipt: { ...f.props.record.receipt, items: [...f.props.record.receipt.items,
    { variant_id: 202, expected_quantity: 0n, actual_quantity: 7n, available_quantity: 0n }] } };
  render(<TransferCountCorrections {...f.props} />);
  expect(screen.getAllByRole('button', { name: 'Proponer corrección' })).toHaveLength(1);
});
it.each([403, 404])('masks every private payload/history/form on %i, with explicit recovery only', async status => {
  const f = fixture(); f.corrections.attempts = [attempt('failed')];
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [proposal()] }] };
  const h = render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reemplazar propuesta' }));
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Hidden form reason' } });
  f.corrections.masked = true; f.corrections.error = new TransferAPIError('not_found', status);
  h.rerender(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByText(/Captured private evidence|Reconteo original|Hidden form reason|captured_key_0001/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(f.corrections.recover).not.toHaveBeenCalled(); expect(f.corrections.retry).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Consultar recuperación autorizada' })); });
  expect(f.corrections.recover).toHaveBeenCalledExactlyOnceWith(201); expect(f.corrections.retry).not.toHaveBeenCalled();
  expect(screen.queryByText(/Captured private evidence/)).not.toBeInTheDocument();
  f.corrections.masked = false; f.corrections.error = null; h.rerender(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument();
});
it('does not expose technical error text or a foreign owner attempt', () => {
  const f = fixture(); f.corrections.error = new TransferAPIError('invalid_response', 500);
  f.corrections.error.message = 'Secret transport body'; f.corrections.attempts = [{ ...attempt('uncertain'), owner: { account: 3, location: 2, epoch: 1, generation: 1 } }];
  render(<TransferCountCorrections {...f.props} />); expect(screen.getByRole('alert')).not.toHaveTextContent('Secret transport body');
  expect(screen.queryByRole('article', { name: 'Recuperación 201' })).not.toBeInTheDocument();
});
it('leaves original receipt, header data and hook history immutable during review and submission', async () => {
  const f = fixture();
  const original = structuredClone(f.props.record); const snapshot = structuredClone(f.corrections.snapshot);
  Object.freeze(f.props.record); Object.freeze(f.props.record.items);
  if (f.props.record.status !== 'received') throw new Error();
  Object.freeze(f.props.record.receipt); Object.freeze(f.props.record.receipt.items);
  render(<TransferCountCorrections {...f.props} />); draft('0');
  expect(screen.getByLabelText('Cantidad corregida')).toHaveAttribute('type', 'text');
  expect(screen.getByLabelText('Cantidad corregida')).toHaveAttribute('inputmode', 'numeric');
  review(); await act(async () => confirm());
  expect(f.props.record).toEqual(original); expect(f.corrections.snapshot).toEqual(snapshot);
});
it('restores trigger focus after an asynchronously settled submission', async () => {
  const f = fixture(); const d = deferred(); f.corrections.propose = vi.fn(() => d.promise);
  render(<TransferCountCorrections {...f.props} />); const trigger = screen.getByRole('button', { name: 'Proponer corrección' });
  draft(); review(); act(() => confirm()); expect(trigger).toBeDisabled();
  await act(async () => { d.resolve(); await d.promise; }); expect(trigger).toHaveFocus();
});
it('refuses an old retry control when the captured attempt changed before render', () => {
  const f = fixture(); f.corrections.attempts = [attempt('uncertain')]; render(<TransferCountCorrections {...f.props} />);
  const retry = screen.getByRole('button', { name: 'Reintentar carga exacta' });
  f.corrections.attempts = [{ ...attempt('uncertain'), payload: { ...attempt('uncertain').payload, operation_key: 'different_key_001' } }];
  fireEvent.click(retry); expect(f.corrections.retry).not.toHaveBeenCalled();
});
it('masks a forbidden error even when the injected masked flag has not caught up', () => {
  const f = fixture(); f.corrections.attempts = [attempt('uncertain')];
  const h = render(<TransferCountCorrections {...f.props} />);
  f.corrections.error = new TransferAPIError('not_found', 403); h.rerender(<TransferCountCorrections {...f.props} />);
  expect(screen.queryByText(/Captured private evidence/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reintentar carga exacta' })).not.toBeInTheDocument();
});
it('preserves exact draft and reviewed payload across equivalent controller wrappers', async () => {
  const f = fixture();
  const stable = { ...f.controller, confirmTransferCountCorrection: vi.fn(), countCorrectionRecovery: createTransferCountCorrectionRecovery() };
  f.props.controller = stable;
  const h = render(<TransferCountCorrections {...f.props} />);
  draft('9007199254740994', '  Preserved exact reason  ');
  h.rerender(<TransferCountCorrections {...f.props} controller={{ ...stable }} />);
  expect(screen.getByLabelText('Cantidad corregida')).toHaveValue('9007199254740994');
  expect(screen.getByLabelText('Motivo')).toHaveValue('  Preserved exact reason  ');
  const modal = review();
  const preview = modal.textContent;
  // A rerender must neither remount the dialog nor mint a new reviewed key.
  vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('No new key permitted'); } });
  h.rerender(<TransferCountCorrections {...f.props} controller={{ ...stable }} />);
  expect(screen.getByRole('dialog')).toBe(modal);
  expect(modal.textContent).toBe(preview);
  expect(f.corrections.propose).not.toHaveBeenCalled();
  await act(async () => confirm());
  expect(f.corrections.propose).toHaveBeenCalledExactlyOnceWith({ variant_id: 201, expected_revision: '4',
    actual_quantity: '9007199254740994', reason: '  Preserved exact reason  ', operation_key: expect.stringMatching(/^[a-f0-9]{32}$/) });
});
it('proposal preview distinguishes applied predecessor from workflow concurrency revision', async () => {
  const f = fixture(); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), applied_revision: 1n }] };
  render(<TransferCountCorrections {...f.props} />); draft('8');
  const modal = review();
  expect(modal).toHaveTextContent('Base aplicada: 1');
  expect(modal).toHaveTextContent('Revisión de flujo esperada: 4');
  expect(modal).toHaveTextContent('Revisión: 5');
  expect(modal).toHaveTextContent('Crédito efectivo actual: 5');
  expect(modal).toHaveTextContent('Efecto en destino: +3');
  await act(async () => confirm());
  expect(f.corrections.propose).toHaveBeenCalledWith(expect.objectContaining({ expected_revision: '4', actual_quantity: '8' }));
});
it.each(['authority', 'subscription', 'unauthorized', 'confirmation', 'recovery'])(
  'retires reviewed state on genuine %s seam replacement and never revives it', seam => {
    const f = fixture(); const h = render(<TransferCountCorrections {...f.props} />); draft('8', 'Retire seam secret'); review();
    const original = f.props.controller;
    const changed = { ...original };
    if (seam === 'authority') changed.getTransferAuthority = () => f.authority;
    if (seam === 'subscription') changed.subscribeTransferInvalidation = listener => original.subscribeTransferInvalidation(listener);
    if (seam === 'unauthorized') changed.settleUnauthorized = epoch => original.settleUnauthorized(epoch);
    if (seam === 'confirmation') changed.confirmTransferCountCorrection = vi.fn();
    if (seam === 'recovery') changed.countCorrectionRecovery = createTransferCountCorrectionRecovery();
    h.rerender(<TransferCountCorrections {...f.props} controller={changed} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Retire seam secret/)).not.toBeInTheDocument();
    h.rerender(<TransferCountCorrections {...f.props} controller={original} />);
    expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument(); expect(f.corrections.propose).not.toHaveBeenCalled();
  });
it('denies a captured submit callback after an in-place authority seam replacement', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />); draft(); review();
  f.controller.getTransferAuthority = () => f.authority;
  confirm(); expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('replacement preview uses latest applied base, not the pending proposal predecessor', () => {
  const f = fixture(); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), applied_revision: 1n, proposals: [proposal()] }] };
  render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reemplazar propuesta' }));
  fireEvent.change(screen.getByLabelText('Cantidad corregida'), { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'New agreement' } });
  const modal = review(); expect(modal).toHaveTextContent('Base aplicada: 1');
  expect(modal).toHaveTextContent('Revisión de flujo esperada: 4'); expect(modal).toHaveTextContent('Efecto en destino: +3');
});
it('decision preview preserves the persisted pending base rather than substituting applied head', () => {
  const f = fixture(3); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), applied_revision: 1n, proposals: [proposal()] }] };
  render(<TransferCountCorrections {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
  fireEvent.click(screen.getByRole('button', { name: 'Aceptar propuesta' }));
  fireEvent.change(decisionReason(), { target: { value: 'Exact pending agreement' } });
  const modal = review(); expect(modal).toHaveTextContent('Base aplicada: 3'); expect(modal).toHaveTextContent('Revisión: 4');
  expect(modal).toHaveTextContent('Revisión de flujo esperada: 4');
});
