import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TransferCountCorrections, { type TransferCountCorrectionsProps } from './TransferCountCorrections';
import { parseSession } from './model';
import type { TransferAuthority, TransferController } from './useInventory';
import type { CountCorrectionLine, CountProposal } from './transferCountCorrectionModel';
import { createTransferCountCorrectionRecovery, type CountCorrectionAttempt } from './transferCountCorrectionRecovery';
import { TransferAPIError } from './transferAPI';

const stamp = '2026-04-02T00:00:00.000000001Z';
const big = 9007199254740993n;
function line(variant_id = 201): CountCorrectionLine {
  return { variant_id, expected_quantity: big, actual_quantity: big, available_quantity: big,
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
      identity: { account_id: 2, username: 'synthetic', location: { id: actor, name: 'Asignada' } } })) };
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
function review() { fireEvent.click(screen.getByRole('button', { name: 'Revisar corrección' })); return screen.getByRole('dialog'); }
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirmar propuesta' }));
afterEach(() => vi.unstubAllGlobals());

it('allows a matching received line and previews capped credit against latest credit without writing', async () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />);
  expect(screen.getByRole('heading', { name: 'Conteo efectivo confirmado' })).toBeInTheDocument();
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
function reviewInvalid() {
  // Exercise the handler's validation too, beyond native required-field gating.
  fireEvent.submit(screen.getByRole('form', { name: 'Editar corrección' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
it('uses absent original expected membership for audit-only unexpected counts', async () => {
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
it('puts effective quantities and applied effect before closed technical evidence without hiding history context', () => {
  const f = fixture();
  f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), proposals: [
    { ...proposal('applied'), revision: 3n }, proposal(),
  ] }] };
  render(<TransferCountCorrections {...f.props} />);
  const card = screen.getByRole('article', { name: 'TOYO · Exact · 75.125 Ah · L' });
  const disclosures = Array.from(card.querySelectorAll('details'));
  expect(disclosures).toHaveLength(3);
  for (const details of disclosures) {
    expect(details).not.toHaveAttribute('open');
    expect(details.firstElementChild?.tagName).toBe('SUMMARY');
    expect(details.firstElementChild).toHaveTextContent('Evidencia técnica');
  }
  const metrics = card.querySelector('.count-metrics')!;
  expect(metrics).toHaveTextContent('Cantidad efectiva5');
  expect(metrics).toHaveTextContent('Crédito efectivo de esta recepción5');
  expect(metrics).not.toHaveTextContent('Revisión');
  const effect = within(card).getByText(/Efecto aplicado en destino: \+2/);
  expect(effect.closest('details')).toBeNull();
  expect(effect.compareDocumentPosition(disclosures[0])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  for (const text of ['Pendiente · Revisión 4', 'Iniciador Sucursal A', 'Motivo: Reconteo original',
    'Aceptada por Sucursal B', 'Motivo de decisión: Decisión exacta', 'Aplicación: crédito 7 · Efecto +2']) {
    for (const element of within(card).getAllByText(text, { exact: false })) expect(element.closest('details')).toBeNull();
  }
  for (const time of card.querySelectorAll('time')) {
    expect(time.closest('details')).toBeNull();
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
  expect(screen.getByText(/Aplicación: crédito 7/).closest('details')).toBeNull();
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
  expect(screen.queryByRole('button', { name: 'Aceptar revisión 4' })).not.toBeInTheDocument();
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
  fireEvent.click(screen.getByRole('button', { name: `${action === 'accept' ? 'Aceptar' : 'Rechazar'} revisión 4` }));
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '   ' } }); reviewInvalid();
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '  Decisión conservada  ' } });
  const modal = review(); expect(modal).toHaveTextContent('Cantidad corregida: 7 · Revisión: 4 · Base aplicada: 3');
  expect(modal).toHaveTextContent(`Efecto en destino: ${action === 'accept' ? '+2' : '0'}`);
  expect(f.corrections.decide).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo' })); });
  expect(f.corrections.decide).toHaveBeenCalledExactlyOnceWith(action, { variant_id: 201, expected_revision: '4',
    reason: '  Decisión conservada  ', operation_key: expect.stringMatching(/^[a-f0-9]{32}$/) });
});
it('rejects a decision if pending is not the authoritative workflow revision', () => {
  const f = fixture(3); f.corrections.snapshot = { ...f.corrections.snapshot!, lines: [{ ...line(), workflow_revision: 5n, proposals: [proposal()] }] };
  render(<TransferCountCorrections {...f.props} />); expect(screen.queryByRole('button', { name: 'Aceptar revisión 4' })).not.toBeInTheDocument();
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
  fireEvent.click(screen.getByRole('button', { name: 'Aceptar revisión 4' }));
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Yes' } }); review();
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
  const button = screen.getByRole('button', { name: 'Confirmar propuesta' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(f.corrections.propose).toHaveBeenCalledTimes(1); h.unmount();
  await act(async () => { d.resolve(); await d.promise; }); expect(f.corrections.propose).toHaveBeenCalledTimes(1);
});
it('labels the modal, focuses cancel, wraps Tab/Escape and restores trigger focus', () => {
  const f = fixture(); render(<TransferCountCorrections {...f.props} />);
  const trigger = screen.getByRole('button', { name: 'Proponer corrección' }); draft('0'); const modal = review();
  expect(modal).toHaveAttribute('aria-modal', 'true'); expect(modal).toHaveAccessibleName('Revisar corrección de conteo');
  const cancel = within(modal).getByRole('button', { name: 'Cancelar' }); const yes = within(modal).getByRole('button', { name: 'Confirmar propuesta' });
  expect(cancel).toHaveFocus(); fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true }); expect(yes).toHaveFocus();
  fireEvent.keyDown(yes, { key: 'Tab' }); expect(cancel).toHaveFocus();
  fireEvent.keyDown(cancel, { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
  expect(f.corrections.propose).not.toHaveBeenCalled();
});
it('busy prevents confirming a reviewed draft', () => {
  const f = fixture(); const h = render(<TransferCountCorrections {...f.props} />); draft(); review();
  f.corrections.busy = true; h.rerender(<TransferCountCorrections {...f.props} />);
  expect(screen.getByRole('button', { name: 'Confirmar propuesta' })).toBeDisabled(); expect(screen.getByRole('status')).toBeInTheDocument();
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
  fireEvent.click(screen.getByRole('button', { name: 'Aceptar revisión 4' }));
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Exact pending agreement' } });
  const modal = review(); expect(modal).toHaveTextContent('Base aplicada: 3'); expect(modal).toHaveTextContent('Revisión: 4');
  expect(modal).toHaveTextContent('Revisión de flujo esperada: 4');
});
