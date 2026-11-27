import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, type Session } from './harness';

/**
 * The three loan facts the warranty suite still asserted only indirectly, read through the same two
 * seams as `harness.ts` and nothing more: the browser for the operator's act and the public HTTP
 * contract of the same session for the arrange and for the stored values (S35, last paragraph).
 *
 * The receipt is a real PDF download. Its renderer writes the page uncompressed on purpose
 * (`apps/api/internal/warrantycase/receipt.go:18`, `:159`), so the text-showing operators of the
 * content stream are greppable: this file reads the paper the client really receives instead of
 * asserting a file name and a content type. The document contract the server promises — one A4 page,
 * `%PDF-` bytes, a stable name, the headers of a download — is asserted on top of the text.
 */

// ---------------------------------------------------------------------------------
// Reading the persisted case: the loans with their own fate, their date and their origin
// ---------------------------------------------------------------------------------

export interface LoanRecord {
  readonly ordinal: number;
  readonly model: string;
  readonly quantity: number;
  readonly serial_number: string;
  readonly source_location_id: number;
  /** The instant the database stamped on the handover, published in UTC. */
  readonly given_at: string;
  readonly fate: string;
  readonly fate_decided_at: string | null;
}

export interface CaseWithLoans {
  readonly id: number;
  readonly case_number: string;
  readonly phase: string;
  readonly origin: string;
  readonly serial_number: string | null;
  readonly loans: readonly LoanRecord[];
}

function failure(where: string, status: number, text: string): never {
  throw new Error(`${where} respondió ${status}: ${text}`);
}

export async function caseWithLoans(session: Session, caseId: number): Promise<CaseWithLoans> {
  const path = `/api/warranty-cases/${caseId}`;
  const reply = await session.request.get(path);
  const text = await reply.text();
  if (reply.status() !== 200) failure(`GET ${path}`, reply.status(), text);
  return JSON.parse(text) as CaseWithLoans;
}

/** Every case of the branch's tray that carries one serial: the second claim must not add a row. */
export async function casesWithSerial(session: Session,
  serial: string): Promise<readonly { readonly id: number; readonly case_number: string }[]> {
  const path = '/api/warranty-cases';
  const reply = await session.request.get(path);
  const text = await reply.text();
  if (reply.status() !== 200) failure(`GET ${path}`, reply.status(), text);
  const tray = JSON.parse(text) as {
    readonly cases: readonly { id: number; case_number: string; serial_number: string | null }[];
  };
  return tray.cases
    .filter(row => row.serial_number === serial)
    .map(row => ({ id: row.id, case_number: row.case_number }));
}

/**
 * A claim asked by the API, answered raw: the spec that expects the refusal reads its status and its
 * code instead of guessing it from a disabled button or from a case that happens to be absent.
 */
export async function claimAttempt(session: Session, serial: string, declaredFailure: string,
  expected: number): Promise<{ readonly status: number; readonly body: { readonly error?: string } }> {
  const path = '/api/warranty-cases/claims';
  const reply = await session.request.post(path, {
    headers: { 'X-CSRF-Token': session.csrf },
    data: { serial_number: serial, declared_failure: declaredFailure },
  });
  const text = await reply.text();
  if (reply.status() !== expected) failure(`POST ${path}`, reply.status(), text);
  return { status: reply.status(), body: JSON.parse(text) as { error?: string } };
}

// ---------------------------------------------------------------------------------
// The stock of used batteries: the five terms the screen publishes and their sum
// ---------------------------------------------------------------------------------

export interface UsedStockTermRow {
  readonly location_id: number;
  readonly model: string;
  readonly purchased: number;
  readonly factory_returns: number;
  readonly loans_returned: number;
  readonly delivered: number;
  readonly loans_given: number;
  readonly available: number;
}

/** The whole derived table, read from the same route the screen reads (`apps/api/docs/warranty-cases.md`). */
export async function usedStockTable(session: Session): Promise<UsedStockTermRow[]> {
  const path = '/api/warranty-cases/used-stock';
  const reply = await session.request.get(path);
  const text = await reply.text();
  if (reply.status() !== 200) failure(`GET ${path}`, reply.status(), text);
  const body = JSON.parse(text) as {
    readonly stock: readonly {
      location_id: number; model: string; purchased: string; factory_returns: string;
      loans_returned: string; delivered: string; loans_given: string; available: string;
    }[];
  };
  // The contract publishes every term as a canonical decimal string; the spec reads the numbers the
  // screen prints, and the signed sum may be negative because it is the whole history.
  return body.stock.map(row => ({
    location_id: row.location_id,
    model: row.model,
    purchased: Number(row.purchased),
    factory_returns: Number(row.factory_returns),
    loans_returned: Number(row.loans_returned),
    delivered: Number(row.delivered),
    loans_given: Number(row.loans_given),
    available: Number(row.available),
  }));
}

export function usedStockKey(row: Pick<UsedStockTermRow, 'location_id' | 'model'>): string {
  return `${row.location_id}:${row.model}`;
}

/** The signed sum of one row, exactly the arithmetic the screen states (`usedStockModel.ts`). */
export function usedStockSum(row: UsedStockTermRow): number {
  return row.location_id === 1
    ? row.purchased + row.factory_returns + row.loans_returned + row.delivered - row.loans_given
    : row.purchased + row.factory_returns + row.loans_returned - row.delivered - row.loans_given;
}

// ---------------------------------------------------------------------------------
// The receipt: the download the screen makes and the page it really contains
// ---------------------------------------------------------------------------------

export interface ReceiptFile {
  /** The name the browser saved the document under, taken from `Content-Disposition`. */
  readonly filename: string;
  readonly bytes: Buffer;
}

export interface ReceiptAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly disposition: string;
  readonly bytes: Buffer;
}

/** The receipt as the contract publishes it, without the browser: the same bytes and their headers. */
export async function receiptAnswer(session: Session, caseId: number): Promise<ReceiptAnswer> {
  const reply = await session.request.get(`/api/warranty-cases/${caseId}/receipt.pdf`);
  return {
    status: reply.status(),
    contentType: reply.headers()['content-type'] ?? '',
    disposition: reply.headers()['content-disposition'] ?? '',
    bytes: Buffer.from(await reply.body()),
  };
}

/** The operator's own download: the link the case publishes, clicked, and the file it left behind. */
export async function downloadReceipt(page: Page, caseNumber: string): Promise<ReceiptFile> {
  const link = page.getByRole('link', { name: `Descargar el comprobante de préstamo de ${caseNumber}` });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const problem = await download.failure();
  if (problem !== null) throw new Error(`la descarga del comprobante falló: ${problem}`);
  const path = await download.path();
  if (path === null) throw new Error('la descarga del comprobante no dejó un archivo que leer');
  // El archivo vive en el directorio temporal de Playwright, fuera del árbol de trabajo.
  return { filename: download.suggestedFilename(), bytes: await readFile(path) };
}

/**
 * The literal strings the document draws, in the order it draws them (the same reading the Go test of
 * the renderer makes): the page's text is uncompressed, so each `(…) Tj` is a word or a line of the
 * paper. The core font writes cp1252 bytes; the assertions below use the document's own values, whose
 * accents are the same code points in cp1252 and latin1.
 */
const receiptTextOp = /\(((?:\\.|[^()\\])*)\)\s*Tj/g;
const receiptPages = /\/Type\s*\/Page[^s]/g;

export function drawnText(pdf: Buffer): string {
  const stream = pdf.toString('latin1');
  const lines: string[] = [];
  for (const match of stream.matchAll(receiptTextOp)) {
    lines.push(match[1].replace(/\\([()\\])/g, '$1').replace(/\\r/g, ' '));
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

export function pdfPageCount(pdf: Buffer): number {
  return [...pdf.toString('latin1').matchAll(receiptPages)].length;
}

/**
 * The two renderings of the persisted handover the paper may print. The receipt is dated by the
 * instant the database stamped on the loan (`receipt_store.go`, `IssuedAt`) and it formats it in the
 * server's own zone, while the contract publishes that same instant in UTC. Both candidates are the
 * same handover, so the spec accepts either and still asserts the date is the stored one.
 */
export function receiptDateCandidates(givenAt: string): readonly string[] {
  const instant = Date.parse(givenAt);
  if (Number.isNaN(instant)) throw new Error(`la fecha del préstamo no se puede leer: ${givenAt}`);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const render = (offsetMinutes: number): string => {
    const moment = new Date(instant + offsetMinutes * 60_000);
    return `${pad(moment.getUTCDate())}/${pad(moment.getUTCMonth() + 1)}/${moment.getUTCFullYear()}`
      + ` ${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}`;
  };
  // −240 is America/La_Paz, the desk's own zone and the one the browser of the suite is set to.
  return [...new Set([-240, 0].map(render))];
}
