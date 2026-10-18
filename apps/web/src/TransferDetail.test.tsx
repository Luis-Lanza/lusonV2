import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferDetail from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import { parseTransferRecord, previewTransferReceipt } from './transferModel';
import type { DetailController } from './TransferDetail';
import type { TransferAuthority } from './useInventory';
import type { TransferCountCorrectionsProps } from './TransferCountCorrections';
import { createTransferRestitutionRecovery } from './transferRestitutionRecovery';
import { TransferAPIError } from './transferAPI';
import type { CountProposal } from './transferCountCorrectionModel';
import { decisionOwner } from './transferDecisionRecovery';
import type { CountCorrectionAttempt } from './transferCountCorrectionRecovery';

describe('U1 pending approver presentation', () => {
  it('keeps unknown stock advisory and recovers with passive refresh for the approver', async () => {
    let failing = true;
    const f = fixture(1, 2, 1, async () => failing ? Promise.reject(new Error('unavailable')) : catalog(1, 1, 2, '0'));
    render(<TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!}
      record={f.record} actions={() => <button>Review sentinel</button>} />);
    await screen.findByRole('alert');
    expect(screen.getByRole('table')).toHaveTextContent('Disponibilidad no disponible');
    expect(screen.getByRole('table')).not.toHaveTextContent('0 uds.');
    expect(screen.getByRole('button', { name: 'Review sentinel' })).toBeEnabled();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar stock de origen' }));
    await loaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('0 uds.');
    expect(screen.getByRole('button', { name: 'Review sentinel' })).toBeEnabled();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET'
      && new Headers(init.headers).get('X-Luson-Passive') === '1')).toBe(true);
  });
  it('groups products and actions with compact route and closed discoverable history', async () => {
    const f = fixture();
    render(<TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!}
      record={f.record} actions={() => <button>Review sentinel</button>} />);
    await loaded();
    const products = screen.getByRole('region', { name: 'Productos solicitados' });
    expect(products).toHaveTextContent('18446744073709551614');
    const table = within(products).getByRole('table');
    expect(table).toHaveTextContent('9223372036854775807');
    for (const row of table.querySelectorAll('tbody tr')) {
      expect(row.querySelector('[data-label="Solicitadas"]')).toHaveTextContent('9223372036854775807');
      expect(row.querySelector('[data-label="Disponibles en origen"]')).toHaveTextContent('9223372036854775807 uds.');
    }
    expect(within(products).getByRole('button', { name: 'Review sentinel' })).toBeVisible();
    expect(within(products).getByRole('button', { name: 'Actualizar stock de origen' })).toBeEnabled();
    expect(screen.getByLabelText('Ruta física')).toHaveTextContent('Almacén → Sucursal A');
    expect(screen.queryByRole('region', { name: 'Historial de la solicitud' })).not.toBeInTheDocument();
    const history = screen.getByRole('button', { name: 'Ver historial' });
    expect(history).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(history);
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toBeVisible();
    expect(history).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText('Ver desglose')).not.toBeInTheDocument();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });
});

describe('F4 pending proposal stock and hierarchy', () => {
  it.each([1, 2])('preserves loading, unknown, zero and exact stock for participant %s', async actor => {
    const waiting = deferred();
    let read = () => waiting.promise;
    const f = fixture(2, 1, actor, () => read());
    render(f.element());
    expect(document.querySelector('.transfer-pending-detail')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Productos propuestos' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Propuestas' })).toBeVisible();
    expect(screen.queryByRole('columnheader', { name: /Reservadas/ })).toBeNull();
    expect(screen.getByRole('table')).toHaveTextContent('Consultando stock…');
    expect(screen.getByRole('button', { name: 'Actualizar stock de origen' })).toBeDisabled();
    await act(async () => waiting.reject(new Error('unavailable')));
    expect(screen.getByRole('table')).toHaveTextContent('Disponibilidad no disponible');
    expect(screen.getByRole('alert')).toHaveTextContent('La propuesta completa sigue disponible para revisión.');
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    expect(screen.getByLabelText('Resumen de propuesta')).toHaveTextContent('Requiere aprobación deAlmacén');
    read = async () => catalog(2, 1, 2, '0');
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar stock de origen' }));
    await loaded();
    expect(screen.getByRole('table')).toHaveTextContent('0 uds.');
    read = async () => catalog(2);
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar stock de origen' }));
    await loaded();
    expect(screen.getByRole('table')).toHaveTextContent('9223372036854775807 uds.');
    expect(screen.queryByRole('button', { name: /Aprobar/ })).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.fetch.mock.calls.every(([url, init]) => String(url).includes('location_id=2')
      && init?.method === 'GET' && new Headers(init.headers).get('X-Luson-Passive') === '1')).toBe(true);
  });
});

describe('U2 approved stock request at physical origin', () => {
  it.each([[1, 2], [2, 3]])('shows immutable own reservations and closed audit history at origin %s', (origin, destination) => {
    const f = fixture(origin, destination, origin);
    const record = parseTransferRecord(JSON.stringify(wire(origin, destination, 'approved')));
    render(<TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!}
      record={record} actions={() => <><button>Dispatch sentinel</button><button>Cancel sentinel</button></>} />);
    const products = screen.getByRole('region', { name: 'Productos solicitados' });
    expect(products).toHaveTextContent('2 variantes · 18446744073709551614 baterías');
    expect(products).toHaveTextContent(`Las 18446744073709551614 baterías están reservadas en ${names[origin - 1]}. Pendiente de despacho.`);
    const table = within(products).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
      'Batería', 'Polaridad', 'Solicitadas', 'Reservadas para esta solicitud',
    ]);
    for (const row of table.querySelectorAll('tbody tr')) {
      expect(row.querySelector('[data-label="Solicitadas"]')).toHaveTextContent(/^9223372036854775807$/);
      expect(row.querySelector('[data-label="Reservadas para esta solicitud"]')).toHaveTextContent(/^9223372036854775807 uds\.$/);
      expect(row.querySelector('td small')).toHaveTextContent('75.125 Ah');
    }
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(products).getByRole('button', { name: 'Dispatch sentinel' })).toBeVisible();
    expect(within(products).getByRole('button', { name: 'Cancel sentinel' })).toBeVisible();
    expect(screen.getByLabelText('Ruta física')).toHaveTextContent(`${names[origin - 1]} → ${names[destination - 1]}`);
    expect(document.querySelector('.transfer-detail-summary')).toBeNull();
    expect(document.querySelector('.transfer-detail-cards')).toBeNull();
    expect(screen.queryByRole('button', { name: /Actualizar/ })).not.toBeInTheDocument();
    const history = screen.getByRole('button', { name: 'Ver historial' });
    expect(history).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Historial de la solicitud' })).not.toBeInTheDocument();
    fireEvent.click(history);
    const audit = screen.getByRole('region', { name: 'Historial de la solicitud' });
    expect(history).toHaveAttribute('aria-controls', audit.id);
    expect(audit).toHaveTextContent(`Ubicación: ${names[destination - 1]}`);
    expect(audit).toHaveTextContent(`Ubicación: ${names[origin - 1]}`);
    expect(within(audit).getByRole('heading', { name: 'Solicitud aprobada y stock reservado' })).toBeVisible();
    expect(audit.querySelectorAll('time')).toHaveLength(2);
    fireEvent.click(history);
    expect(history).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Historial de la solicitud' })).not.toBeInTheDocument();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(['destination', 'direct', 'send-to-warehouse', 'rejected'])('does not adapt the %s context', context => {
    const f = fixture(1, 2, context === 'destination' ? 2 : 1);
    const original = wire(context === 'send-to-warehouse' ? 2 : 1, context === 'send-to-warehouse' ? 1 : 2,
      context === 'rejected' ? 'rejected' : 'approved');
    const record = parseTransferRecord(JSON.stringify(context === 'direct' ? { ...original, kind: 'direct_shipment',
      creator_location_id: 1, creator_location_name: 'Almacén', decided_at: original.created_at } : original));
    render(f.element(record));
    expect(document.querySelector('.transfer-approved-detail')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ver historial' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toBeVisible();
    expect(screen.queryByRole('columnheader', { name: 'Reservadas para esta solicitud' })).not.toBeInTheDocument();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('F1 participant transit detail', () => {
  const routes = [
    ['request_stock', 1, 3], ['request_stock', 2, 3],
    ['direct_shipment', 1, 3], ['send_to_warehouse', 2, 1],
  ] as const;
  it.each(routes.flatMap(([kind, origin, destination]) => [origin, destination].map(actor => ({ kind, origin, destination, actor }))))(
    'shows immutable sent quantities and typed history for $kind at $actor', ({ kind, origin, destination, actor }) => {
    const f = fixture(origin, destination, actor);
    const original = wire(origin, destination, 'approved');
    const record = parseTransferRecord(JSON.stringify({ ...original, kind, status: 'in_transit',
      ...(kind === 'direct_shipment' ? { creator_location_id: origin, creator_location_name: names[origin - 1], decided_at: original.created_at } : {}),
      dispatch_location_id: origin, dispatched_at: '2028-01-03T00:00:00Z' }));
    render(<TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!}
      record={record} actions={() => <><button>Receive sentinel</button><p role="alert">Recovery sentinel</p></>} />);
    const products = screen.getByRole('region', { name: 'Productos enviados' });
    expect(products).toHaveTextContent('2 variantes · 18446744073709551614 baterías');
    expect(products).toHaveTextContent(`Pendiente de recepción en ${names[destination - 1]}. El stock todavía no fue acreditado.`);
    const table = within(products).getByRole('table', { name: 'Baterías enviadas' });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Batería', 'Polaridad', 'Enviadas']);
    for (const row of table.querySelectorAll('tbody tr')) {
      expect(row.querySelector('[data-label="Enviadas"]')).toHaveTextContent(/^9223372036854775807$/);
      expect(row.querySelector('td small')).toHaveTextContent('75.125 Ah');
    }
    expect(table).toHaveTextContent('Original · Immutable-1');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actualizar/ })).not.toBeInTheDocument();
    expect(document.querySelector('.transfer-detail-summary')).toBeNull();
    expect(products).not.toHaveTextContent(/Reserva propia consumida|Faltante|Exceso|Stock acreditado:/);
    expect(within(products).getByRole('button', { name: 'Receive sentinel' })).toBeVisible();
    expect(within(products).getByRole('alert')).toHaveTextContent('Recovery sentinel');
    expect(screen.getByLabelText('Ruta física')).toHaveTextContent(`${names[origin - 1]} → ${names[destination - 1]}`);
    expect(document.querySelector('.transfer-transit-heading')).toHaveTextContent(kind === 'direct_shipment'
      ? 'Envío directo de Almacén' : kind === 'send_to_warehouse' ? 'Propuesta de envío a Almacén' : 'Solicitud de stock');
    const historyLabel = kind === 'direct_shipment' ? 'Historial del envío'
      : kind === 'send_to_warehouse' ? 'Historial de la propuesta' : 'Historial de la solicitud';
    const toggle = screen.getByRole('button', { name: 'Ver historial' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: historyLabel })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const history = screen.getByRole('region', { name: historyLabel });
    expect(within(history).getByRole('heading', { level: 2, name: historyLabel })).toBeVisible();
    expect(toggle).toHaveAttribute('aria-controls', history.id);
    expect(within(history).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(kind === 'direct_shipment'
      ? ['Envío creado, autorizado y stock reservado', 'Envío despachado'] : kind === 'send_to_warehouse'
        ? ['Propuesta creada', 'Propuesta aprobada y stock reservado', 'Envío despachado']
        : ['Solicitud creada', 'Solicitud aprobada y stock reservado', 'Solicitud despachada']);
    expect(Array.from(history.querySelectorAll('time')).map(time => time.getAttribute('title'))).toEqual(kind === 'direct_shipment'
      ? [record.created_at, record.dispatched_at] : [record.created_at, record.decided_at, record.dispatched_at]);
    expect(history).toHaveTextContent(`Ubicación: ${record.creator_location_name}`);
    if (kind === 'direct_shipment') expect(history).not.toHaveTextContent(/aprob|Aprob/);
    else expect(history).toHaveTextContent(`Ubicación: ${record.approver_location_name}`);
    expect(history).toHaveTextContent(`Origen: ${record.origin_location_name}`);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: historyLabel })).not.toBeInTheDocument();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(['unrelated', 'approved'])('leaves %s outside the transit adaptation', context => {
    const origin = 1;
    const destination = 3;
    const f = fixture(origin, destination, context === 'unrelated' ? 2 : destination);
    const original = wire(origin, destination, 'approved');
    const record = parseTransferRecord(JSON.stringify({ ...original,
      ...(context === 'approved' ? {} : { status: 'in_transit', dispatch_location_id: origin, dispatched_at: '2028-01-03T00:00:00Z' }),
    }));
    render(f.element(record));
    expect(document.querySelector('.transfer-transit-detail')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Productos enviados' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toBeVisible();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('U4b effective received detail', () => {
  const routes = [
    ['request_stock', 1, 2], ['request_stock', 2, 3],
    ['direct_shipment', 1, 3], ['send_to_warehouse', 2, 1],
  ] as const;
  type Route = typeof routes[number];
  const participants = routes.flatMap(route => [route[1], route[2]].map(actor => ({ route, actor })));
  function received(assigned = 2, [kind, origin, destination]: Route = routes[0]) {
    const f = fixture(origin, destination, assigned); const original = wire(origin, destination, 'approved');
    const record = parseTransferRecord(JSON.stringify({ ...original, kind, status: 'received',
      ...(kind === 'direct_shipment' ? { creator_location_id: origin, creator_location_name: 'Almacén', decided_at: original.created_at } : {}),
      dispatch_location_id: origin, dispatched_at: '2028-01-03T00:00:00Z',
      receipt_location_id: destination, received_at: '2028-01-04T00:00:00Z',
      receipt: { items: original.items.map(i => ({ variant_id: i.variant_id, expected_quantity: i.quantity,
        actual_quantity: i.quantity, available_quantity: i.quantity })), exceptions: [] } }));
    if (record.status !== 'received') throw new Error('received fixture');
    const corrections: TransferCountCorrectionsProps['corrections'] = { snapshot: {
      request_id: BigInt(record.id), operations: [], lines: record.receipt.items.map(line => ({ ...line,
        workflow_revision: 2n, applied_revision: 1n, effective_actual: 3n, effective_credit: 3n, proposals: [] })) },
      busy: false, error: null, masked: false, attempts: [], refresh: vi.fn(async () => {}),
      propose: vi.fn(async () => {}), decide: vi.fn(async () => {}), retry: vi.fn(async () => {}), recover: vi.fn(async () => {}) };
    const element = (enabled = true, requestID = record.id, evidence = corrections) => <TransferDetail controller={f.controller}
      ownerTag={transferViewOwner(f.env.current)!} record={record} corrections={evidence}
      correctionsEnabled={enabled} correctionRequestID={requestID} actions={() => <button>Result sentinel</button>} />;
    return { ...f, record, corrections, element };
  }
  function outcome(assigned = 2, rejected = false, quantity = 1n, original = 0n, expected = 1n, route: Route = routes[0]) {
    const f = received(assigned, route);
    const items = f.record.items.map((item, index) => ({ ...item, quantity: index === 0 ? expected : 1n })).filter(item => item.quantity > 0n);
    const record = { ...f.record, items, receipt: previewTransferReceipt({ items: [
      { variant_id: 1, actual_quantity: original.toString() }, { variant_id: 2, actual_quantity: '1' }] }, { items }) };
    const proposal: CountProposal = { revision: 1n, operation_key: 'result_proposal_key', initiator_location_id: f.record.destination_location_id,
      actual_quantity: quantity, base_revision: 0n, base_credit: original < expected ? original : expected,
      reason: 'Recount', recorded_at: '2028-01-05T00:00:00Z', state: rejected ? 'rejected' : 'applied',
      decision: { operation_key: 'result_decision_key', actor_location_id: f.record.origin_location_id, accepted: !rejected,
        reason: 'Verified', recorded_at: '2028-01-06T00:00:00Z' },
      application: rejected ? null : { effective_credit: quantity < expected ? quantity : expected,
        delta: (quantity < expected ? quantity : expected) - (original < expected ? original : expected),
        recorded_at: '2028-01-06T00:00:00Z' } };
    const line = { ...record.receipt.items[0], workflow_revision: 1n, applied_revision: rejected ? 0n : 1n,
      effective_actual: rejected ? original : quantity,
      effective_credit: rejected ? proposal.base_credit : proposal.application!.effective_credit, proposals: [proposal] };
    const evidence = { ...f.corrections, snapshot: { request_id: BigInt(record.id), operations: [], lines: [line,
      { ...record.receipt.items[1], workflow_revision: 0n, applied_revision: 0n,
        effective_actual: 1n, effective_credit: 1n, proposals: [] }] } };
    const owner = transferViewOwner(f.env.current)!;
    const element = (enabled = true, requestID = record.id) => <TransferDetail controller={f.controller}
      ownerTag={owner} record={record} corrections={evidence} correctionsEnabled={enabled} correctionRequestID={requestID} />;
    const attempt = (phase: CountCorrectionAttempt['phase']): CountCorrectionAttempt => ({ requestID: BigInt(record.id),
      action: 'propose', payload: { variant_id: 1, operation_key: proposal.operation_key, expected_revision: 0n,
        actual_quantity: quantity, reason: 'Recount' }, owner: decisionOwner(f.controller.getTransferAuthority())!,
      phase, priorUncertainty: true, result: phase === 'confirmed' ? { request_id: BigInt(record.id), variant_id: 1,
        operation_key: proposal.operation_key, actor_location_id: 2, action: 'propose', expected_revision: 0n,
        revision: 1n, actual_quantity: quantity, reason: proposal.reason, recorded_at: proposal.recorded_at } : null, failure: null });
    return { ...f, record, proposal, line, evidence, element, attempt };
  }
  it.each(participants)('shares corrected received presentation for $route at $actor', ({ route, actor }) => {
    const f = outcome(actor, false, 1n, 0n, 2n, route);
    f.controller.restitutionRecovery = createTransferRestitutionRecovery();
    render(<TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!}
      record={f.record} corrections={f.evidence} correctionsEnabled correctionRequestID={f.record.id}
      restitutionsEnabled restitutionRequestID={f.record.id} />);
    expect(document.querySelector('.transfer-received-detail')).not.toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Resumen de solicitud' })).toBeNull();
    const effective = screen.getByRole('table', { name: 'Conteo efectivo' });
    expect(effective.querySelector('tbody [data-label="Recibidas efectivas"]')).toHaveTextContent(/^1$/);
    expect(effective.querySelector('tbody [data-label="Crédito efectivo"]')).toHaveTextContent(/^1$/);
    expect(effective).toHaveTextContent('Faltante: 1');
    expect(correctedHeading()).toHaveTextContent('Conteo corregido');
    expect(results()).toHaveTextContent('0 → 1');
    expect(results()).toHaveTextContent(f.record.origin_location_name);
    expect(screen.getByText(/no el stock actual/)).toBeVisible();
    const disclosure = screen.getByText('Ver recepción original').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    const original = disclosure.querySelector('table')!;
    const immutable = original.outerHTML;
    fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Corregir conteo', 'Restituciones de origen']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByText('Ver recepción original'));
    expect(original).toBeVisible();
    expect(original.querySelector('tbody [data-label="Recibidas físicamente"]')).toHaveTextContent(/^0$/);
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    const history = screen.getByRole('region', { name: route[0] === 'direct_shipment' ? 'Historial del envío'
      : route[0] === 'send_to_warehouse' ? 'Historial de la propuesta' : 'Historial de la solicitud' });
    expect(history).toHaveTextContent(route[0] === 'request_stock' ? 'Solicitud recibida' : 'Envío recibido');
    expect(history.querySelectorAll('time')).toHaveLength(route[0] === 'direct_shipment' ? 3 : 4);
    if (route[0] === 'direct_shipment') expect(history).not.toHaveTextContent(/aprob/i);
    expect(original.outerHTML).toBe(immutable);
    expect(f.fetch.mock.calls.every(([url, init]) => init?.method === 'GET'
      && (String(url).endsWith('/restitutions') || String(url).endsWith('/count-corrections')))).toBe(true);
  });
  const results = () => screen.queryByRole('region', { name: 'Resultados de corrección confirmados' });
  const resultBadges = () => document.querySelectorAll('.received-result-badge, .received-corrected');
  const correctedHeading = () => document.querySelector('.transfer-received-heading .received-result-badge');
  it.each([1, 2])('shares admitted application across heading, affected row and provenance for actor %s', assigned => {
    const f = outcome(assigned);
    Object.assign(f.evidence, { attempts: [f.attempt('confirmed')] });
    render(f.element());
    expect(correctedHeading()).toHaveTextContent('Conteo corregido');
    const rows = screen.getByRole('table', { name: 'Conteo efectivo' }).querySelectorAll('tbody tr');
    expect(rows[0]).toHaveClass('received-result-applied');
    expect(rows[0].querySelector('.received-corrected')).toHaveTextContent('Conteo corregido: 0 → 1');
    expect(rows[1]).not.toHaveClass('received-result-applied');
    expect(rows[1].querySelector('.received-corrected')).toBeNull();
    expect(results()).toHaveClass('received-result-provenance');
    expect(results()).toHaveTextContent('Cambio de crédito registrado en destino: +1');
    expect(screen.getByRole('button', { name: 'Gestiones' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Ver recepción original').closest('details')).not.toHaveAttribute('open');
  });
  it.each(['pending', 'rejected'] as const)('retains current application when latest proposal is %s', state => {
    const f = outcome();
    const later = { ...f.proposal, revision: 2n, operation_key: 'later_result_proposal', actual_quantity: 99n,
      base_revision: 1n, base_credit: 1n, state, application: null,
      decision: state === 'pending' ? null : { ...f.proposal.decision!, operation_key: 'later_result_decision', accepted: false } };
    f.line.proposals = [later, f.proposal]; f.line.workflow_revision = 2n;
    render(f.element());
    expect(correctedHeading()).toHaveTextContent('Conteo corregido');
    const table = screen.getByRole('table', { name: 'Conteo efectivo' });
    expect(table.querySelector('.received-corrected')).toHaveTextContent('0 → 1');
    expect(table).not.toHaveTextContent('99');
    expect(results()).toHaveTextContent('Cambio de crédito registrado en destino: +1');
    if (state === 'rejected') {
      expect(results()).toHaveTextContent('Propuesta de corrección rechazada');
      expect(results()!.querySelector('.count-evidence-rejected')).not.toHaveTextContent('Cambio de crédito');
    } else expect(results()).not.toHaveTextContent('99');
  });
  it('keeps quantity differences truthful after an admitted partial correction', () => {
    const f = outcome(2, false, 1n, 0n, 2n); render(f.element());
    expect(correctedHeading()).toHaveTextContent('Conteo corregido');
    expect(screen.getByRole('table', { name: 'Conteo efectivo' })).toHaveTextContent('Faltante: 1');
  });
  it.each([1, 2])('presents persisted applied and rejected provenance for actor %s', assigned => {
    const f = outcome(assigned); const view = render(f.element());
    expect(results()).toHaveTextContent('Corrección aplicada vigente en Izquierda [L]: 0 → 1');
    expect(results()).toHaveTextContent('Propuesta de Sucursal A · Aceptada por Almacén');
    expect(results()).toHaveTextContent('Cambio de crédito registrado en destino: +1');
    expect(screen.getByRole('button', { name: 'Gestiones' }).closest('footer')).toBe(results()!.closest('footer'));
    expect(results()!.closest('.transfer-received-products')).not.toBeNull();
    expect(screen.getByRole('table', { name: 'Conteo efectivo' }).querySelector('tbody [data-label="Recibidas efectivas"]')).toHaveTextContent(/^1$/);
    const r = outcome(assigned, true); view.rerender(r.element());
    expect(results()).toHaveTextContent('Propuesta de corrección rechazada en Izquierda [L]: 0 → 1');
    expect(results()).toHaveTextContent('Rechazada por Almacén');
    expect(results()).toHaveTextContent('Sin cambios en el conteo ni en el stock por este rechazo. El faltante permanece.');
    expect(results()).not.toHaveTextContent('Cambio de crédito');
    expect(screen.getByRole('button', { name: 'Gestiones' }).closest('footer')).toBe(results()!.closest('footer'));
    expect(resultBadges()).toHaveLength(0);
    expect(document.querySelector('.transfer-received-heading .received-difference')).toHaveTextContent('Faltante: 1');
  });
  it('shows a persisted rejection independently of acceptance', () => {
    const f = outcome(2, true); render(f.element());
    expect(results()).toHaveTextContent('Propuesta de corrección rechazada en Izquierda [L]: 0 → 1');
  });
  it.each([[0n, 1n, 1n, '-1'], [5n, 1n, 0n, '0'], [9007199254740993n, 0n, 9223372036854775807n, '+9007199254740993']])(
    'keeps exact credit arithmetic for actual %s/original %s/sent %s', (actual, original, sent, delta) => {
      const f = outcome(2, false, actual, original, sent);
      render(f.element());
      expect(results()).toHaveTextContent(`${original} → ${actual}`);
      expect(results()).toHaveTextContent(`Cambio de crédito registrado en destino: ${delta}`);
      expect(results()).not.toHaveTextContent('stock actual');
    });
  it('proves recursive applied baselines and later rejection without globally sorting variants', () => {
    const f = outcome(); const first = f.proposal;
    const second = { ...first, revision: 2n, operation_key: 'second_proposal_key', actual_quantity: 0n,
      base_revision: 1n, base_credit: 1n, decision: { ...first.decision!, operation_key: 'second_decision_key' },
      application: { ...first.application!, effective_credit: 0n, delta: -1n } };
    const third = { ...first, revision: 3n, operation_key: 'third_proposal_key', base_revision: 2n, base_credit: 0n,
      state: 'rejected' as const, application: null,
      decision: { ...first.decision!, operation_key: 'third_decision_key', accepted: false } };
    Object.assign(f.line, { workflow_revision: 3n, applied_revision: 2n, effective_actual: 0n,
      effective_credit: 0n, proposals: [third, first, second] });
    f.evidence.snapshot.lines[1] = { ...f.evidence.snapshot.lines[1], workflow_revision: 1n, applied_revision: 1n,
      proposals: [{ ...first, base_credit: 1n, application: { ...first.application!, delta: 0n } }] };
    render(f.element());
    expect(results()).toHaveTextContent('Corrección aplicada vigente en Izquierda [L]: 1 → 0');
    expect(results()).toHaveTextContent('Propuesta de corrección rechazada en Izquierda [L]: 0 → 1');
    expect(results()).toHaveTextContent('Corrección aplicada vigente en Derecha [R]: 1 → 1');
    expect(correctedHeading()).toHaveTextContent('Conteo corregido');
    expect(results()!.textContent!.indexOf('Izquierda')).toBeLessThan(results()!.textContent!.indexOf('Derecha'));
    const table = screen.getByRole('table', { name: 'Conteo efectivo' });
    expect(table.querySelector('tbody [data-label="Recibidas efectivas"]')).toHaveTextContent(/^0$/);
    expect(table.querySelector('tbody [data-label="Crédito efectivo"]')).toHaveTextContent(/^0$/);
  });
  it.each(['duplicate', 'missing', 'cycle', 'base-credit', 'revision', 'workflow', 'application', 'delta', 'cap',
    'effective-actual', 'effective-credit', 'decision', 'actor', 'initiator', 'negative', 'original', 'rejection-application',
    'missing-base', 'duplicate-key', 'application-time', 'rejected-accepted', 'prior-duplicate', 'prior-delta', 'prior-cycle'])('fails closed for %s proof', mode => {
    const f = outcome(2, mode === 'rejection-application' || mode === 'rejected-accepted'); const p = { ...f.proposal };
    f.line.proposals = [p];
    if (mode === 'duplicate') f.line.proposals.push(p);
    if (mode === 'missing') f.line.proposals = [];
    if (mode === 'cycle') Object.assign(p, { base_revision: 1n });
    if (mode === 'missing-base' || mode.startsWith('prior-')) {
      Object.assign(p, { revision: 2n, base_revision: 1n, base_credit: 1n, operation_key: 'next_proposal_key',
        decision: { ...p.decision!, operation_key: 'next_decision_key' }, application: { ...p.application!, delta: 0n } });
      Object.assign(f.line, { workflow_revision: 2n, applied_revision: 2n });
      if (mode.startsWith('prior-')) {
        const prior = { ...f.proposal, base_revision: mode === 'prior-cycle' ? 2n : 0n,
          application: { ...f.proposal.application!, delta: mode === 'prior-delta' ? 0n : 1n } };
        f.line.proposals.push(prior); if (mode === 'prior-duplicate') f.line.proposals.push(prior);
      }
    }
    if (mode === 'duplicate-key') Object.assign(p, { operation_key: p.decision!.operation_key });
    if (mode === 'application-time') Object.assign(p, { application: { ...p.application!, recorded_at: p.recorded_at } });
    if (mode === 'rejected-accepted') Object.assign(p, { decision: { ...p.decision!, accepted: true } });
    if (mode === 'base-credit') Object.assign(p, { base_credit: 1n });
    if (mode === 'revision') Object.assign(f.line, { applied_revision: 2n });
    if (mode === 'workflow') Object.assign(f.line, { workflow_revision: 2n });
    if (mode === 'application') Object.assign(p, { application: null });
    if (mode === 'delta') Object.assign(p, { application: { ...p.application!, delta: 0n } });
    if (mode === 'cap') Object.assign(p, { application: { ...p.application!, effective_credit: 2n } });
    if (mode === 'effective-actual') Object.assign(f.line, { effective_actual: 2n });
    if (mode === 'effective-credit') Object.assign(f.line, { effective_credit: 0n });
    if (mode === 'decision') Object.assign(p, { decision: { ...p.decision!, accepted: false } });
    if (mode === 'actor') Object.assign(p, { decision: { ...p.decision!, actor_location_id: 2 } });
    if (mode === 'initiator') Object.assign(p, { initiator_location_id: 3 });
    if (mode === 'negative') Object.assign(p, { actual_quantity: -1n });
    if (mode === 'original') Object.assign(f.line, { actual_quantity: 1n });
    if (mode === 'rejection-application') Object.assign(p, { application: { effective_credit: 1n, delta: 1n, recorded_at: p.recorded_at } });
    render(f.element()); expect(results()).toBeNull();
    expect(resultBadges()).toHaveLength(0);
  });
  it.each(['busy', 'error', 'null', 'mask', 'owner', 'request', 'record', 'disabled', 'missing-line', 'duplicate-line',
    'inFlight', 'uncertain', 'conflict', 'failed-uncertain', 'pending', 'superseded'])('suppresses new claims for %s', mode => {
    const f = outcome(); let enabled = true; let request = f.record.id;
    if (mode === 'busy') f.evidence.busy = true;
    if (mode === 'error') Object.assign(f.evidence, { error: new TransferAPIError('invalid_response', null, false, false, false, false, false, true) });
    if (mode === 'mask') f.evidence.masked = true;
    if (mode === 'null') Object.assign(f.evidence, { snapshot: null });
    const prior = mode === 'owner' ? render(f.element()) : null;
    if (mode === 'owner') f.env.current.sessionGeneration = 2;
    if (mode === 'request') request = '1';
    if (mode === 'record') f.evidence.snapshot.request_id = 1n;
    if (mode === 'disabled') enabled = false;
    if (mode === 'missing-line') f.evidence.snapshot.lines.pop();
    if (mode === 'duplicate-line') f.evidence.snapshot.lines.push(f.line);
    if (['inFlight', 'uncertain', 'conflict', 'failed-uncertain'].includes(mode)) Object.assign(f.evidence, {
      attempts: [f.attempt(mode === 'failed-uncertain' ? 'failed' : mode as CountCorrectionAttempt['phase'])] });
    if (mode === 'pending' || mode === 'superseded') {
      Object.assign(f.line, { applied_revision: 0n, effective_actual: 0n, effective_credit: 0n });
      Object.assign(f.proposal, { state: mode, decision: null, application: null });
    }
    if (prior) prior.rerender(f.element(enabled, request)); else render(f.element(enabled, request));
    expect(results()).toBeNull();
    expect(resultBadges()).toHaveLength(0);
    expect(document.querySelector('.received-result-provenance')).toBeNull();
    expect(document.querySelector('.received-result-applied')).toBeNull();
    if (mode !== 'pending' && mode !== 'superseded') {
      expect(document.querySelector('.received-result-differences')).toBeNull();
    }
  });
  it('allows confirmed historical attempts, keeps rejection shortage conditional and recovery mounted', () => {
    const f = outcome(2, true, 2n, 1n); Object.assign(f.evidence, { attempts: [f.attempt('confirmed')] });
    const view = render(f.element());
    expect(results()).toBeVisible(); expect(results()).not.toHaveTextContent('El faltante permanece');
    const disclosure = screen.getByText('Ver recepción original').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open'); fireEvent.click(screen.getByText('Ver recepción original'));
    const original = screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML;
    fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Corregir conteo' }));
    const workflow = screen.getByRole('region', { name: 'Correcciones de conteo' });
    f.evidence.busy = true; view.rerender(f.element());
    expect(results()).toBeNull(); expect(screen.getByRole('region', { name: 'Correcciones de conteo' })).toBe(workflow);
    expect(screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML).toBe(original);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.evidence.decide).not.toHaveBeenCalled();
  });
  it('keeps valid variants visible in original order while invalid proof remains silent', () => {
    const f = outcome(); const valid = { ...f.evidence.snapshot.lines[1], workflow_revision: 1n, applied_revision: 1n,
      proposals: [{ ...f.proposal, base_credit: 1n, application: { ...f.proposal.application!, delta: 0n } }] };
    f.line.proposals = []; f.evidence.snapshot.lines = [valid, f.line];
    render(f.element()); expect(results()).not.toHaveTextContent('Izquierda');
    expect(results()).toHaveTextContent('Derecha [R]: 1 → 1');
    expect(correctedHeading()).toBeNull();
    const rows = screen.getByRole('table', { name: 'Conteo efectivo' }).querySelectorAll('tbody tr');
    expect(rows[0].querySelector('.received-corrected')).toBeNull();
    expect(rows[1].querySelector('.received-corrected')).toHaveTextContent('Conteo corregido: 1 → 1');
  });
  it.each(participants)('exposes uncertainty recovery outside the closed original for $route at $actor', ({ route, actor }) => {
    const f = outcome(actor, false, 1n, 0n, 1n, route); Object.assign(f.evidence, { attempts: [f.attempt('uncertain')] }); render(f.element());
    expect(results()).toBeNull(); const recover = screen.getByRole('button', { name: 'Consultar resultado' });
    expect(screen.getByRole('button', { name: 'Gestiones' }).closest('.transfer-received-products')).not.toBeNull();
    expect(recover).toBeVisible(); fireEvent.click(recover); expect(f.evidence.recover).toHaveBeenCalledWith(1);
    expect(screen.getByText('Ver recepción original').closest('details')).not.toHaveAttribute('open');
  });
  it('keeps prior applied evidence separate from a later pending proposal', () => {
    const f = outcome(); const later = { ...f.proposal, revision: 2n, operation_key: 'pending_proposal_key',
      actual_quantity: 99n, base_revision: 1n, base_credit: 1n, state: 'pending' as const, decision: null, application: null };
    f.line.proposals = [later, f.proposal]; f.line.workflow_revision = 2n;
    render(f.element()); expect(results()).toHaveTextContent('0 → 1'); expect(results()).not.toHaveTextContent('99');
    expect(screen.getByRole('table', { name: 'Conteo efectivo' })).not.toHaveTextContent('99');
  });
  it('keeps one in-card menu slot across freshness changes while respecting the mask boundary', () => {
    const f = received(); f.controller.restitutionRecovery = createTransferRestitutionRecovery();
    const view = render(f.element());
    const trigger = screen.getByRole('button', { name: 'Gestiones' });
    expect(trigger.closest('.transfer-received-products')).not.toBeNull();
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: 'Corregir conteo' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Proponer corrección' })[0]);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Retained across freshness' } });
    const workflow = screen.getByRole('region', { name: 'Correcciones de conteo' });
    const workflows = workflow.closest('.transfer-detail-grid');
    for (const evidence of [{ ...f.corrections, busy: true }, { ...f.corrections,
      error: new TransferAPIError('invalid_response', null, false, false, false, false, false, true) }, f.corrections]) {
      view.rerender(f.element(true, f.record.id, evidence));
      expect(screen.getByRole('button', { name: 'Gestiones' })).toBe(trigger);
      expect(screen.getByRole('region', { name: 'Correcciones de conteo' })).toBe(workflow);
      expect(workflow.closest('.transfer-detail-grid')).toBe(workflows);
      expect(screen.getByLabelText('Motivo')).toHaveValue('Retained across freshness');
    }
    fireEvent.click(trigger);
    view.rerender(f.element(true, f.record.id, { ...f.corrections, masked: true }));
    expect(screen.getByRole('button', { name: 'Gestiones' })).toBe(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByLabelText('Motivo')).toBeNull();
    view.rerender(f.element());
    expect(screen.getByRole('button', { name: 'Gestiones' })).toBe(trigger);
    expect(screen.getAllByRole('button', { name: 'Gestiones' })).toHaveLength(1);
    expect(screen.queryByLabelText('Motivo')).toBeNull();
    expect(screen.getByText('Ver recepción original').closest('details')).not.toHaveAttribute('open');
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(participants)('routes two stable management contexts for $route at $actor', async ({ route, actor }) => {
    const f = received(actor, route); f.controller.restitutionRecovery = createTransferRestitutionRecovery();
    const element = (requestID = f.record.id) => <TransferDetail controller={f.controller}
      ownerTag={transferViewOwner(f.env.current)!} record={f.record} corrections={f.corrections}
      correctionsEnabled correctionRequestID={requestID} restitutionsEnabled restitutionRequestID={f.record.id} />;
    const view = render(element());
    const trigger = screen.getByRole('button', { name: 'Gestiones' });
    expect(screen.queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Corregir conteo', 'Restituciones de origen']);
    expect(screen.getByRole('menuitem', { name: 'Corregir conteo' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Restituciones de origen' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Corregir conteo' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); expect(trigger).toHaveFocus();
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: 'Corregir conteo' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Correcciones de conteo' })).toHaveFocus();
    fireEvent.click(screen.getAllByRole('button', { name: 'Proponer corrección' })[0]);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Keep this draft' } });
    const form = screen.getByRole('form', { name: 'Editar corrección' });
    fireEvent.click(screen.getByText('Ver recepción original'));
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: 'Restituciones de origen' }));
    expect(screen.getByRole('form', { name: 'Editar corrección' })).toBe(form);
    expect(screen.getByRole('heading', { name: 'Restituciones de origen' })).toHaveFocus();
    expect(screen.getByLabelText('Motivo')).toHaveValue('Keep this draft');
    view.rerender(element('another-request'));
    expect(screen.queryByRole('form', { name: 'Editar corrección' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menuitem', { name: 'Corregir conteo' })).not.toBeInTheDocument();
    expect(f.corrections.propose).not.toHaveBeenCalled();
    await act(async () => {});
  });
  it('starts original evidence closed without moving focus or enclosing current evidence and workflows', () => {
    const f = received(); render(f.element());
    const summary = screen.getByText('Ver recepción original');
    expect(summary.tagName).toBe('SUMMARY');
    const disclosure = summary.closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    expect(document.activeElement).toBe(document.body);
    const table = disclosure.querySelector('table')!;
    expect(table).not.toBeVisible();
    const effective = screen.getByRole('region', { name: 'Conteo efectivo confirmado' });
    fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Corregir conteo' }));
    const workflow = screen.getByRole('region', { name: 'Correcciones de conteo' });
    expect(disclosure).not.toContainElement(effective);
    expect(disclosure).not.toContainElement(workflow);
    expect(effective).toBeVisible();
    expect(workflow).toBeVisible();
    expect(effective.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute('open');
    expect(table).toBeVisible();
    expect(table).toHaveTextContent('9223372036854775807');
    expect(disclosure).toHaveTextContent('18446744073709551614');
    expect(effective).toHaveTextContent('6 baterías contabilizadas');
    const original = table.outerHTML;
    fireEvent.click(summary);
    expect(disclosure).not.toHaveAttribute('open');
    expect(table).not.toBeVisible();
    expect(table.outerHTML).toBe(original);
    expect(screen.getByRole('region', { name: 'Correcciones de conteo' })).toBe(workflow);
    expect(workflow).toBeVisible();
    expect(summary).toHaveFocus();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('keeps failed consultation and recovery outside the closed original evidence', () => {
    const f = received();
    const error = new TransferAPIError('invalid_response', null, false, false, false, false, false, true);
    const view = render(f.element(true, f.record.id, { ...f.corrections, error }));
    const disclosure = screen.getByText('Ver recepción original').closest('details')!;
    const workflow = screen.getByRole('region', { name: 'Correcciones de conteo' });
    const retry = screen.getByRole('button', { name: 'Reintentar conteo efectivo' });
    expect(disclosure).not.toHaveAttribute('open');
    expect(workflow).toBeVisible();
    expect(disclosure).not.toContainElement(workflow);
    expect(disclosure).not.toContainElement(retry);
    fireEvent.click(retry);
    expect(f.corrections.refresh).toHaveBeenCalledOnce();
    view.rerender(f.element());
    expect(workflow).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Corregir conteo' }));
    expect(screen.getByRole('region', { name: 'Correcciones de conteo' })).toBe(workflow);
    expect(screen.getByRole('region', { name: 'Conteo efectivo confirmado' })).toBeVisible();
    expect(disclosure).not.toHaveAttribute('open');
  });
  it.each([1, 2])('shows effective evidence, separate original and closed persisted history for participant %s', assigned => {
    const f = received(assigned); render(f.element());
    const effective = screen.getByRole('region', { name: 'Conteo efectivo confirmado' });
    expect(effective).toHaveTextContent('2 variantes · 6 baterías contabilizadas');
    expect(within(effective).getByRole('table')).toHaveTextContent('Recibidas efectivas');
    expect(effective).toHaveTextContent('Crédito efectivo');
    expect(effective).toHaveTextContent('no el stock actual');
    expect(effective).not.toHaveTextContent('Conteo corregido');
    expect(effective.querySelector('.received-corrected')).toBeNull();
    fireEvent.click(screen.getByText('Ver recepción original'));
    const original = screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML;
    expect(original).toContain('9223372036854775807');
    expect(screen.getByRole('button', { name: 'Result sentinel' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Historial de la solicitud' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' }).querySelectorAll('time')).toHaveLength(4);
    expect(screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML).toBe(original);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['pending', 'rejected'] as const)('keeps applied values despite a later %s proposal', state => {
    const f = received(); const line = f.corrections.snapshot!.lines[0];
    const proposals: readonly CountProposal[] = [{ revision: 2n, operation_key: 'later_proposal_key', initiator_location_id: 2,
      actual_quantity: 99n, base_revision: 1n, base_credit: 3n, reason: 'Later recount',
      recorded_at: '2028-01-05T00:00:00Z', state, application: null,
      decision: state === 'pending' ? null : { operation_key: 'reject_operation_key', actor_location_id: 1,
        accepted: false, reason: 'Rejected recount', recorded_at: '2028-01-06T00:00:00Z' } }];
    render(f.element(true, f.record.id, { ...f.corrections, snapshot: { ...f.corrections.snapshot!,
      lines: [{ ...line, proposals }, ...f.corrections.snapshot!.lines.slice(1)] } }));
    const effective = screen.getByRole('table', { name: 'Conteo efectivo' });
    expect(effective).not.toHaveTextContent('99');
    expect(effective.querySelector('tbody [data-label="Recibidas efectivas"]')).toHaveTextContent(/^3$/);
    expect(effective.querySelector('tbody [data-label="Crédito efectivo"]')).toHaveTextContent(/^3$/);
    expect(effective).not.toHaveTextContent('Conteo corregido');
    expect(effective.querySelector('.received-corrected')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Corregir conteo' }));
    expect(screen.getByRole('region', { name: 'Correcciones de conteo' })).toHaveTextContent(state === 'pending' ? 'Pendiente' : 'Rechazada');
  });
  it.each(participants)('marks retained busy evidence updating for $route at $actor', ({ route, actor }) => {
    const f = received(actor, route); const view = render(f.element());
    view.rerender(f.element(true, f.record.id, { ...f.corrections, busy: true }));
    const effective = screen.getByRole('region', { name: 'Conteo efectivo de recepción' });
    expect(effective).toHaveAttribute('aria-busy', 'true');
    expect(effective).toHaveTextContent('Actualizando');
    expect(effective).not.toHaveTextContent('Conteo efectivo confirmado');
    expect(effective).toHaveTextContent('6 baterías contabilizadas');
  });
  it.each(participants.flatMap(context => ['error', 'masked', 'missing', 'duplicate', 'request', 'original', 'disabled', 'selection']
    .map(mode => ({ ...context, mode }))))(
    'makes $mode evidence unavailable for $route at $actor without original fallback', ({ route, actor, mode }) => {
      const f = received(actor, route); const snapshot = f.corrections.snapshot!;
      const evidence = { ...f.corrections,
        error: mode === 'error' ? new TransferAPIError('invalid_response', null, false, false, false, false, false, true) : null,
        masked: mode === 'masked', snapshot: { ...snapshot,
          request_id: mode === 'request' ? 1n : snapshot.request_id,
          lines: mode === 'missing' ? snapshot.lines.slice(1) : mode === 'duplicate' ? [...snapshot.lines, snapshot.lines[0]]
            : mode === 'original' ? snapshot.lines.map(line => ({ ...line, actual_quantity: 1n })) : snapshot.lines } };
      render(f.element(mode !== 'disabled', mode === 'selection' ? '1' : f.record.id, evidence));
      expect(screen.getByRole('region', { name: 'Conteo efectivo de recepción' })).toHaveTextContent('Conteo efectivo no disponible');
      expect(screen.queryByRole('table', { name: 'Conteo efectivo' })).toBeNull();
      fireEvent.click(screen.getByText('Ver recepción original'));
      expect(screen.getByRole('table', { name: 'Detalle de recepción' })).toHaveTextContent('9223372036854775807');
      if (mode === 'missing') {
        fireEvent.click(screen.getByRole('button', { name: 'Reintentar conteo efectivo' }));
        expect(f.corrections.refresh).toHaveBeenCalledOnce();
      }
      expect(f.fetch).not.toHaveBeenCalled();
    });
  it.each(participants)('preserves exact zero-credit and non-netted quantities for $route at $actor', ({ route, actor }) => {
    const f = received(actor, route); const snapshot = { ...f.corrections.snapshot!,
      lines: f.corrections.snapshot!.lines.map(line => ({ ...line, effective_actual: 0n, effective_credit: 0n })) };
    const view = render(f.element(true, f.record.id, { ...f.corrections, snapshot }));
    expect(screen.getByRole('region', { name: 'Conteo efectivo confirmado' })).toHaveTextContent('0 baterías contabilizadas');
    const record = { ...f.record, receipt: { ...f.record.receipt, items: [...f.record.receipt.items,
      { variant_id: 99, expected_quantity: 0n, actual_quantity: 1n, available_quantity: 0n }] } };
    const evidence = { ...f.corrections, snapshot: { ...snapshot, lines: [snapshot.lines[0],
      { ...snapshot.lines[1], effective_actual: 9223372036854775809n },
      { variant_id: 99, expected_quantity: 0n, actual_quantity: 1n, available_quantity: 0n,
        effective_actual: 9007199254740993n, effective_credit: 0n, workflow_revision: 0n, applied_revision: 0n, proposals: [] }] } };
    view.rerender(<TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!}
      record={record} corrections={evidence} correctionsEnabled correctionRequestID={record.id} />);
    const effective = screen.getByRole('table', { name: 'Conteo efectivo' });
    expect(effective).toHaveTextContent('Variante 99 · identidad no disponible');
    expect(effective).toHaveTextContent('No enviada: 9007199254740993');
    expect(effective.querySelector('tr[data-variant-id="99"] [data-label="Crédito efectivo"]')).toHaveTextContent(/^0$/);
    expect(effective).toHaveTextContent('Faltante: 9223372036854775807');
    expect(effective).toHaveTextContent('Exceso: 2');
    fireEvent.click(screen.getByText('Ver recepción original'));
    const original = screen.getByRole('table', { name: 'Detalle de recepción' });
    const unexpected = original.querySelector('tr[data-variant-id="99"]')!;
    expect(unexpected).toHaveTextContent('Variante inesperada 99');
    expect(unexpected.querySelector('[data-label="Enviadas"]')).toHaveTextContent(/^0$/);
    expect(unexpected.querySelector('[data-label="Crédito original"]')).toHaveTextContent(/^0$/);
    expect(unexpected.querySelector('[data-label="Recibidas físicamente"]')).toHaveTextContent(/^1$/);
  });
  it('fences correction getters for nonparticipants and retires evidence after authority changes', () => {
    const f = received(3); const snapshot = Object.getOwnPropertyDescriptor(f.corrections, 'snapshot')!;
    Object.defineProperty(f.corrections, 'snapshot', { configurable: true, get: () => { throw new Error('private evidence'); } });
    const view = render(f.element());
    expect(document.querySelector('.transfer-received-detail')).toBeNull();
    expect(screen.queryByText('Ver recepción original')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Detalle de recepción' })).toBeVisible();
    view.unmount(); Object.defineProperty(f.corrections, 'snapshot', snapshot);
    const allowed = received(); const owner = transferViewOwner(allowed.env.current)!;
    const element = () => <TransferDetail controller={allowed.controller} ownerTag={owner} record={allowed.record}
      corrections={allowed.corrections} correctionsEnabled correctionRequestID={allowed.record.id} />;
    const active = render(element());
    allowed.env.current = { ...allowed.env.current, sessionGeneration: 2 };
    Object.defineProperty(allowed.corrections, 'snapshot', { get: () => { throw new Error('retired evidence'); } });
    active.rerender(element());
    expect(document.querySelector('.transfer-received-detail')).toBeNull();
  });
});

describe('F4a original receipt overview', () => {
  it('puts route, immutable totals and comparison before discrepancy lanes without inventing restitution balances', () => {
    const f = fixture(); const original = wire(1, 2, 'approved');
    const record = parseTransferRecord(JSON.stringify({ ...original, status: 'received',
      items: original.items.map(item => ({ ...item, quantity: '5' })),
      dispatch_location_id: 1, dispatched_at: '2028-01-03T00:00:00Z',
      receipt_location_id: 2, received_at: '2028-01-04T00:00:00Z',
      receipt: { items: [
        { variant_id: 1, expected_quantity: '5', actual_quantity: '2', available_quantity: '2' },
        { variant_id: 2, expected_quantity: '5', actual_quantity: '7', available_quantity: '5' },
        { variant_id: 3, expected_quantity: '0', actual_quantity: '4', available_quantity: '0' },
      ], exceptions: [
        { variant_id: 1, kind: 'shortage', quantity: '3' },
        { variant_id: 2, kind: 'excess', quantity: '2' },
        { variant_id: 3, kind: 'unexpected', quantity: '4' },
      ] } }));
    render(f.element(record));
    fireEvent.click(screen.getByText('Ver recepción original'));
    const overview = screen.getByRole('region', { name: 'Recepción original' });
    const metrics = within(overview);
    expect(metrics.getByText('Baterías enviadas').nextElementSibling).toHaveTextContent(/^10$/);
    expect(metrics.getByText('Recibidas físicamente (original)').nextElementSibling).toHaveTextContent(/^13$/);
    expect(metrics.getByText('Stock acreditado (recepción original)').nextElementSibling).toHaveTextContent(/^7$/);
    const table = screen.getByRole('table', { name: 'Detalle de recepción' });
    expect(overview.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(table).toHaveTextContent('75.125 Ah · Izquierda [L]');
    expect(table).toHaveTextContent('75.125 Ah · Derecha [R]');
    expect(table).toHaveTextContent('Faltante: 3');
    expect(table).toHaveTextContent('Exceso: 2');
    expect(table).toHaveTextContent('Variante inesperada 3');
    expect(table).toHaveTextContent('Inesperada: 4');
    expect(table.parentElement).toHaveClass('receipt-detail-comparison');
    expect(screen.queryByRole('table', { name: 'Baterías solicitadas' })).not.toBeInTheDocument();
    expect(document.querySelector('.transfer-detail-cards')).toBeNull();
    expect(overview).toHaveTextContent('Las correcciones posteriores muestran el conteo efectivo por separado');
    expect(overview).not.toHaveTextContent(/restituid|restituci|pendiente de resolución/i);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('W2 direct warehouse history', () => {
  it.each(['approved', 'in_transit', 'cancelled', 'received'])('retains creation authorization truthfully in %s history', status => {
    const f = fixture(); const original = wire(1, 2, 'approved');
    const record = parseTransferRecord(JSON.stringify({ ...original, kind: 'direct_shipment', status,
      creator_location_id: 1, creator_location_name: 'Almacén', decided_at: original.created_at,
      ...(status === 'cancelled' ? { cancellation_location_id: 1, cancelled_at: '2028-01-03T00:00:00Z' } : {}),
      ...(status === 'in_transit' || status === 'received' ? { dispatch_location_id: 1, dispatched_at: '2028-01-03T00:00:00Z' } : {}),
      ...(status === 'received' ? { receipt_location_id: 2, received_at: '2028-01-04T00:00:00Z',
        receipt: { items: original.items.map(item => ({ variant_id: item.variant_id, expected_quantity: item.quantity,
          actual_quantity: item.quantity, available_quantity: item.quantity })), exceptions: [] } } : {}) }));
    render(f.element(record));
    expect(!!document.querySelector('.transfer-received-detail')).toBe(status === 'received');
    if (status === 'received') {
      const summary = screen.getByText('Ver recepción original');
      expect(summary.closest('details')).not.toHaveAttribute('open');
      fireEvent.click(summary);
      expect(screen.getByRole('table', { name: 'Detalle de recepción' })).toBeVisible();
    } else expect(screen.queryByText('Ver recepción original')).not.toBeInTheDocument();
    const historyLabel = status === 'in_transit' || status === 'received' ? 'Historial del envío' : 'Historial de la solicitud';
    if (status === 'in_transit' || status === 'received') {
      expect(screen.queryByRole('region', { name: historyLabel })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    }
    const history = within(screen.getByRole('region', { name: historyLabel }));
    expect(history.getByRole('heading', { name: 'Envío creado, autorizado y stock reservado' })).toBeVisible();
    expect(history.queryByRole('heading', { name: 'Solicitud aprobada y stock reservado' })).not.toBeInTheDocument();
    expect(history.getByText('31/12/2027 · 20:00 (hora Bolivia)')).toHaveAttribute('title', original.created_at);
    expect(screen.queryByText('Decidida (UTC):')).not.toBeInTheDocument();
    if (status === 'approved') expect(screen.getAllByText('Pendiente de despacho').length).toBeGreaterThan(0);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

const names = ['Almacén', 'Sucursal A', 'Sucursal B'];
function wire(origin = 1, destination = 2, status = 'pending') {
  const creator = destination === 1 ? origin : destination;
  const approver = destination === 1 ? 1 : origin;
  return {
    id: '9007199254740993', reference: 'TR-9007199254740993', kind: destination === 1 ? 'send_to_warehouse' : 'request_stock', status,
    created_at: '2028-01-01T00:00:00.123456789Z',
    creator_location_id: creator, creator_location_name: names[creator - 1],
    origin_location_id: origin, origin_location_name: names[origin - 1],
    destination_location_id: destination, destination_location_name: names[destination - 1],
    approver_location_id: approver, approver_location_name: names[approver - 1],
    ...(status === 'pending' ? {} : { decision_location_id: approver, decided_at: '2028-01-02T00:00:00.000000001Z' }),
    items: [1, 2].map(variant_id => ({ variant_id, brand: 'Original', model: `Immutable-${variant_id}`,
      capacity_ah: '75.125', polarity: variant_id === 1 ? 'L' : 'R', quantity: '9223372036854775807' })),
  };
}
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function catalog(source: number, page = 1, total = 2, available = '9223372036854775807') {
  const length = Math.min(50, Math.max(0, total - (page - 1) * 50));
  const items = Array.from({ length }, (_, index) => {
    const variant = (page - 1) * 50 + index + 1;
    return `{"variant_id":${variant},"catalog_entry_id":1,"brand":"LIVE NOT ORIGINAL","model":"Different","capacity_ah":35,"polarity":"L","existing":${available},"reserved":0,"available":${available}}`;
  });
  return new Response(`{"location":{"id":${source},"name":"${names[source - 1]}"},"page":${page},"page_size":50,"total_variants":${total},"items":[${items.join(',')}]}`, { headers: { 'Content-Type': 'application/json' } });
}
function fixture(origin = 1, destination = 2, assigned = 1, override?: (url: string, init: RequestInit) => Promise<Response>) {
  const env: { current: TransferAuthority } = { current: { epoch: 1, ready: true, sessionGeneration: 1,
    session: { authenticated: true, csrf_token: 'a'.repeat(43), identity: { account_id: assigned, username: 'test', location: { id: assigned, name: names[assigned - 1] } }, expires_at: '2030-01-01T00:00:00Z' } } };
  const listeners = new Set<() => void>();
  const controller: DetailController = {
    authorityEpoch: 1, getTransferAuthority: () => env.current,
    subscribeTransferInvalidation: () => () => {},
    subscribeSourceInventoryInvalidation: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const),
  };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    return override ? override(url, init) : Promise.resolve(catalog(origin));
  });
  vi.stubGlobal('fetch', fetch);
  const ownerTag = transferViewOwner(env.current)!;
  const record = parseTransferRecord(JSON.stringify(wire(origin, destination)));
  const element = (value = record) => <TransferDetail controller={controller} ownerTag={ownerTag} record={value} />;
  return { env, controller, listeners, fetch, record, element };
}
async function loaded() { await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar stock de origen' })).toBeEnabled()); }
afterEach(() => vi.unstubAllGlobals());

describe('R6a optional detail restitution composition', () => {
  it('requires controller-owned recovery and explicit matching received selection without changing the receipt', async () => {
    const f = fixture(1, 2, 2); const original = wire(1, 2, 'approved');
    const record = parseTransferRecord(JSON.stringify({ ...original, status: 'received', dispatch_location_id: 1,
      dispatched_at: '2028-01-03T00:00:00Z', receipt_location_id: 2, received_at: '2028-01-04T00:00:00Z',
      receipt: { items: original.items.map(i => ({ variant_id: i.variant_id, expected_quantity: i.quantity, actual_quantity: i.quantity, available_quantity: i.quantity })), exceptions: [] } }));
    const element = (requestID = record.id, enabled = true) => <TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!}
      record={record} restitutionRequestID={requestID} restitutionsEnabled={enabled} />;
    const view = render(element());
    fireEvent.click(screen.getByText('Ver recepción original'));
    const disclosure = screen.getByText('Ver recepción original').closest('details')!;
    const receipt = screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML;
    expect(screen.queryByRole('region', { name: 'Restituciones de origen' })).not.toBeInTheDocument(); expect(f.fetch).not.toHaveBeenCalled();
    f.controller.restitutionRecovery = createTransferRestitutionRecovery();
    view.rerender(element('2')); expect(f.fetch).not.toHaveBeenCalled();
    view.rerender(element(record.id, false)); expect(f.fetch).not.toHaveBeenCalled();
    view.rerender(element()); expect(screen.getByRole('region', { name: 'Restituciones de origen' })).toBeVisible();
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    const workflow = screen.getByRole('region', { name: 'Restituciones de origen' });
    expect(disclosure).not.toContainElement(workflow);
    fireEvent.click(screen.getByText('Ver recepción original'));
    expect(workflow).toBeVisible();
    fireEvent.click(screen.getByText('Ver recepción original'));
    expect(screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML).toBe(receipt);
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
});

describe('C4b optional detail correction composition', () => {
  it('keeps legacy callers read-free and requires explicit matching selection and enablement', () => {
    const f = fixture(1, 2, 2); const original = wire(1, 2, 'approved');
    const record = parseTransferRecord(JSON.stringify({ ...original, status: 'received', dispatch_location_id: 1,
      dispatched_at: '2028-01-03T00:00:00Z', receipt_location_id: 2, received_at: '2028-01-04T00:00:00Z',
      receipt: { items: original.items.map(item => ({ variant_id: item.variant_id, expected_quantity: item.quantity,
        actual_quantity: item.quantity, available_quantity: item.quantity })), exceptions: [] } }));
    const corrections: TransferCountCorrectionsProps['corrections'] = { snapshot: null, busy: false, error: null,
      masked: false, attempts: [], refresh: vi.fn(async () => {}), propose: vi.fn(async () => {}),
      decide: vi.fn(async () => {}), retry: vi.fn(async () => {}), recover: vi.fn(async () => {}) };
    const view = render(f.element(record));
    fireEvent.click(screen.getByText('Ver recepción original'));
    const originalReceipt = screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML;
    const element = (requestID?: string | null, enabled?: boolean) => <TransferDetail controller={f.controller}
      ownerTag={transferViewOwner(f.env.current)!} record={record} corrections={corrections}
      correctionRequestID={requestID} correctionsEnabled={enabled} />;
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
    view.rerender(element());
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
    view.rerender(element('2', true));
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
    view.rerender(element(record.id, false));
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
    view.rerender(element(record.id, true));
    const section = screen.getByRole('region', { name: 'Correcciones de conteo' });
    expect(section).toHaveClass('count-corrections');
    const disclosure = screen.getByText('Ver recepción original').closest('details')!;
    expect(disclosure).not.toContainElement(section);
    expect(disclosure.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML).toBe(originalReceipt);
    expect(f.fetch).not.toHaveBeenCalled(); expect(corrections.propose).not.toHaveBeenCalled();
  });
});

describe('A06b persisted outcome and history', () => {
  it.each(['pending', 'approved', 'rejected'])('renders only persisted %s events and request-owned whole quantities', async status => {
    for (const [origin, destination] of [[1, 2], [1, 3], [2, 3], [3, 2], [2, 1], [3, 1]]) {
      for (const assigned of [origin, destination]) {
        const f = fixture(origin, destination, assigned);
        const record = parseTransferRecord(JSON.stringify(wire(origin, destination, status)));
        const view = render(f.element(record));
        if (status === 'pending') await loaded();
        const historyToggle = screen.queryByRole('button', { name: 'Ver historial' });
        if (historyToggle) fireEvent.click(historyToggle);
        const proposal = status === 'pending' && destination === 1;
        const history = screen.getByRole('region', { name: proposal ? 'Historial de la propuesta' : 'Historial de la solicitud' });
        const events = within(history).getAllByRole('listitem');
        expect(events).toHaveLength(status === 'pending' ? 1 : 2);
        expect(within(history).getAllByRole('list')).toHaveLength(1);
        expect(events[0]).toHaveTextContent(proposal ? 'Propuesta creada' : 'Solicitud creada');
        expect(events[0]).toHaveTextContent(`Ubicación: ${record.creator_location_name}`);
        expect(events[0].querySelector('time')).toHaveTextContent('31/12/2027 · 20:00 (hora Bolivia)');
        expect(events[0].querySelector('time')).toHaveAttribute('datetime', record.created_at);
        const metrics = screen.getByRole('region', { name: historyToggle ? proposal ? 'Productos propuestos' : 'Productos solicitados' : 'Cantidades de la solicitud' });
        expect(within(metrics).getByLabelText(proposal ? 'Baterías propuestas' : 'Baterías solicitadas')).toHaveTextContent(/^18446744073709551614$/);
        if (record.status === 'pending') {
          expect(within(metrics).queryByLabelText('Baterías reservadas en esta solicitud')).not.toBeInTheDocument();
          expect(history).not.toHaveTextContent(/aprobada|rechazada|reservad/i);
        } else {
          if (record.status !== 'approved' && record.status !== 'rejected') throw new Error('Expected persisted Approved or Rejected decision');
          expect(events[1]).toHaveTextContent(record.status === 'approved' ? 'Solicitud aprobada y stock reservado' : 'Solicitud rechazada');
          expect(events[1]).toHaveTextContent(`Ubicación: ${names[record.decision_location_id - 1]}`);
          expect(events[1].querySelector('time')).toHaveTextContent('01/01/2028 · 20:00 (hora Bolivia)');
          expect(events[1].querySelector('time')).toHaveAttribute('datetime', record.decided_at);
          if (historyToggle) {
            const reservations = metrics.querySelectorAll('[data-label="Reservadas para esta solicitud"]');
            expect(reservations).toHaveLength(2);
            for (const quantity of reservations) expect(quantity).toHaveTextContent(/^9223372036854775807 uds\.$/);
          } else expect(within(metrics).getByLabelText('Baterías reservadas en esta solicitud')).toHaveTextContent(
            record.status === 'approved' ? /^18446744073709551614$/ : /^0$/);
          expect(f.fetch).not.toHaveBeenCalled();
        }
        expect(history).not.toHaveTextContent(/test|Encargado|Empleado|motivo|despacho|recepción|cancel/i);
        expect(document.body).not.toHaveTextContent(/Disponible actual|Disponible restante|Reserva total/);
        expect(screen.queryByRole('button', { name: /Despachar|Recibir|Cancelar|Aprobar|Rechazar/ })).not.toBeInTheDocument();
        expect(screen.getByRole('table')).toHaveTextContent('75.125 Ah');
        view.unmount();
      }
    }
  });
  it('keeps unknown Pending stock separate from a persisted Rejected zero reservation', async () => {
    const f = fixture(2, 1, 1, async () => catalog(2, 1, 0));
    const view = render(f.element());
    await loaded();
    expect(screen.getByRole('table')).toHaveTextContent('Disponibilidad no disponible');
    expect(screen.queryByLabelText('Baterías reservadas en esta solicitud')).not.toBeInTheDocument();
    const rejected = parseTransferRecord(JSON.stringify(wire(2, 1, 'rejected')));
    view.rerender(f.element(rejected));
    expect(screen.getByLabelText('Baterías reservadas en esta solicitud')).toHaveTextContent(/^0$/);
    expect(screen.getByRole('table')).not.toHaveTextContent('Disponible');
    expect(screen.getByLabelText('Resumen de solicitud')).toHaveTextContent('No reserva ni mueve stock');
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each(['location', 'generation', 'unready'])('removes persisted private history and metrics after %s authority changes', mode => {
    const f = fixture(3, 2, 2);
    const record = parseTransferRecord(JSON.stringify(wire(3, 2, 'approved')));
    const view = render(f.element(record));
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toBeVisible();
    if (mode === 'unready') f.env.current.ready = false;
    if (mode === 'generation') f.env.current.sessionGeneration = 2;
    if (mode === 'location' && f.env.current.session?.authenticated) f.env.current.session.identity.location.id = 1;
    view.rerender(f.element(record));
    expect(screen.queryByRole('region', { name: 'Historial de la solicitud' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Cantidades de la solicitud' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/9007199254740993|2028-01|Immutable/);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('A06a immutable physical review', () => {
  it.each([[1, 2, 1], [1, 3, 3], [2, 3, 2], [3, 2, 3], [2, 1, 1], [3, 1, 3]])('reviews %s → %s for participant %s without a client actor substitution', async (origin, destination, assigned) => {
    const f = fixture(origin, destination, assigned);
    render(f.element());
    await loaded();
    const table = screen.getByRole('table', { name: destination === 1 ? 'Baterías propuestas' : 'Baterías solicitadas' });
    expect(document.body).toHaveTextContent('18446744073709551614');
    expect(within(table).getAllByText('9223372036854775807')).toHaveLength(2);
    expect(within(table).getAllByText('75.125 Ah')).toHaveLength(2);
    expect(Array.from(table.querySelectorAll('tbody tr')).map(row => row.getAttribute('data-variant-id'))).toEqual(['1', '2']);
    expect(table).toHaveTextContent('Original · Immutable-1');
    expect(table).toHaveTextContent('Izquierda [L]');
    expect(table).toHaveTextContent('Derecha [R]');
    expect(document.body).not.toHaveTextContent('LIVE NOT ORIGINAL');
    const historyToggle = screen.queryByRole('button', { name: 'Ver historial' });
    if (historyToggle) fireEvent.click(historyToggle);
    const metadata = screen.getByLabelText(historyToggle ? destination === 1 ? 'Historial de la propuesta' : 'Historial de la solicitud' : 'Resumen de solicitud');
    expect(within(metadata).getByText('31/12/2027 · 20:00 (hora Bolivia)')).toHaveAttribute('title', '2028-01-01T00:00:00.123456789Z');
    const summary = screen.getByLabelText(destination === 1 ? 'Resumen de propuesta' : 'Resumen de solicitud');
    expect(summary).toHaveTextContent(`Ubicación creadora${names[(destination === 1 ? origin : destination) - 1]}`);
    expect(summary).toHaveTextContent(`Requiere aprobación de${names[(destination === 1 ? 1 : origin) - 1]}`);
    expect(summary).toHaveTextContent(`${destination === 1 ? 'propuesta' : 'solicitud'} completa en ${names[origin - 1]}`);
    expect(summary).toHaveTextContent('no mueve existencias ni aumenta el stock del destino');
    const url = new URL(String(f.fetch.mock.calls[0][0]), 'http://localhost');
    expect(url.searchParams.get('location_id')).toBe(String(origin));
    expect(url.searchParams.get('page_size')).toBe('50');
    expect(f.fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(f.fetch.mock.calls[0][1]?.headers).get('X-Luson-Passive')).toBe('1');
    expect(document.querySelector('.transfer-detail-cards') !== null).toBe(assigned === 1 && !historyToggle);
    expect(document.body).not.toHaveTextContent('Verificadas en origen');
  });
  it.each(['approved', 'rejected'])('preserves truthful %s terminal metadata without loading a fabricated stock snapshot', async status => {
    for (const [origin, destination] of [[1, 2], [1, 3], [2, 3], [3, 2], [2, 1], [3, 1]]) {
      for (const assigned of [origin, destination]) {
        const f = fixture(origin, destination, assigned);
        const view = render(f.element(parseTransferRecord(JSON.stringify(wire(origin, destination, status)))));
        expect(f.fetch).not.toHaveBeenCalled();
        const historyToggle = screen.queryByRole('button', { name: 'Ver historial' });
        if (historyToggle) fireEvent.click(historyToggle);
        const metadata = screen.getByLabelText(historyToggle ? 'Historial de la solicitud' : 'Resumen de solicitud');
        expect(within(metadata).getByText('01/01/2028 · 20:00 (hora Bolivia)')).toHaveAttribute('title', '2028-01-02T00:00:00.000000001Z');
        expect(within(metadata).getByText('31/12/2027 · 20:00 (hora Bolivia)')).toHaveAttribute('title', '2028-01-01T00:00:00.123456789Z');
        expect(screen.queryByText('Esta solicitud todavía no reserva ni mueve stock.')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Actualizar stock de origen' })).not.toBeInTheDocument();
        expect(historyToggle ? screen.getByLabelText('Productos solicitados') : metadata).toHaveTextContent(
          status === 'approved' ? historyToggle ? `baterías están reservadas en ${names[origin - 1]}` : `solicitud completa está reservada en ${names[origin - 1]}` : 'No reserva ni mueve stock');
        expect(historyToggle ? screen.getByLabelText('Productos solicitados') : screen.getByRole('table')).toHaveTextContent('18446744073709551614');
        expect(screen.getByRole('table')).not.toHaveTextContent('Disponible');
        expect(screen.queryByText(/Encargado|Empleado|usuario/)).not.toBeInTheDocument();
        view.unmount();
      }
    }
  });
  it('loads the complete origin catalog across pages without changing original item order', async () => {
    const f = fixture(2, 1, 1, async url => catalog(2, Number(new URL(url, 'http://localhost').searchParams.get('page')), 51));
    render(f.element());
    await loaded();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(String(f.fetch.mock.calls[1][0])).toContain('page=2');
    expect(screen.getByRole('table')).toHaveTextContent('Original · Immutable-2');
    expect(screen.getByRole('table')).not.toHaveTextContent('Different');
  });
  it('never invents zero or a verified badge while loading', async () => {
    const d = deferred();
    const f = fixture(1, 2, 1, () => d.promise);
    render(f.element());
    expect(screen.getByRole('table')).toHaveTextContent('Consultando stock…');
    expect(screen.getByRole('table')).not.toHaveTextContent('0 disponibles');
    expect(screen.getByRole('table')).toHaveTextContent('9223372036854775807');
    await act(async () => d.resolve(catalog(1)));
    await loaded();
  });
  it.each([0, 1])('missing original variants in a valid catalog of %s rows remain unknown, not zero', async total => {
    const f = fixture(1, 2, 2, async () => catalog(1, 1, total));
    render(f.element());
    await loaded();
    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('Disponibilidad no disponible');
    expect(table).not.toHaveTextContent('0 disponibles');
    expect(within(table).getAllByText('9223372036854775807')).toHaveLength(2);
  });
  it.each([401, 403, 404, 503])('sanitizes stock HTTP %s without reading a private body or hiding immutable items', async status => {
    const text = vi.fn(async () => 'PRIVATE STOCK BODY');
    const response = { status, text } as unknown as Response;
    const f = fixture(1, 2, 2, async () => response);
    render(f.element());
    await screen.findByRole('alert');
    expect(text).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent('PRIVATE');
    expect(screen.getByRole('table')).toHaveTextContent('Original · Immutable-1');
    expect(screen.getByRole('table')).not.toHaveTextContent('0 disponibles');
    expect(f.controller.settleUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
  it('keeps all items visible under advisory shortage and never gates approval by a live catalog quantity', async () => {
    const f = fixture(1, 2, 2, async () => catalog(1, 1, 2, '0'));
    render(<TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!} record={f.record} actions={() => <button>Review sentinel</button>} />);
    await loaded();
    expect(screen.getByRole('table')).toHaveTextContent('0 uds.');
    expect(screen.getByRole('region', { name: 'Productos solicitados' })).toHaveTextContent('18446744073709551614');
    expect(screen.getByRole('button', { name: 'Review sentinel' })).toBeEnabled();
  });
  it('clears stale catalog immediately, coalesces dirty invalidations, and ignores the dirty result', async () => {
    let next: ReturnType<typeof deferred> | null = null;
    const f = fixture(1, 2, 2, async () => next ? next.promise : catalog(1));
    render(f.element());
    await loaded();
    next = deferred();
    act(() => { for (const listener of f.listeners) listener(); });
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('table')).not.toHaveTextContent('9223372036854775807 uds.');
    act(() => { for (const listener of f.listeners) { listener(); listener(); } });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const dirty = next;
    next = null;
    await act(async () => dirty.resolve(catalog(1, 1, 2, '17')));
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    await loaded();
    expect(screen.getByRole('table')).not.toHaveTextContent('17 uds.');
    expect(screen.getByRole('table')).toHaveTextContent('9223372036854775807 uds.');
    expect(f.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('X-Luson-Passive') === '1')).toBe(true);
  });
  it('a failed refresh removes old advisory values, and manual retry remains passive', async () => {
    let failing = false;
    const f = fixture(1, 2, 2, async () => failing ? Promise.reject(new Error('PRIVATE')) : catalog(1));
    render(f.element());
    await loaded();
    failing = true;
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar stock de origen' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('table')).not.toHaveTextContent('9223372036854775807 uds.');
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar stock de origen' }));
    await loaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(new Headers(f.fetch.mock.calls.at(-1)![1]?.headers).get('X-Luson-Passive')).toBe('1');
  });
  it.each(['unready', 'account', 'location', 'csrf', 'generation', 'username', 'expiry'])('fences retained stock callback and private render on in-place %s mutation', async mode => {
    const f = fixture(1, 2, 2);
    const view = render(f.element());
    await loaded();
    const button = screen.getByRole('button', { name: 'Actualizar stock de origen' });
    const session = f.env.current.session!;
    if (!session.authenticated) throw new Error('fixture');
    if (mode === 'unready') f.env.current.ready = false;
    if (mode === 'account') session.identity.account_id = 3;
    if (mode === 'location') session.identity.location.id = 3;
    if (mode === 'csrf') session.csrf_token = 'b'.repeat(43);
    if (mode === 'generation') f.env.current.sessionGeneration = 2;
    if (mode === 'username') session.identity.username = 'replacement';
    if (mode === 'expiry') session.expires_at = '2031-01-01T00:00:00Z';
    fireEvent.click(button);
    act(() => { for (const listener of f.listeners) listener(); });
    expect(f.fetch).toHaveBeenCalledOnce();
    view.rerender(f.element());
    expect(document.body).not.toHaveTextContent('Immutable');
    expect(document.body).not.toHaveTextContent('9007199254740993');
  });
  it.each(['success', '401'])('ignores an abort-ignoring old-authority %s stock completion', async outcome => {
    const d = deferred();
    const f = fixture(1, 2, 2, () => d.promise);
    const view = render(f.element());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    f.env.current.ready = false;
    view.rerender(f.element());
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => d.resolve(outcome === 'success' ? catalog(1) : new Response('PRIVATE', { status: 401 })));
    expect(document.body).not.toHaveTextContent('Immutable');
    expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
  });
  it('aborts on unmount and detaches passive subscriptions without altering the original record', async () => {
    const d = deferred();
    const f = fixture(1, 2, 2, () => d.promise);
    const before = JSON.stringify(f.record, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    const view = render(f.element());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    view.unmount();
    expect(f.listeners.size).toBe(0);
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => d.resolve(catalog(1)));
    expect(JSON.stringify(f.record, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBe(before);
  });
});
