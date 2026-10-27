import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferDispatchReconciliations, { type TransferDispatchReconciliationsProps as Props } from './TransferDispatchReconciliations';
import { createTransferDispatchReconciliationStore } from './transferDispatchReconciliationStore';
import { DispatchReconciliationAPIError } from './transferDispatchReconciliationAPI';
import { appliedSnapshot, fixture, owner } from './transferDispatchReconciliationStoreFixtures';
import type { DispatchReconciliations } from './transferDispatchReconciliationModel';

afterEach(cleanup);
function setup(pending = false, location = 1, snapshot?: DispatchReconciliations) {
  const f = fixture(pending); const actor = { ...owner, location };
  const store = createTransferDispatchReconciliationStore({ operationKey: () => 'presentation-explicit-key' });
  store.synchronize(actor); store.select(actor, f.record);
  const read = store.beginRead(actor, f.record)!; store.finishRead(read, snapshot ?? f.decode());
  const calls = { confirm: vi.fn(), recover: vi.fn(), retry: vi.fn(), refresh: vi.fn(), reason: vi.fn() };
  const current = (): Props['reconciliations'] => {
    const s = store.state(actor, f.record);
    return { ...s, reviewState: s.review,
      begin: (variant, action) => store.begin(actor, f.record, variant, action),
      setReason: reason => { calls.reason(reason); store.setReason(actor, f.record, reason); },
      review: () => store.review(actor, f.record), cancel: () => store.cancel(actor, f.record),
      confirm: async () => { calls.confirm(); store.confirm(actor, f.record); },
      recover: async () => { calls.recover(); }, retry: async variant => { calls.retry(variant); },
      refresh: async () => { calls.refresh(); } };
  };
  function Harness({ overrides = {} }: { overrides?: Partial<Props['reconciliations']> }) {
    const [, update] = useState(0);
    useEffect(() => store.subscribe(() => update(n => n + 1)), []);
    return <><button>Fuera de la gestión</button><TransferDispatchReconciliations record={f.record}
      actorLocation={location} reconciliations={{ ...current(), ...overrides }} /></>;
  }
  return { ...f, actor, store, calls, current, Harness };
}
const click = (name: string) => fireEvent.click(screen.getAllByRole('button', { name })[0]!);
function draft(reason = 'Procedencia verificada') {
  click('Proponer regularización');
  fireEvent.change(screen.getByLabelText('Motivo y confirmación de lo ocurrido'), { target: { value: reason } });
}
function ownAttempt(phase: 'inFlight' | 'uncertain' | 'failed' | 'confirmed') {
  const h = setup();
  h.store.begin(h.actor, h.record, 1, 'propose'); h.store.setReason(h.actor, h.record, 'Motivo privado original');
  h.store.review(h.actor, h.record); const ticket = h.store.confirm(h.actor, h.record)!;
  if (phase === 'uncertain') h.store.release(ticket);
  if (phase === 'failed') h.store.failWrite(ticket, new DispatchReconciliationAPIError('insufficient_stock', 409, false));
  if (phase === 'confirmed') h.store.finishWrite(ticket, { ...h.decode().operations[0], ...h.op,
    operation_key: ticket.attempt.payload.operation_key, reason: ticket.attempt.payload.reason });
  return h;
}

describe('controlled dispatch reconciliation presentation', () => {
  it('opens from Gestiones and reviews controlled Q=A, deltas and reason before explicit confirmation', () => {
    const h = setup(); render(<h.Harness />);
    click('Gestiones · Regularizar despacho');
    expect(h.calls.confirm).not.toHaveBeenCalled();
    draft();
    const quantity = screen.getByLabelText('Cantidad total realmente despachada') as HTMLInputElement;
    expect(quantity.readOnly).toBe(true); expect(quantity.value).toBe('7');
    expect(h.calls.reason).toHaveBeenLastCalledWith('Procedencia verificada');
    expect(screen.getByText(/recibirla no demuestra por sí solo su procedencia/)).toBeTruthy();
    click('Ver revisión de propuesta');
    expect(within(screen.getByRole('dialog')).getByText('−2')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('+2')).toBeTruthy();
    expect(h.calls.confirm).not.toHaveBeenCalled();
    click('Enviar propuesta'); expect(h.calls.confirm).toHaveBeenCalledTimes(1);
    expect(h.calls.retry).not.toHaveBeenCalled(); expect(h.calls.recover).not.toHaveBeenCalled();
  });
  it.each(['accept', 'reject'] as const)('counterpart %s requires reason, review and explicit confirmation', action => {
    const h = setup(true, 2); render(<h.Harness />);
    click('Consultar propuesta'); expect(screen.getByRole('dialog')).toBeTruthy();
    expect(h.calls.confirm).not.toHaveBeenCalled();
    click(action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta');
    fireEvent.change(screen.getByLabelText('Motivo y confirmación de lo ocurrido'), { target: { value: 'Decisión verificada' } });
    click('Ver revisión de propuesta');
    expect(screen.getByRole('dialog').textContent).toContain(action === 'reject' ? 'Sin cambios en el conteo ni en el stock.' : '−2');
    click(action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo');
    expect(h.calls.confirm).toHaveBeenCalledTimes(1);
  });
  it('stale accept-only pins disable accept but preserve rejection and a null reject preview', () => {
    const h = setup(true, 2); const fresh = h.decode();
    const stale = { ...fresh, lines: fresh.lines.map(l => l.variant_id === 1 ? { ...l, count_generation: 1n } : l) };
    const t = h.store.beginRead(h.actor, h.record)!; h.store.finishRead(t, stale);
    render(<h.Harness />); click('Consultar propuesta');
    expect((screen.getByRole('button', { name: 'Aceptar propuesta' }) as HTMLButtonElement).disabled).toBe(true);
    click('Rechazar propuesta');
    fireEvent.change(screen.getByLabelText('Motivo y confirmación de lo ocurrido'), { target: { value: 'Rechazo vigente' } });
    click('Ver revisión de propuesta'); click('Confirmar rechazo');
    expect(h.calls.confirm).toHaveBeenCalledTimes(1);
  });
  it('waiting consultation is explicit recovery GET only and does not manufacture success', () => {
    const h = setup(true); render(<h.Harness />);
    expect(screen.getByText(/Esperando revisión de Branch/)).toBeTruthy();
    expect(h.calls.recover).not.toHaveBeenCalled(); click('Consultar estado');
    expect(h.calls.recover).toHaveBeenCalledTimes(1); expect(h.calls.confirm).not.toHaveBeenCalled();
  });
  it('renders immutable original evidence and applied history without current-balance inference', () => {
    const h = setup(false, 1, appliedSnapshot()); render(<h.Harness />);
    expect(screen.getAllByText(/Despacho registrado: 5/)).toHaveLength(2);
    expect(screen.getByText(/Revisión 1 · Aplicada/)).toBeTruthy();
    expect(screen.getByText(/Saldos históricos de la operación; no inventario actual/)).toBeTruthy();
    expect(screen.queryByText('13', { exact: true })).toBeNull();
    expect(h.calls.confirm).not.toHaveBeenCalled();
  });
  it('later received count changes permit a fresh agreement without erasing the prior revision', () => {
    const f = appliedSnapshot();
    const later = { ...f, lines: f.lines.map(l => l.variant_id === 1
      ? { ...l, effective_actual: 8n, count_generation: 1n, count_applied_revision: 1n } : l) };
    const h = setup(false, 1, later); render(<h.Harness />); draft();
    expect((screen.getByLabelText('Cantidad total realmente despachada') as HTMLInputElement).value).toBe('8');
    click('Ver revisión de propuesta'); expect(within(screen.getByRole('dialog')).getByText('−1')).toBeTruthy();
    expect(screen.getByText(/Revisión 1 · Aplicada/)).toBeTruthy(); expect(h.calls.confirm).not.toHaveBeenCalled();
  });
  it.each(['noop', 'restitution'] as const)('does not offer new proposals for %s', scenario => {
    const h = setup(); const s = h.decode();
    const lines = s.lines.map(l => scenario === 'noop' ? { ...l, effective_actual: 5n, count_generation: 1n, count_applied_revision: 1n }
      : { ...l, effective_actual: 4n, effective_credit: 4n, count_generation: 1n, count_applied_revision: 1n, applied_retained_quantity: 1n, restitution_generation: 2n });
    // Synthetic strict decoder admission is exercised by Store.finishRead, not internal storage assertions.
    const t = h.store.beginRead(h.actor, h.record)!; h.store.finishRead(t, { ...s, lines });
    render(<h.Harness />); expect(screen.queryByRole('button', { name: 'Proponer regularización' })).toBeNull();
    expect(h.calls.confirm).not.toHaveBeenCalled();
  });
  it.each(['masked', 'empty'] as const)('immediately removes private modal/reason on %s props', state => {
    const h = setup(); const view = render(<h.Harness />); draft('Privado no retenido');
    expect(screen.getByRole('dialog')).toBeTruthy();
    view.rerender(<h.Harness overrides={{ masked: state === 'masked', snapshot: null, draft: null, reviewState: null }} />);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByDisplayValue('Privado no retenido')).toBeNull();
    expect(screen.queryByText('Motivo privado original')).toBeNull();
    expect(h.calls.confirm).not.toHaveBeenCalled();
  });
  it('closed error copy never renders arbitrary error messages, and busy actions cannot confirm', () => {
    const h = setup(); const e = new DispatchReconciliationAPIError('insufficient_stock', 409, false);
    e.message = 'ARBITRARY PRIVATE SERVER TEXT';
    render(<h.Harness overrides={{ error: e, busy: true }} />);
    expect(screen.queryByText(/ARBITRARY/)).toBeNull(); expect(screen.getByRole('alert').textContent).toMatch(/reservas/);
    expect(screen.getAllByRole('button', { name: 'Proponer regularización' }).every(b => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(h.calls.confirm).not.toHaveBeenCalled();
  });
  it.each(['inFlight', 'uncertain', 'failed', 'confirmed'] as const)('distinguishes owned %s without automatic callbacks or fake history', phase => {
    const h = ownAttempt(phase); render(<h.Harness />);
    expect(screen.getByRole('heading', { name: new RegExp({ inFlight: 'En curso', uncertain: 'Resultado incierto', failed: 'Fallo definitivo', confirmed: 'Confirmada' }[phase]) })).toBeTruthy();
    expect(h.calls.confirm).not.toHaveBeenCalled(); expect(h.calls.retry).not.toHaveBeenCalled(); expect(h.calls.recover).not.toHaveBeenCalled();
    if (phase === 'uncertain') {
      click('Consultar resultado'); expect(h.calls.recover).toHaveBeenCalledTimes(1); expect(h.calls.retry).not.toHaveBeenCalled();
      click('Reintentar carga exacta'); expect(h.calls.retry).toHaveBeenCalledExactlyOnceWith(1);
    } else expect(screen.queryByRole('button', { name: 'Reintentar carga exacta' })).toBeNull();
    if (phase === 'failed') {
      expect(screen.queryByText(/Revisión 1 · Aplicada/)).toBeNull();
      expect(screen.queryByText(/Resultado aún incierto/)).toBeNull();
    }
  });
  it('remounting an owned unknown never retries or replaces the original intent', () => {
    const h = ownAttempt('uncertain'); const first = render(<h.Harness />); first.unmount(); render(<h.Harness />);
    expect(screen.getByText(/Motivo capturado: Motivo privado original/)).toBeTruthy();
    expect(h.calls.retry).not.toHaveBeenCalled(); expect(h.calls.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Proponer regularización' })).toBeNull();
  });
  it('isolates the background, traps Tab, dismisses with Escape and restores the actual opener', () => {
    const h = setup(); render(<h.Harness />); const opener = screen.getAllByRole('button', { name: 'Proponer regularización' })[0]!;
    opener.focus(); fireEvent.click(opener);
    const dialog = screen.getByRole('dialog'); const outside = screen.getByRole('button', { name: 'Fuera de la gestión' });
    expect(outside.closest('[inert]')).toBeTruthy();
    const close = within(dialog).getByRole('button', { name: 'Cerrar' }); close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' }); expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(outside.closest('[inert]')).toBeNull(); expect(h.calls.confirm).not.toHaveBeenCalled();
  });
  it('a reject review remains confirmable with a null optional preview', () => {
    const h = setup(true, 2); h.store.begin(h.actor, h.record, 1, 'reject');
    h.store.setReason(h.actor, h.record, 'Rechazo sin aplicación'); h.store.review(h.actor, h.record);
    const reviewState = { ...h.current().reviewState!, preview: null } as unknown as NonNullable<Props['reconciliations']['reviewState']>;
    render(<h.Harness overrides={{ reviewState }} />);
    expect(screen.getByText('Sin cambios en el conteo ni en el stock.')).toBeTruthy();
    click('Confirmar rechazo'); expect(h.calls.confirm).toHaveBeenCalledTimes(1);
  });
  it('conflicting exact durable evidence is not confirmation or a new intent', () => {
    const h = ownAttempt('uncertain'); const raw = fixture(true);
    const state = h.store.state(h.actor, h.record); const key = state.attempts[0]!.payload.operation_key;
    raw.raw.lines[0]!.proposals[0]!.operation_key = key; raw.raw.operations[0]!.operation_key = key;
    const t = h.store.beginRead(h.actor, h.record)!; h.store.finishRead(t, raw.decode());
    render(<h.Harness />);
    expect(screen.getByRole('heading', { name: /Conflicto/ })).toBeTruthy();
    expect(screen.queryByText('Operación confirmada mediante evidencia exacta.')).toBeNull();
    expect(h.calls.confirm).not.toHaveBeenCalled(); expect(h.calls.retry).not.toHaveBeenCalled();
  });
  it('never exposes private data for a non-endpoint or a null record', () => {
    const h = setup(); const view = render(<TransferDispatchReconciliations record={h.record} actorLocation={3} reconciliations={h.current()} />);
    expect(screen.queryByText(/Despacho registrado/)).toBeNull();
    view.rerender(<TransferDispatchReconciliations record={null} actorLocation={1} reconciliations={h.current()} />);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText(/Brand/)).toBeNull();
    expect(h.calls.confirm).not.toHaveBeenCalled();
  });
  it('cancel is presentation-only and never invents a mutation or rollback', () => {
    const h = setup(); render(<h.Harness />); draft(); click('Cerrar');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.calls.confirm).not.toHaveBeenCalled(); expect(h.calls.retry).not.toHaveBeenCalled(); expect(h.calls.recover).not.toHaveBeenCalled();
    act(() => h.store.begin(h.actor, h.record, 2, 'propose'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
