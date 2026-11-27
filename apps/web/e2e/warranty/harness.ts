import { expect, test as base, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { sessionState, warehouseSessionState } from './sessions';

/**
 * The two seams of the warranty suite (S35):
 *
 *  - the browser the operator uses, driven by its own copy, labels and roles;
 *  - the API of the same session, which is how a spec arranges what the flow under test does not
 *    exercise — the sale that yields the serial and the used battery that fills the pool (S35, last
 *    paragraph) — so every spec is deterministic on a freshly seeded database and depends on no other
 *    spec having run.
 *
 * Every write goes through the contract the product already publishes (`apps/api/docs/`): a session of
 * a real account, the same-origin `Origin` and the CSRF token of that session. Nothing here imports the
 * application's own modules, so a spec can never pass by agreeing with the code it is testing.
 */

export const origin = 'http://127.0.0.1:8080';

export interface Role {
  readonly username: string;
  readonly password: string;
  readonly locationId: number;
  readonly locationName: string;
}

export const branchA: Role = {
  username: 'bot_sucursal_a', password: 'Bot.SucursalA.2026', locationId: 2, locationName: 'Sucursal A',
};
export const branchB: Role = {
  username: 'bot_sucursal_b', password: 'Bot.SucursalB.2026', locationId: 3, locationName: 'Sucursal B',
};
export const warehouseRole: Role = {
  username: 'bot_almacen', password: 'Bot.Almacen.2026', locationId: 1, locationName: 'Almacén',
};

export interface Session {
  readonly request: APIRequestContext;
  readonly csrf: string;
  readonly locationId: number;
  readonly locationName: string;
}

/** The only shape a spec reads back from the API: the case, its loans and its append-only history. */
export interface CaseRecord {
  readonly id: number;
  readonly case_number: string;
  readonly phase: string;
  readonly origin: string;
  readonly verdict: string | null;
  readonly reported_destination: string | null;
  readonly loan_destination: string | null;
  readonly stock_destination: string | null;
  readonly serial_number: string | null;
  readonly variant_id: number;
  readonly quantity: number | null;
  readonly reason: string | null;
  readonly loans: readonly { readonly ordinal: number; readonly model: string; readonly fate: string }[];
  readonly events: readonly { readonly kind: string; readonly phase: string }[];
}

interface SellableRow {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly polarity: string;
  readonly existing: number;
  readonly available: number;
}

export interface ArrangedShelf {
  readonly variantId: number;
  readonly available: number;
  /** The name the finding's dialog prints of the variant, before it says what the shelf holds. */
  readonly label: string;
}

export interface UsedStockRow {
  readonly location_id: number;
  readonly model: string;
  readonly available: number;
}

interface RequestFactory {
  newContext(options: {
    baseURL: string;
    extraHTTPHeaders: Record<string, string>;
    storageState?: string;
  }): Promise<APIRequestContext>;
}

async function json<T>(reply: { json(): Promise<unknown> }, where: string): Promise<T> {
  try {
    return (await reply.json()) as T;
  } catch {
    throw new Error(`${where}: la respuesta no es JSON`);
  }
}

/** A session of one account, the way the server admits one: the cookie the setup project saved. */
export async function sessionFor(factory: RequestFactory, role: Role): Promise<Session> {
  const request = await factory.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: sessionState(role.username),
  });
  const current = await json<{ authenticated: boolean; csrf_token: string }>(
    await request.get('/api/auth/session'), 'GET /api/auth/session');
  if (!current.authenticated) {
    throw new Error(`la sesión de ${role.username} no está activa: el proyecto de sesiones tiene que correr antes`);
  }
  return { request, csrf: current.csrf_token, locationId: role.locationId, locationName: role.locationName };
}

async function send<T>(session: Session, method: 'post' | 'put', path: string, body: unknown,
  expected: number): Promise<T> {
  const reply = await session.request[method](path, { headers: { 'X-CSRF-Token': session.csrf }, data: body });
  if (reply.status() !== expected) {
    throw new Error(`${method.toUpperCase()} ${path} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  if (expected === 204) return undefined as T;
  return json<T>(reply, `${method.toUpperCase()} ${path}`);
}

async function read<T>(session: Session, path: string): Promise<T> {
  const reply = await session.request.get(path);
  if (reply.status() !== 200) throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  return json<T>(reply, `GET ${path}`);
}

// ---------------------------------------------------------------------------------
// Unique data: two runs of the suite never collide on a serial, a model or a document
// ---------------------------------------------------------------------------------

let sequence = 0;
/** Upper-case letters and digits only, which is what a used-battery model code admits. */
function stamp(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

function unique(prefix: string): string {
  return `${prefix}${stamp()}`;
}

// ---------------------------------------------------------------------------------
// The arrange: what the flow does not exercise is created by the API (S35)
// ---------------------------------------------------------------------------------

export interface ArrangedSale {
  readonly saleId: number;
  readonly variantId: number;
  readonly serial: string;
  readonly warrantyNumber: string;
  readonly createdAt: string;
  readonly customerName: string;
  readonly battery: string;
}

/**
 * One sold battery with its serial and its twelve-month term, and the branch price the sale cannot
 * state about itself. The price belongs to the warehouse (it is the branch's sale floor), so this
 * arrange needs that session: it is the same transaction pair the product makes, minus the screens.
 */
export async function arrangeBatterySale(
  sessions: { readonly branch: Session; readonly warehouse: Session }, tag: string,
): Promise<ArrangedSale> {
  const catalogue = await read<{ items: readonly SellableRow[] }>(sessions.branch,
    '/api/sales/sellable?kind=battery&page=1&page_size=10');
  const item = catalogue.items.find(row => row.existing > 0);
  if (item === undefined) throw new Error('la sucursal no tiene stock de ninguna batería para vender');
  await send(sessions.warehouse, 'put', '/api/catalog/prices', {
    catalog_entry_id: item.catalog_entry_id, min_price: '85000', suggested_price: '96000',
    branch_ids: [sessions.branch.locationId],
  }, 200);
  const serial = unique(`T14${tag.toUpperCase()}`);
  const customerName = `Cliente ${unique(tag.toUpperCase())}`;
  const created = await send<{ sale: { id: number; warranty_number: string; created_at: string } }>(
    sessions.branch, 'post', '/api/sales', {
      payments: [{ method: 'cash', amount: '96000.00' }],
      customer: { name: customerName, phone: '700-11111', document: 'V-901', address: 'Av. Prueba 100' },
      lines: [{
        variant_id: item.variant_id, quantity: 1, unit_price: '96000.00',
        units: [{ serial_number: serial, warranty_months: 12 }],
      }],
    }, 201);
  return {
    saleId: created.sale.id,
    variantId: item.variant_id,
    serial,
    warrantyNumber: created.sale.warranty_number,
    createdAt: created.sale.created_at,
    customerName,
    battery: `${item.brand} ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}`,
  };
}

/**
 * A used battery the branch bought: the only flow that fills the pool without a warranty case first
 * (S30). The purchase is paid from the branch's own fund, so the warehouse loads it first, exactly like
 * the administration screen does.
 */
export async function arrangeUsedPool(
  sessions: { readonly branch: Session; readonly warehouse: Session }, tag: string,
): Promise<string> {
  const model = unique(`T14${tag.toUpperCase()}`);
  await send(sessions.warehouse, 'post', `/api/admin/branches/${sessions.branch.locationId}/funds`,
    { opening_cash: '0.00', purchase_fund: '200000.00' }, 204);
  await send(sessions.branch, 'post', '/api/purchases', {
    operation_key: `t14-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    note: '',
    used_lines: [{ model, quantity: 1, unit_price: '25000.00' }],
    scrap_lines: [],
    paid_cash: '25000.00',
    paid_transfer: '0.00',
  }, 201);
  return model;
}

/**
 * A variant the branch has on its own shelf right now (S16): a finding names one of its own batteries, so
 * this arrange only reads the shelf and never invents stock. The first page is the one the point of sale
 * publishes and the one the finding's dialog lists, so the figure the spec reads is the one the screen
 * shows.
 */
export async function arrangeShelfStock(branch: Session, quantity: number): Promise<ArrangedShelf> {
  const catalogue = await read<{ items: readonly SellableRow[] }>(branch,
    '/api/sales/sellable?kind=battery&page=1&page_size=10');
  const item = catalogue.items.find(row => row.available >= quantity);
  if (item === undefined) {
    throw new Error(`la góndola de la sucursal no tiene ${quantity} unidades de ninguna batería`);
  }
  return {
    variantId: item.variant_id, available: item.available,
    label: `${item.brand} · ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}`,
  };
}

export async function openClaim(branch: Session, serial: string, declaredFailure: string): Promise<CaseRecord> {
  return send<CaseRecord>(branch, 'post', '/api/warranty-cases/claims',
    { serial_number: serial, declared_failure: declaredFailure }, 201);
}

export async function addLoan(branch: Session, caseId: number,
  loan: { readonly model: string; readonly quantity: number; readonly source_location_id: number }): Promise<void> {
  await send(branch, 'post', `/api/warranty-cases/${caseId}/loans`,
    { model: loan.model, quantity: loan.quantity, serial_number: '', source_location_id: loan.source_location_id }, 201);
}

export async function advance(session: Session, caseId: number, phase: string, note: string,
  factoryCaseNumber = ''): Promise<CaseRecord> {
  return send<CaseRecord>(session, 'post', `/api/warranty-cases/${caseId}/advance`,
    { phase, factory_case_number: factoryCaseNumber, note }, 200);
}

export async function decideLoanFate(branch: Session, caseId: number, ordinal: number, fate: string): Promise<void> {
  await send(branch, 'post', `/api/warranty-cases/${caseId}/loans/${ordinal}/fate`, { fate }, 200);
}

export async function registerNotice(branch: Session, caseId: number, note: string): Promise<CaseRecord> {
  return send<CaseRecord>(branch, 'post', `/api/warranty-cases/${caseId}/notice`, { note }, 200);
}

/** The verdict and both destinations are the Almacén's, and the same body resolves either door. */
export async function resolveClaim(warehouse: Session, caseId: number, resolution: {
  readonly verdict: string;
  readonly reported_destination: string;
  readonly loan_destination: string;
  readonly note: string;
}): Promise<CaseRecord> {
  return send<CaseRecord>(warehouse, 'post', `/api/warranty-cases/${caseId}/resolution`, resolution, 200);
}

/**
 * The resolution, answered raw: a spec that expects the refusal reads its status and its code. The body is
 * the door's own — a claim states `loan_destination` and a finding does not — so the caller states it.
 */
export async function resolutionAttempt(session: Session, caseId: number, body: Record<string, unknown>,
  expected: number): Promise<{ readonly status: number; readonly body: { readonly error?: string } }> {
  const reply = await session.request.post(`/api/warranty-cases/${caseId}/resolution`,
    { headers: { 'X-CSRF-Token': session.csrf }, data: body });
  const answer = await json<{ error?: string }>(reply, `POST /api/warranty-cases/${caseId}/resolution`);
  if (reply.status() !== expected) {
    throw new Error(`la resolución respondió ${reply.status()} en vez de ${expected}: ${JSON.stringify(answer)}`);
  }
  return { status: reply.status(), body: answer };
}

/**
 * The delivery, answered raw: without the fate of the lent battery the case does not close, and this is
 * how a spec reads that refusal instead of guessing it from a disabled button.
 */
export async function deliver(session: Session, caseId: number, body: Record<string, unknown>,
  expected: number): Promise<{ readonly status: number; readonly body: { readonly error?: string } }> {
  const reply = await session.request.post(`/api/warranty-cases/${caseId}/delivery`,
    { headers: { 'X-CSRF-Token': session.csrf }, data: body });
  const answer = await json<{ error?: string }>(reply, `POST /api/warranty-cases/${caseId}/delivery`);
  if (reply.status() !== expected) {
    throw new Error(`la entrega respondió ${reply.status()} en vez de ${expected}: ${JSON.stringify(answer)}`);
  }
  return { status: reply.status(), body: answer };
}

/** The release, answered raw: a spec that expects the refusal reads its status and its code. */
export async function release(session: Session, caseId: number, note: string,
  expected: number): Promise<{ readonly status: number; readonly body: { readonly error?: string } }> {
  const reply = await session.request.post(`/api/warranty-cases/${caseId}/release`,
    { headers: { 'X-CSRF-Token': session.csrf }, data: { note } });
  const body = await json<{ error?: string }>(reply, `POST /api/warranty-cases/${caseId}/release`);
  if (reply.status() !== expected) {
    throw new Error(`la liberación respondió ${reply.status()} en vez de ${expected}: ${JSON.stringify(body)}`);
  }
  return { status: reply.status(), body };
}

export async function caseRecord(session: Session, caseId: number): Promise<CaseRecord> {
  return read<CaseRecord>(session, `/api/warranty-cases/${caseId}`);
}

/** One case of the tray by the number it prints, which is the number the screen's confirmation stated. */
export async function caseByNumber(session: Session, caseNumber: string): Promise<CaseRecord> {
  const tray = await read<{ cases: readonly CaseRecord[] }>(session, '/api/warranty-cases');
  const row = tray.cases.find(entry => entry.case_number === caseNumber);
  if (row === undefined) throw new Error(`el caso ${caseNumber} no aparece en la bandeja de la sucursal`);
  return row;
}

/** The case the screen just opened, found by the serial the sale gave it and by nothing else. */
export async function caseBySerial(session: Session, serial: string): Promise<CaseRecord> {
  const tray = await read<{ cases: readonly CaseRecord[] }>(session, '/api/warranty-cases');
  const row = tray.cases.find(entry => entry.serial_number === serial);
  if (row === undefined) throw new Error(`el caso de la serie ${serial} no aparece en la bandeja de la sucursal`);
  return row;
}

export async function casesInPhase(session: Session, phase: string): Promise<readonly string[]> {
  const tray = await read<{ cases: readonly CaseRecord[] }>(session, `/api/warranty-cases?phase=${phase}`);
  return tray.cases.map(row => row.case_number);
}

/**
 * The derived stock of used batteries of every location and model (S24), which is the closed list of
 * models the loan screen may offer of an origin (S30): the spec compares the field against this read
 * instead of against a list of its own.
 */
export async function usedStock(session: Session): Promise<readonly UsedStockRow[]> {
  const body = await read<{ stock: readonly { location_id: number; model: string; available: string }[] }>(
    session, '/api/warranty-cases/used-stock');
  // El contrato publica cada término como texto decimal: acá se lee como el número que la pantalla suma.
  return body.stock.map(row => ({
    location_id: row.location_id, model: row.model, available: Number(row.available),
  }));
}

/** The units label the loan screen prints beside a model: the same copy, never a raw number alone. */
export function unitsLabel(quantity: number): string {
  return `${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`;
}

/** The sellable stock of one variant, read from the point of sale's own catalogue of the branch. */
export async function sellableExisting(branch: Session, variantId: number): Promise<number> {
  const catalogue = await read<{ items: readonly SellableRow[] }>(branch,
    '/api/sales/sellable?kind=battery&page=1&page_size=10');
  const row = catalogue.items.find(item => item.variant_id === variantId);
  if (row === undefined) throw new Error(`la variante ${variantId} no figura en el catálogo vendible de la sucursal`);
  return row.existing;
}

// ---------------------------------------------------------------------------------
// The browser: the session, the tray of the branch and the desk of the Almacén
// ---------------------------------------------------------------------------------

export async function login(page: Page, role: Role): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Usuario').fill(role.username);
  // El botón del ojo lleva «Contraseña» en su etiqueta accesible: el campo se nombra por su rol.
  await page.getByRole('textbox', { name: 'Contraseña' }).fill(role.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByText(`Ubicación asignada: ${role.locationName}`)).toBeVisible();
}

/** The branch's guarantee tray: its own cases, which is where every branch-side assertion starts. */
export async function openBranchTray(page: Page): Promise<void> {
  await page.goto('/#/garantias');
  await expect(page.getByRole('heading', { name: 'Casos de garantía' })).toBeVisible();
}

/** The warehouse's factory desk: the four questions, each one a bucket of cases. */
export async function openWarehouseDesk(page: Page): Promise<void> {
  await page.goto('/#/garantias');
  await expect(page.getByRole('heading', { name: 'Mesa de fábrica' })).toBeVisible();
}

/** A second browser, on the Almacén's saved session: two sides of one case never share a session. */
export async function warehouseDeskPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: origin, storageState: warehouseSessionState });
  const page = await context.newPage();
  await openWarehouseDesk(page);
  return page;
}

export async function openDeskBucket(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: 'Figuras de la mesa por etapa' })
    .getByRole('button', { name: new RegExp(`^${label}`) }).click();
}

/** Opens one case of the tray and returns its detail pane, the one that publishes loans and history. */
export async function openCase(page: Page, caseNumber: string) {
  const button = page.getByRole('button', { name: `Ver el caso ${caseNumber}` });
  await expect(button).toBeVisible();
  await button.click();
  const detail = page.getByRole('complementary', { name: 'Detalle del caso' });
  await expect(detail.getByRole('heading', { level: 2 })).toBeVisible();
  return detail;
}

// ---------------------------------------------------------------------------------
// The test fixture: the API sessions a spec asked for, disposed when the spec ends
// ---------------------------------------------------------------------------------

export interface Api {
  /** One session per role, shared by every arrange of the same spec, disposed with it. */
  as(role: Role): Promise<Session>;
}

export const test = base.extend<{ api: Api }>({
  api: async ({ playwright }, use) => {
    const opened: Session[] = [];
    const sessions = new Map<string, Promise<Session>>();
    const api: Api = {
      as(role) {
        const known = sessions.get(role.username);
        if (known !== undefined) return known;
        const created = sessionFor(playwright.request, role);
        sessions.set(role.username, created);
        void created.then(session => opened.push(session));
        return created;
      },
    };
    await use(api);
    for (const session of opened) await session.request.dispose();
  },
});

export { expect };
