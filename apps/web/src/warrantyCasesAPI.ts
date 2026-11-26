import {
  parseWarrantyCase, parseWarrantyLoan, parseWarrantyTray,
  warrantyAdvancePath, warrantyCasePath, warrantyClaimPath, warrantyDefectPath, warrantyDeliveryPath,
  warrantyLoanFatePath, warrantyLoansPath, warrantyNoticePath, warrantyTrayPath,
  type WarrantyAdvanceInput, type WarrantyCase, type WarrantyCaseRow, type WarrantyClaimInput,
  type WarrantyDefectInput, type WarrantyDeliveryInput, type WarrantyLoan, type WarrantyLoanFateStated,
  type WarrantyLoanInput, type WarrantyTrayFilter,
} from './warrantyCasesModel';

/**
 * Transport of the branch's side of the battery warranty case. Every answer is admitted only when it is
 * JSON of exactly the contract's shape (`apps/api/docs/warranty-cases.md`), and every write is frozen
 * before the first await, so a caller cannot reclassify an in-flight request by editing its draft.
 */

export type WarrantyCaseErrorCode =
  | 'invalid_request' | 'forbidden' | 'not_found' | 'method_not_allowed' | 'unauthenticated'
  | 'serial_not_sold' | 'no_warranty' | 'warranty_expired' | 'no_stock' | 'reserved_stock'
  | 'claim_only' | 'transition_not_allowed' | 'resolution_required' | 'resolution_final'
  | 'resolution_matrix' | 'resolution_pending' | 'warehouse_verdict' | 'notice_required'
  | 'already_released' | 'nothing_to_release' | 'loan_fate_final' | 'loan_fate_required' | 'no_loan'
  | 'factory_file_required' | 'factory_file_not_allowed' | 'reason_required'
  | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

/** The admitted refusal per HTTP status; nothing else can reach the screen. */
export const warrantyCaseAdmittedErrors: ReadonlyMap<number, readonly WarrantyCaseErrorCode[]> = new Map([
  [400, ['invalid_request', 'factory_file_required', 'factory_file_not_allowed', 'reason_required', 'loan_fate_required']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [405, ['method_not_allowed']],
  [409, ['serial_not_sold', 'no_warranty', 'warranty_expired', 'no_stock', 'reserved_stock', 'claim_only',
    'transition_not_allowed', 'resolution_required', 'resolution_final', 'resolution_matrix',
    'resolution_pending', 'warehouse_verdict', 'notice_required', 'already_released',
    'nothing_to_release', 'loan_fate_final', 'no_loan']],
  [503, ['service_unavailable']],
]);

/** Spanish message for every refusal, including the transport ones. Every one of them wrote nothing. */
export const warrantyCaseErrorMessages: Record<WarrantyCaseErrorCode, string> = {
  invalid_request: 'El servidor rechazó la operación: revisá los datos. No se registró nada.',
  forbidden: 'Esta cuenta no puede hacer esa operación sobre el caso. No se registró nada.',
  not_found: 'El caso no existe o no es de esta sucursal.',
  method_not_allowed: 'El servidor no admite esa operación.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se registró nada.',
  serial_not_sold: 'Ese número de serie no figura en ninguna venta: la garantía no se puede reclamar así.',
  no_warranty: 'Esa unidad se vendió sin plazo de garantía, así que no tiene cobertura que reclamar.',
  warranty_expired: 'El plazo de garantía de esa unidad ya venció y no se reinicia.',
  no_stock: 'La sucursal no tiene esa cantidad de baterías para dar de baja.',
  reserved_stock: 'Esa baja dejaría el saldo por debajo de lo reservado: no se puede dar de baja.',
  claim_only: 'El hallazgo en góndola no tiene cliente al que avisar ni unidad en custodia.',
  transition_not_allowed: 'El caso no puede pasar a esa etapa desde la que tiene. No se registró nada.',
  resolution_required: 'La etapa resuelta se alcanza con el veredicto, no con un tramo suelto.',
  resolution_final: 'El veredicto de este caso ya está dictado y es definitivo.',
  resolution_matrix: 'El veredicto no admite ese destino para las unidades del caso.',
  resolution_pending: 'La fábrica todavía no respondió: antes de eso no hay aviso ni liberación.',
  warehouse_verdict: 'En la puerta del Almacén el único veredicto posible es el rechazo.',
  notice_required: 'La liberación a stock exige el aviso registrado al cliente.',
  already_released: 'El aviso o la liberación de este caso ya se registró.',
  nothing_to_release: 'El caso no tiene ninguna unidad que liberar: su batería nunca volvió.',
  loan_fate_final: 'El desenlace de esa usada ya está decidido y no se reescribe.',
  loan_fate_required: 'Indicá qué pasó con la usada prestada.',
  no_loan: 'El caso no entregó ninguna usada, así que no hay comprobante que imprimir.',
  factory_file_required: 'El envío a fábrica exige el número de legajo.',
  factory_file_not_allowed: 'Sólo el envío a fábrica lleva número de legajo.',
  reason_required: 'La operación exige el motivo.',
  service_unavailable: 'El servicio no está disponible. No se pudo confirmar la operación.',
  invalid_response: 'La respuesta del servidor no es válida. No se pudo confirmar la operación.',
  network: 'No se pudo conectar con el servidor. Revisá la conexión e intentá de nuevo.',
  aborted: 'La operación se interrumpió. Revisá la conexión e intentá de nuevo.',
};

export const warrantyTrayUnavailable = 'No se pudieron consultar los casos de garantía. Revisá la conexión e intentá de nuevo.';
export const warrantyCaseUnavailable = 'No se pudo consultar el caso. Revisá la conexión e intentá de nuevo.';
export const warrantySaleUnavailable = 'No se pudo leer la venta del caso desde esta sucursal: el número de garantía y la serie son los del caso.';
export const warrantyCatalogueUnavailable = 'No se pudo consultar el catálogo de la sucursal. Revisá la conexión e intentá de nuevo.';

export class WarrantyCaseAPIError extends Error {
  constructor(public readonly code: WarrantyCaseErrorCode, public readonly status: number | null) {
    super(code); this.name = 'WarrantyCaseAPIError';
  }
}

const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;

function aborted(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
}

/** The error envelope of this contract: one stable code, and never a message the server did not send. */
function refusal(raw: string, status: number): WarrantyCaseErrorCode {
  const admitted = warrantyCaseAdmittedErrors.get(status);
  let code: unknown;
  try { code = (JSON.parse(raw) as Record<string, unknown>).error; } catch { throw new WarrantyCaseAPIError('invalid_response', status); }
  if (!admitted || typeof code !== 'string' || !(admitted as readonly string[]).includes(code)) {
    throw new WarrantyCaseAPIError('invalid_response', status);
  }
  return code as WarrantyCaseErrorCode;
}

export type WarrantyCasesAPI = ReturnType<typeof createWarrantyCasesAPI>;

export function createWarrantyCasesAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  async function read(path: string, signal?: AbortSignal): Promise<string> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      raw = await reply.text();
    } catch (error) {
      if (error instanceof WarrantyCaseAPIError) throw error;
      throw new WarrantyCaseAPIError(aborted(signal, error) ? 'aborted' : 'network', null);
    }
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw new WarrantyCaseAPIError('invalid_response', reply.status);
    if (reply.status !== 200) {
      const code = refusal(raw, reply.status);
      throw new WarrantyCaseAPIError(code, reply.status);
    }
    return raw;
  }

  async function write(path: string, body: string, csrf: string, status: number,
    signal?: AbortSignal): Promise<string> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body,
      });
      raw = await reply.text();
    } catch (error) {
      if (error instanceof WarrantyCaseAPIError) throw error;
      throw new WarrantyCaseAPIError(aborted(signal, error) ? 'aborted' : 'network', null);
    }
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw new WarrantyCaseAPIError('invalid_response', reply.status);
    if (reply.status !== status) {
      const code = refusal(raw, reply.status);
      throw new WarrantyCaseAPIError(code, reply.status);
    }
    return raw;
  }

  /** The payload and the token are captured before any await; a bad one never leaves this module. */
  function frozen<T>(body: () => unknown, csrf: string): { body: string; csrf: string; sent: T } {
    try {
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
      const sent = body() as T;
      return { body: JSON.stringify(sent), csrf, sent };
    } catch (error) {
      if (error instanceof WarrantyCaseAPIError) throw error;
      throw new WarrantyCaseAPIError('invalid_request', null);
    }
  }

  return {
    /** The tray of the session's branch, newest first, filtered by phase and by origin. */
    async tray(filter: WarrantyTrayFilter = {}, signal?: AbortSignal): Promise<readonly WarrantyCaseRow[]> {
      let path: string;
      try { path = warrantyTrayPath(filter); } catch { throw new WarrantyCaseAPIError('invalid_request', null); }
      const raw = await read(path, signal);
      try { return parseWarrantyTray(raw); } catch { throw new WarrantyCaseAPIError('invalid_response', null); }
    },

    /** One case with its loans and its append-only history. */
    async detail(id: number, signal?: AbortSignal): Promise<WarrantyCase> {
      let path: string;
      try { path = warrantyCasePath(id); } catch { throw new WarrantyCaseAPIError('invalid_request', null); }
      const raw = await read(path, signal);
      let record: WarrantyCase;
      try { record = parseWarrantyCase(raw); } catch { throw new WarrantyCaseAPIError('invalid_response', null); }
      // A reply about another case is never evidence about the one that asked.
      if (record.id !== id) throw new WarrantyCaseAPIError('invalid_response', null);
      return record;
    },

    /** The first door: the serial the client brought under warranty (S1, S2). */
    async openClaim(input: () => WarrantyClaimInput, csrf: string, signal?: AbortSignal): Promise<WarrantyCase> {
      const frozenInput = frozen<WarrantyClaimInput>(input, csrf);
      let record: WarrantyCase;
      try { record = parseWarrantyCase(await write(warrantyClaimPath, frozenInput.body, frozenInput.csrf, 201, signal)); }
      catch (error) {
        if (error instanceof WarrantyCaseAPIError) throw error;
        throw new WarrantyCaseAPIError('invalid_response', null);
      }
      // The case must state the serial and the failure that were just sent, and it is a claim.
      if (record.origin !== 'warranty_claim' || record.serial_number !== frozenInput.sent.serial_number
        || record.declared_failure !== frozenInput.sent.declared_failure) {
        throw new WarrantyCaseAPIError('invalid_response', 201);
      }
      return record;
    },

    /** The second door: the battery the branch found failed on its own shelf (S1, S16). */
    async openDefect(input: () => WarrantyDefectInput, csrf: string, signal?: AbortSignal): Promise<WarrantyCase> {
      const frozenInput = frozen<WarrantyDefectInput>(input, csrf);
      let record: WarrantyCase;
      try { record = parseWarrantyCase(await write(warrantyDefectPath, frozenInput.body, frozenInput.csrf, 201, signal)); }
      catch (error) {
        if (error instanceof WarrantyCaseAPIError) throw error;
        throw new WarrantyCaseAPIError('invalid_response', null);
      }
      if (record.origin !== 'stock_defect' || record.variant_id !== frozenInput.sent.variant_id
        || record.quantity !== frozenInput.sent.quantity || record.reason !== frozenInput.sent.reason) {
        throw new WarrantyCaseAPIError('invalid_response', 201);
      }
      return record;
    },

    /** One used battery handed to the client of a case (S5, S6). */
    async addLoan(id: number, input: () => WarrantyLoanInput, csrf: string, signal?: AbortSignal): Promise<WarrantyLoan> {
      let path: string;
      try { path = warrantyLoansPath(id); } catch { throw new WarrantyCaseAPIError('invalid_request', null); }
      const frozenInput = frozen<WarrantyLoanInput>(input, csrf);
      let loan: WarrantyLoan;
      try { loan = parseWarrantyLoan(await write(path, frozenInput.body, frozenInput.csrf, 201, signal)); }
      catch (error) {
        if (error instanceof WarrantyCaseAPIError) throw error;
        throw new WarrantyCaseAPIError('invalid_response', null);
      }
      const sent = frozenInput.sent;
      if (loan.model !== sent.model || loan.quantity !== sent.quantity
        || loan.serial_number !== sent.serial_number || loan.source_location_id !== sent.source_location_id
        || loan.fate !== 'open') {
        throw new WarrantyCaseAPIError('invalid_response', 201);
      }
      return loan;
    },

    /** What became of one lent battery: `failed` is marked and replaced, never rewritten (S7). */
    async decideLoan(id: number, ordinal: number, fate: WarrantyLoanFateStated, csrf: string,
      signal?: AbortSignal): Promise<WarrantyLoan> {
      let path: string;
      try { path = warrantyLoanFatePath(id, ordinal); } catch { throw new WarrantyCaseAPIError('invalid_request', null); }
      const frozenInput = frozen<{ readonly fate: WarrantyLoanFateStated }>(() => ({ fate }), csrf);
      let loan: WarrantyLoan;
      try { loan = parseWarrantyLoan(await write(path, frozenInput.body, frozenInput.csrf, 200, signal)); }
      catch (error) {
        if (error instanceof WarrantyCaseAPIError) throw error;
        throw new WarrantyCaseAPIError('invalid_response', null);
      }
      if (loan.ordinal !== ordinal || loan.fate !== frozenInput.sent.fate || loan.fate_decided_at === null) {
        throw new WarrantyCaseAPIError('invalid_response', 200);
      }
      return loan;
    },

    /** The tramo of the branch's own journey (S4, S9). */
    async advance(id: number, input: WarrantyAdvanceInput, csrf: string, signal?: AbortSignal): Promise<WarrantyCase> {
      let path: string;
      try { path = warrantyAdvancePath(id); } catch { throw new WarrantyCaseAPIError('invalid_request', null); }
      const frozenInput = frozen<WarrantyAdvanceInput>(() => input, csrf);
      let record: WarrantyCase;
      try { record = parseWarrantyCase(await write(path, frozenInput.body, frozenInput.csrf, 200, signal)); }
      catch (error) {
        if (error instanceof WarrantyCaseAPIError) throw error;
        throw new WarrantyCaseAPIError('invalid_response', null);
      }
      if (record.id !== id || record.phase !== frozenInput.sent.phase) {
        throw new WarrantyCaseAPIError('invalid_response', 200);
      }
      return record;
    },

    /** The notice the branch registers once the factory answered (S14). */
    async notice(id: number, body: () => { readonly note: string }, csrf: string, signal?: AbortSignal): Promise<WarrantyCase> {
      let path: string;
      try { path = warrantyNoticePath(id); } catch { throw new WarrantyCaseAPIError('invalid_request', null); }
      const frozenInput = frozen<{ readonly note: string }>(body, csrf);
      let record: WarrantyCase;
      try { record = parseWarrantyCase(await write(path, frozenInput.body, frozenInput.csrf, 200, signal)); }
      catch (error) {
        if (error instanceof WarrantyCaseAPIError) throw error;
        throw new WarrantyCaseAPIError('invalid_response', null);
      }
      if (record.id !== id || !record.events.some(entry => entry.kind === 'notice')) {
        throw new WarrantyCaseAPIError('invalid_response', 200);
      }
      return record;
    },

    /** The delivery of the exchange: it closes the case and settles every open loan (S4, S13). */
    async deliver(id: number, input: WarrantyDeliveryInput, csrf: string, signal?: AbortSignal): Promise<WarrantyCase> {
      let path: string;
      try { path = warrantyDeliveryPath(id); } catch { throw new WarrantyCaseAPIError('invalid_request', null); }
      const frozenInput = frozen<WarrantyDeliveryInput>(() => input, csrf);
      let record: WarrantyCase;
      try { record = parseWarrantyCase(await write(path, frozenInput.body, frozenInput.csrf, 200, signal)); }
      catch (error) {
        if (error instanceof WarrantyCaseAPIError) throw error;
        throw new WarrantyCaseAPIError('invalid_response', null);
      }
      if (record.id !== id || record.phase !== 'closed') throw new WarrantyCaseAPIError('invalid_response', 200);
      return record;
    },
  };
}
