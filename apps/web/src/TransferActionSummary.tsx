import type { MouseEvent } from 'react';
import { transferActionReasons, type TransferCounts } from './transferModel';
import { transferActionCategoryLabels } from './transferActionView';
import { Icon } from './icons';
import './transfer-actions.css';

export default function TransferActionSummary({ counts, busy, unavailable, location, compact, onShow, onRetry }: {
  counts: TransferCounts | null; busy: boolean; unavailable: boolean; location: string;
  compact: boolean; onShow: () => void; onRetry: () => void;
}) {
  const known = !busy && !unavailable ? counts : null;
  if (known?.action_count === 0n) return null;
  const title = unavailable ? 'Acciones pendientes no disponibles.' : !known ? 'Consultando acciones pendientes…'
    : `${known.action_count.toString()} ${known.action_count === 1n ? 'transferencia requiere' : 'transferencias requieren'} tu atención`;
  // Existing dialogs own background isolation; also reject synthetic retained clicks.
  const activate = (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    if (!event.currentTarget.closest('[inert]')) action();
  };
  return <section className={`transfer-action-summary${compact ? ' transfer-action-summary-compact' : ''}`}
    aria-label={compact ? 'Acciones pendientes de tu ubicación' : 'Contadores de solicitudes'} aria-busy={busy}>
    <div className="transfer-action-summary-top">
      <div className="transfer-action-summary-copy">
        {!compact && <span className="transfer-action-summary-icon"><Icon name="info" /></span>}
        <div><h2 aria-live="polite">{title}</h2><p>Acciones asignadas a {location}</p></div>
      </div>
      <div className="transfer-action-summary-controls">
        {unavailable && <button type="button" onClick={event => activate(event, onRetry)}>Reintentar acciones pendientes</button>}
        <button type="button" className="primary" onClick={event => activate(event, onShow)}>Ver acciones pendientes <Icon name="arrow" /></button>
      </div>
    </div>
    {!compact && <>
      {known && (known.actions ? <>
        <ul className="transfer-action-categories" aria-label="Tipos de acción pendientes">
          {transferActionReasons.map(reason => <li key={reason}><span>{transferActionCategoryLabels[reason]}</span><b>{known.actions![reason].toString()}</b></li>)}
        </ul>
        <p className="transfer-action-overlap">Una transferencia puede aparecer en varios tipos.</p>
      </> : <p className="transfer-action-overlap">Desglose de acciones no disponible.</p>)}
      <details className="transfer-action-help"><summary>Sobre los totales</summary>
        {known && <p>Pendientes de tu ubicación: {known.pending_total.toString()}</p>}
        <p>Totales independientes del filtro. Las acciones incluyen aprobar, despachar o recibir, y revisar conteos, restituciones o regularizaciones de despacho. Las regularizaciones se muestran como aviso de revisión, sin habilitar su decisión desde esta vista. Cada transferencia cuenta una sola vez en el total de atención.</p>
      </details>
    </>}
  </section>;
}
