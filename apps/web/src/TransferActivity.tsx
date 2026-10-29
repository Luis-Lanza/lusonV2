import type { TransferActivityEntry } from './transferModel';
import TransferDate from './TransferDate';

const labels: Record<string, Record<string, string>> = {
  transfer: { create: 'Transferencia creada', approve: 'Transferencia aprobada', reject: 'Transferencia rechazada', dispatch: 'Transferencia despachada', receive: 'Transferencia recibida', cancel: 'Transferencia cancelada' },
  count: { propose: 'Corrección de conteo propuesta', accept: 'Corrección de conteo aceptada', reject: 'Corrección de conteo rechazada' },
  restitution: { propose: 'Restitución propuesta', accept: 'Restitución aceptada', reject: 'Restitución rechazada' },
  reconciliation: { propose: 'Regularización de despacho propuesta', accept: 'Regularización de despacho aceptada', reject: 'Regularización de despacho rechazada' },
};

// Rendered inside the detail's existing mount-bound participant/history fence.
// Names are snapshots and React text, never markup or live directory lookups.
export default function TransferActivity({ activity }: { activity?: readonly TransferActivityEntry[] }) {
  return <section aria-label="Autoría personal">
    <h3>Autoría personal</h3>
    {activity?.length ? <>
      <ol>{activity.map((event, index) => <li key={index}>
        <h4>{labels[event.category][event.action]}</h4>
        <p><strong>{event.actor.display_name || event.actor.username}</strong> · Ubicación: {event.location_name}
          {event.variant_id !== undefined && <> · Variante {event.variant_id}</>}</p>
        <TransferDate value={event.recorded_at} />
      </li>)}</ol>
      <p>Las operaciones sin autor personal registrado conservan únicamente la responsabilidad de la ubicación.</p>
    </> : <p>Sin autor personal registrado; la responsabilidad histórica corresponde a la ubicación.</p>}
  </section>;
}
