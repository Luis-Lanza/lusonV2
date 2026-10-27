import type { TransferActionReason, TransferRecord } from './transferModel';

export const transferActionLabels: Record<TransferActionReason, string> = {
  approve: 'Aprobar o rechazar',
  dispatch: 'Despachar',
  receive: 'Recibir',
  review_count: 'Revisar conteo',
  review_restitution: 'Revisar restitución',
  review_dispatch_reconciliation: 'Revisar regularización',
};
export const transferActionCategoryLabels: Record<TransferActionReason, string> = {
  approve: 'Por aprobar',
  dispatch: 'Por despachar',
  receive: 'Por recibir',
  review_count: 'Conteos por revisar',
  review_restitution: 'Restituciones por revisar',
  review_dispatch_reconciliation: 'Regularizaciones por revisar',
};

// Only an explicit server-owned empty set permits waiting/finished copy.
export function transferActionWaiting(record: TransferRecord, reasons: readonly TransferActionReason[] | undefined): string {
  if (reasons === undefined) return 'Acción no disponible';
  if (record.status === 'pending') return `Esperando a ${record.approver_location_name}`;
  if (record.status === 'approved') return `Esperando a ${record.origin_location_name}`;
  if (record.status === 'in_transit') return `Esperando a ${record.destination_location_name}`;
  return 'Sin acción pendiente';
}
