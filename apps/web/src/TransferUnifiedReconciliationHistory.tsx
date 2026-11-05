import type { UnifiedReconciliations } from './transferUnifiedReconciliationModel';
import TransferDate from './shared/TransferDate';

const states = { pending: 'Pendiente de contraparte', superseded: 'Reemplazada · sin aplicación',
  rejected: 'Rechazada · sin aplicación', applied: 'Aplicada atómicamente' };
const signed = (value: bigint) => `${value > 0n ? '+' : ''}${value}`;

/** Read-only audit. Callers must fence snapshot visibility by owner and request. */
export default function TransferUnifiedReconciliationHistory({ snapshot }: { snapshot: UnifiedReconciliations | null }) {
  if (!snapshot) return null;
  return <section aria-label="Historial de conciliación unificada">
    <h2>Conciliaciones unificadas</h2>
    <p>La recepción original se conserva. Las propuestas pendientes o rechazadas no reemplazan el último acuerdo aplicado.</p>
    {snapshot.lines.map(line => {
      const original = snapshot.original.find(item => item.variant_id === line.variant_id)!;
      const current = snapshot.current.find(item => item.variant_id === line.variant_id)!;
      return <article key={line.variant_id}>
        <h3>Variante {line.variant_id}</h3>
        <p>Declaradas originalmente: {original.expected_quantity.toString()} · Recibidas originalmente: {original.actual_quantity.toString()} · Crédito original: {original.available_quantity.toString()}</p>
        <p><strong>{current.source === 'unified' ? 'Acuerdo vigente' : 'Sin acuerdo unificado aplicado'}</strong></p>
        <p>Despacho efectivo: {current.effective_dispatch.toString()} · Conteo efectivo: {current.effective_actual.toString()} · Crédito efectivo: {current.effective_credit.toString()}</p>
        <ol>{line.proposals.map(proposal => <li key={proposal.operation_key}>
          <h4>{states[proposal.state]}</h4>
          <p>Revisión {proposal.revision.toString()} · Propuesta por ubicación {proposal.initiator_location_id}</p>
          <TransferDate value={proposal.recorded_at} />
          <p>Salieron: {proposal.dispatch_quantity.toString()} · Llegaron: {proposal.arrival_quantity.toString()} · Retenidas: {proposal.retained_quantity.toString()}</p>
          <p>{proposal.reason}</p>
          {proposal.retained_at_origin && <p>Retención física confirmada por origen al proponer.</p>}
          {proposal.decision && <>
            <p>{proposal.decision.accepted ? 'Aceptada' : 'Rechazada'} por ubicación {proposal.decision.actor_location_id}: {proposal.decision.reason}</p>
            <TransferDate value={proposal.decision.recorded_at} />
            {proposal.decision.retained_at_origin && <p>Retención física confirmada por origen al aceptar.</p>}
          </>}
          {proposal.application && <p>Efectos registrados: origen {signed(proposal.application.source_delta)} · destino {signed(proposal.application.destination_delta)}.</p>}
        </li>)}</ol>
      </article>;
    })}
  </section>;
}
