import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TransferReview, { type TransferReviewProps } from './TransferReview';
import { addCartItem, createTransferCart, reviewCart } from './transferCart';
import { createTransferRecovery, type RecoverySnapshot } from './transferRecovery';
import type { TransferAuthority } from './useInventory';
import type { Metadata } from './model';
import { parseTransferRecord, type TransferRecord } from './transferModel';

const metadata: Metadata = { locations: [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }], brands: ['TOYO'] };
function setup(flow: 'requestWarehouse' | 'requestOther' | 'sendWarehouse' = 'requestWarehouse') {
  let authority: TransferAuthority = { ready: true, epoch: 4, session: { authenticated: true, csrf_token: 'current_csrf', expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: 2, username: 'test', location: metadata.locations[1] } } };
  const controller = { authorityEpoch: 4, getTransferAuthority: () => authority, subscribeTransferInvalidation: vi.fn(() => () => {}), settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const source = flow === 'sendWarehouse' ? 2 : flow === 'requestOther' ? 3 : 1;
  const catalog = { location: metadata.locations[source - 1], rows: [1, 2].map(id => ({ variant_id: id, catalog_entry_id: 1, brand: 'TOYO', model: `Private model ${id}`, capacity_ah: '75.125', polarity: id === 1 ? 'L' as const : 'R' as const,
    existing: 9223372036854775807n, reserved: 0n, available: 9223372036854775807n })) };
  let cart = createTransferCart(authority, flow, catalog);
  for (const id of [1, 2]) cart = addCartItem(cart, authority, id, '9223372036854775807');
  cart = reviewCart(cart, authority, 'review_private_retry_key');
  const recovery = createTransferRecovery(); recovery.capture(controller.getTransferAuthority, cart);
  const props: TransferReviewProps = { controller, metadata, ownerTag: '4/2/2', snapshot: recovery.getCurrent(controller.getTransferAuthority)!, busy: false, error: '', result: null,
    returnFocus: null, onBack: vi.fn(), onClose: vi.fn(), onEdit: vi.fn(), onSend: vi.fn() };
  return { props, set: (next: TransferAuthority) => { authority = next; }, get: () => authority };
}

describe('C2 original creation replay presents cancelled history', () => {
  it.each([false, true])('shows Cancelada without fabricated approval or new creation intent (approved=%s)', approved => {
    const h = setup();
    const wire = { id: '1001', reference: 'TR-1001', kind: 'request_stock', status: 'cancelled',
      created_at: '2028-01-01T00:00:00.123456789Z', creator_location_id: 2, creator_location_name: 'Sucursal A',
      origin_location_id: 1, origin_location_name: 'Almacén', destination_location_id: 2, destination_location_name: 'Sucursal A',
      approver_location_id: 1, approver_location_name: 'Almacén', cancellation_location_id: 2,
      cancelled_at: '2028-01-02T00:00:00.000000002Z',
      ...(approved ? { decision_location_id: 1, decided_at: '2028-01-02T00:00:00.000000001Z' } : {}),
      items: [{ variant_id: 1, brand: 'TOYO', model: 'Private model 1', capacity_ah: '75.125', polarity: 'L', quantity: '9223372036854775807' }] };
    render(<TransferReview {...h.props} result={{ record: parseTransferRecord(JSON.stringify(wire)), replayed: true }} />);
    const modal = screen.getByRole('dialog');
    expect(modal).toHaveAccessibleName('Solicitud Cancelada confirmada');
    expect(modal).toHaveTextContent('Estado: Cancelada');
    const cancelledTime = modal.querySelector(`time[datetime="${wire.cancelled_at}"]`);
    expect(cancelledTime).toHaveTextContent('01/01/2028 · 20:00 (hora Bolivia)');
    expect(cancelledTime).toHaveAttribute('title', wire.cancelled_at);
    expect(modal.querySelector(`time[datetime="${wire.created_at}"]`)).toHaveTextContent('31/12/2027 · 20:00 (hora Bolivia)');
    expect(modal).toHaveTextContent('TR-1001');
    expect(modal).not.toHaveTextContent(/quedará Pending|fue rechazada|está reservada/);
    expect(screen.getByText(/El servidor devolvió la solicitud original/)).toBeVisible();
    expect(h.props.onSend).not.toHaveBeenCalled();
    if (!approved) expect(modal.querySelector('time[datetime="2028-01-02T00:00:00.000000001Z"]')).toBeNull();
  });
});

describe('A05a terminal replay presentation', () => {
  it.each(['approved', 'rejected'] as const)('does not describe %s replay as Pending', status => {
    const h = setup();
    const record = { id: '1001', reference: 'TR-1001', kind: 'request_stock', status,
      created_at: '2028-01-01T00:00:00.123456789Z', creator_location_id: 2, creator_location_name: 'Sucursal A',
      origin_location_id: 1, origin_location_name: 'Almacén', destination_location_id: 2, destination_location_name: 'Sucursal A',
      approver_location_id: 1, approver_location_name: 'Almacén', decision_location_id: 1, decided_at: '2028-01-02T00:00:00.000000001Z',
      items: [{ variant_id: 1, brand: 'TOYO', model: 'Private model 1', capacity_ah: '75.125', polarity: 'L', quantity: '1' }] };
    render(<TransferReview {...h.props} result={{ record: parseTransferRecord(JSON.stringify(record)), replayed: true }} />);
    const label = status === 'approved' ? 'Aprobada' : 'Rechazada';
    expect(screen.getByRole('dialog')).toHaveAccessibleName(`Solicitud ${label} confirmada`);
    expect(screen.getByText(`Estado: ${label}`)).toBeVisible();
    expect(screen.queryByText(/La solicitud quedará Pending/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enviar la solicitud no reserva/)).not.toBeInTheDocument();
    expect(screen.getByText(/El servidor devolvió la solicitud original/)).toBeVisible();
    expect(screen.getByText('01/01/2028 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', record.decided_at);
    expect(screen.getByText('31/12/2027 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', record.created_at);
  });
});

it.each(['in_transit', 'received'])('presents readable persisted %s replay dates with exact evidence', status => {
  const h = setup();
  const record = parseTransferRecord(JSON.stringify({ id: '1001', reference: 'TR-1001', kind: 'request_stock', status,
    created_at: '2028-01-01T00:00:00.123456789Z', creator_location_id: 2, creator_location_name: 'Sucursal A',
    origin_location_id: 1, origin_location_name: 'Almacén', destination_location_id: 2, destination_location_name: 'Sucursal A',
    approver_location_id: 1, approver_location_name: 'Almacén', decision_location_id: 1, decided_at: '2028-01-02T00:00:00Z',
    dispatch_location_id: 1, dispatched_at: '2028-01-03T00:00:00.000000002Z',
    items: [{ variant_id: 1, brand: 'TOYO', model: 'Original', capacity_ah: '75.125', polarity: 'L', quantity: '1' }],
    ...(status === 'received' ? { receipt_location_id: 2, received_at: '2028-01-04T00:00:00.000000003Z',
      receipt: { items: [{ variant_id: 1, expected_quantity: '1', actual_quantity: '1', available_quantity: '1' }], exceptions: [] } } : {}),
  }));
  render(<TransferReview {...h.props} result={{ record, replayed: true }} />);
  const result = screen.getByRole('region', { name: 'Resultado confirmado' });
  expect(within(result).getByText('02/01/2028 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', '2028-01-03T00:00:00.000000002Z');
  if (status === 'received') expect(within(result).getByText('03/01/2028 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', '2028-01-04T00:00:00.000000003Z');
  expect(result.querySelectorAll('time')).toHaveLength(status === 'received' ? 4 : 3);
  for (const time of result.querySelectorAll('time')) expect(time).toHaveAttribute('title', time.getAttribute('datetime'));
  expect(h.props.onSend).not.toHaveBeenCalled();
});

describe('R05-U1 confirmed return guard', () => {
  it.each(['current', 'epoch', 'unready', 'account', 'inFlight'])('guards the Transfers return against latest %s authority', mode => {
    const h = setup();
    const record: TransferRecord = { id: '1001', reference: 'TR-1001', kind: 'request_stock' as const, status: 'pending' as const,
      created_at: '2028-01-01T00:00:00Z', creator_location_id: 2, creator_location_name: 'Sucursal A',
      origin_location_id: 1, origin_location_name: 'Almacén', destination_location_id: 2, destination_location_name: 'Sucursal A',
      approver_location_id: 1, approver_location_name: 'Almacén', items: [] };
    render(<TransferReview {...h.props} result={{ record, replayed: false }} busy={mode === 'inFlight'} />);
    const button = screen.getByRole('button', { name: 'Volver a transferencias' });
    const a = h.get();
    if (mode === 'epoch') h.set({ ...a, epoch: 5 });
    else if (mode === 'unready') h.set({ ...a, ready: false });
    else if (mode === 'account' && a.session?.authenticated) h.set({ ...a, session: { ...a.session, identity: { ...a.session.identity, account_id: 99 } } });
    fireEvent.click(button);
    if (mode === 'current') expect(h.props.onBack).toHaveBeenCalledOnce();
    else expect(h.props.onBack).not.toHaveBeenCalled();
  });
});

describe('R04b2c2 review dialog', () => {
  it.each(['requestWarehouse', 'requestOther', 'sendWarehouse'] as const)('shows exact physical route, approval and unbounded quantities for %s', flow => {
    const h = setup(flow); render(<TransferReview {...h.props} />);
    const dialog = screen.getByRole('dialog', { name: 'Revisar solicitud' });
    const expectedSource = flow === 'sendWarehouse' ? 'Sucursal A' : flow === 'requestOther' ? 'Sucursal B' : 'Almacén';
    const expectedDestination = flow === 'sendWarehouse' ? 'Almacén' : 'Sucursal A';
    const route = dialog.querySelector('.review-route')!;
    expect(route.textContent).toBe(`Origen${expectedSource}→Destino${expectedDestination}`);
    expect(dialog.querySelector('tfoot')).toHaveTextContent('2 variantes · 18446744073709551614 baterías');
    expect(within(dialog).getByLabelText('Total a transferir')).toHaveTextContent('18446744073709551614 baterías');
    expect(within(dialog).getAllByText('9223372036854775807')).toHaveLength(2); expect(within(dialog).getAllByText('75.125 Ah')).toHaveLength(2);
    expect(within(dialog).getByText('L')).toBeVisible(); expect(within(dialog).getByText('R')).toBeVisible();
    expect(dialog).toHaveTextContent(`pendiente de aprobación de ${flow === 'requestOther' ? 'Sucursal B' : 'Almacén'}`);
    expect(dialog).toHaveTextContent('no reserva ni mueve stock'); expect(dialog).not.toHaveTextContent('Crear y reservar');
    expect(dialog).not.toHaveTextContent('cancelarla'); expect(h.props.onSend).not.toHaveBeenCalled();
  });
  it('focuses close, traps Tab both ways, honors Escape, and restores the triggering element', () => {
    const trigger = document.createElement('button'); trigger.textContent = 'trigger'; document.body.append(trigger); trigger.focus();
    const h = setup(); const view = render(<TransferReview {...h.props} returnFocus={trigger} />);
    const close = screen.getByRole('button', { name: 'Cerrar revisión' }); const send = screen.getByRole('button', { name: 'Enviar solicitud' });
    expect(close).toHaveFocus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(send).toHaveFocus();
    fireEvent.keyDown(send, { key: 'Tab' }); expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' }); expect(h.props.onClose).toHaveBeenCalledOnce();
    view.unmount(); expect(trigger).toHaveFocus(); trigger.remove();
  });
  it('does not close, edit or submit while pending even with keyboard attempts', () => {
    const h = setup(); render(<TransferReview {...h.props} busy snapshot={{ ...h.props.snapshot, phase: 'inFlight' }} />);
    const dialog = screen.getByRole('dialog'); fireEvent.keyDown(dialog, { key: 'Escape' }); fireEvent.keyDown(dialog, { key: 'Tab' });
    for (const name of ['Cerrar revisión', 'Volver a editar', 'Enviar solicitud']) { const button = screen.getByRole('button', { name }); expect(button).toBeDisabled(); fireEvent.click(button); }
    expect(h.props.onClose).not.toHaveBeenCalled(); expect(h.props.onSend).not.toHaveBeenCalled(); expect(h.props.onEdit).not.toHaveBeenCalled();
  });
  it.each(['epoch', 'account', 'assignment', 'unready', 'anonymous', 'warehouse'])('fences raw snapshot/result payload getters synchronously for %s', changed => {
    const h = setup(); const a = h.get();
    if (changed === 'epoch') h.set({ ...a, epoch: 5 });
    else if (changed === 'unready') h.set({ ...a, ready: false });
    else if (changed === 'anonymous') h.set({ epoch: 4, ready: false, session: null });
    else if (a.session?.authenticated) h.set({ ...a, session: { ...a.session, identity: { ...a.session.identity,
      account_id: changed === 'account' ? 99 : 2, location: metadata.locations[changed === 'warehouse' ? 0 : changed === 'assignment' ? 2 : 1] } } });
    const forbidden: RecoverySnapshot = { ...h.props.snapshot, get epoch(): never { throw new Error('private snapshot accessed'); }, get items(): never { throw new Error('private items accessed'); } };
    render(<TransferReview {...h.props} snapshot={forbidden} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByText(/Private model/)).not.toBeInTheDocument();
  });
  it('rejects obsolete snapshot epoch before item getters even for a current owner', () => {
    const h = setup(); const snapshot: RecoverySnapshot = { ...h.props.snapshot, epoch: 3, get items(): never { throw new Error('private items accessed'); } };
    render(<TransferReview {...h.props} snapshot={snapshot} />); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('does not request list/detail or automatically send when mounted or rerendered', () => {
    const h = setup(); const fetcher = vi.spyOn(globalThis, 'fetch'); const view = render(<TransferReview {...h.props} />);
    view.rerender(<TransferReview {...h.props} snapshot={{ ...h.props.snapshot, phase: 'unknown' }} />);
    expect(fetcher).not.toHaveBeenCalled(); expect(h.props.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('Recargar o cerrar la pestaña pierde esta memoria'); fetcher.mockRestore();
  });
  it('distinguishes prepared review from an uncertain server operation', () => {
    const h = setup(); const view = render(<TransferReview {...h.props} />);
    expect(screen.getByText('Revisión preparada, todavía no enviada.')).toBeVisible();
    expect(screen.queryByText(/puede haberse creado/)).not.toBeInTheDocument();
    view.rerender(<TransferReview {...h.props} snapshot={{ ...h.props.snapshot, phase: 'unknown' }} />);
    expect(screen.getByText(/puede haberse creado/)).toBeVisible(); expect(screen.getByRole('button', { name: 'Reintentar misma solicitud' })).toBeEnabled();
  });
  it('keeps keyboard focus on the dialog when all controls become disabled during sending', () => {
    const h = setup(); const view = render(<TransferReview {...h.props} />);
    expect(screen.getByRole('button', { name: 'Cerrar revisión' })).toHaveFocus();
    view.rerender(<TransferReview {...h.props} busy snapshot={{ ...h.props.snapshot, phase: 'inFlight' }} />);
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});
