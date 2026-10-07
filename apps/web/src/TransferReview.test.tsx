import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TransferReview, { type TransferReviewProps } from './TransferReview';
import { addCartItem, createTransferCart, reviewCart } from './transferCart';
import { createTransferRecovery, type RecoverySnapshot } from './transferRecovery';
import type { TransferAuthority } from './useInventory';
import type { Metadata } from './model';

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

describe('R04b2c2 review dialog', () => {
  it.each(['requestWarehouse', 'requestOther', 'sendWarehouse'] as const)('shows exact physical route, approval and unbounded quantities for %s', flow => {
    const h = setup(flow); render(<TransferReview {...h.props} />);
    const dialog = screen.getByRole('dialog', { name: 'Revisar solicitud' });
    const expectedSource = flow === 'sendWarehouse' ? 'Sucursal A' : flow === 'requestOther' ? 'Sucursal B' : 'Almacén';
    const expectedDestination = flow === 'sendWarehouse' ? 'Almacén' : 'Sucursal A';
    const route = dialog.querySelector('.review-route')!;
    expect(route.textContent).toBe(`Origen${expectedSource}→Destino${expectedDestination}`);
    expect(within(dialog).getByText('2 variantes · 18446744073709551614 baterías')).toBeVisible();
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
