// Run from apps/web: node ../../odd/design/transfer-origin-restitution-ux/integrated-probe.mjs
// Actual compiled App, synthetic GET-only fixtures; downloaded HTML is never executed.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(path.resolve('package.json'));
const { build } = await import(require.resolve('vite'));
const { chromium } = require('@playwright/test');
const out = path.resolve('../../odd/design/transfer-origin-restitution-ux');
const mode = process.argv[2] ?? 'full';
assert.ok(['full', '--mobile-red', '--mobile'].includes(mode));
const mobileOnly = mode !== 'full';
const runName = mode === '--mobile-red' ? 'mobile-red' : mode === '--mobile' ? 'mobile-green' : 'integrated';
const buildResult = await build({ logLevel: 'error', build: { write: false } });
const bundle = buildResult.output.find(x => x.type === 'chunk' && x.isEntry).code;
const styles = buildResult.output.filter(x => x.type === 'asset' && x.fileName.endsWith('.css')).map(x => x.source).join('\n');
const assets = new Map(buildResult.output.filter(x => x.type === 'asset').map(x => [`/${x.fileName}`, x.source]));
const locations = ['Origen físico', 'Destino físico', 'Otra ubicación'].map((name, i) => ({ id: i + 1, name }));
const stamp = '2028-01-03T00:00:00.000000001Z';
const reason = '  Dos baterías permanecen físicamente en origen.\n  Evidencia sin recortar 🪫 — ' + 'identificador-largo-'.repeat(12) + '  ';
const record = {
  id: '1001', reference: 'TR-1001', kind: 'request_stock', status: 'received',
  creator_location_id: 2, creator_location_name: locations[1].name,
  origin_location_id: 1, origin_location_name: locations[0].name,
  destination_location_id: 2, destination_location_name: locations[1].name,
  approver_location_id: 1, approver_location_name: locations[0].name, decision_location_id: 1,
  created_at: '2028-01-01T00:00:00Z', decided_at: '2028-01-02T00:00:00Z',
  dispatch_location_id: 1, dispatched_at: stamp, receipt_location_id: 2, received_at: stamp,
  items: [1, 2].map(variant_id => ({ variant_id, brand: 'TOYO', model: `Exact-${variant_id}`, capacity_ah: '75.125', polarity: variant_id === 1 ? 'L' : 'R', quantity: variant_id === 1 ? '5' : '1' })),
  receipt: { items: [1, 2].map(variant_id => ({ variant_id, expected_quantity: variant_id === 1 ? '5' : '1', actual_quantity: variant_id === 1 ? '3' : '1', available_quantity: variant_id === 1 ? '3' : '1' })),
    exceptions: [{ variant_id: 1, kind: 'shortage', quantity: '2' }] },
};
const counts = { request_id: record.id, operations: [], lines: record.receipt.items.map(item => ({ ...item,
  workflow_revision: '0', applied_revision: '0', effective_actual: item.actual_quantity, effective_credit: item.available_quantity, proposals: [] })) };
function restitutionFixture(applied) {
  const proposal = { revision: '1', operation_key: 'synthetic_proposal_01', initiator_location_id: 1,
    retained_quantity: applied ? '1' : '2', retained_at_origin: true, base_revision: '0', count_generation: '0',
    count_applied_revision: '0', base_credit: '3', base_restitution: '0', reason, recorded_at: stamp,
    state: applied ? 'applied' : 'pending', decision: null, application: null };
  const operation = { request_id: record.id, variant_id: 1, operation_key: proposal.operation_key, actor_location_id: 1,
    action: 'propose', expected_revision: '0', retained_quantity: proposal.retained_quantity, retained_at_origin: true,
    reason, revision: '1', source_existing_before: null, source_existing_after: null, recorded_at: stamp };
  const operations = [operation];
  if (applied) {
    proposal.decision = { operation_key: 'synthetic_accept_01', actor_location_id: 2, accepted: true, reason: 'Aceptación exacta', recorded_at: stamp };
    proposal.application = { operation_key: 'synthetic_accept_01', origin_location_id: 1, quantity: '1', recorded_at: stamp };
    operations.push({ ...operation, operation_key: 'synthetic_accept_01', actor_location_id: 2, action: 'accept', expected_revision: '1',
      retained_quantity: null, retained_at_origin: null, reason: proposal.decision.reason, source_existing_before: '10', source_existing_after: '11' });
  }
  return { request_id: record.id, operations, lines: counts.lines.map(line => ({ variant_id: line.variant_id,
    expected_quantity: line.expected_quantity, original_credit: line.available_quantity, workflow_revision: line.variant_id === 1 ? '1' : '0',
    applied_revision: applied && line.variant_id === 1 ? '1' : '0', count_generation: '0', count_applied_revision: '0',
    effective_credit: line.effective_credit, applied_retained_quantity: applied && line.variant_id === 1 ? '1' : '0', proposals: line.variant_id === 1 ? [proposal] : [] })) };
}
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of mobileOnly ? [390] : [1280, 390]) for (const actor of [1, 2]) for (const state of ['pending', 'applied']) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    const requests = []; const rejected = []; const errors = [];
    const screenshots = []; const geometry = []; const restitution = restitutionFixture(state === 'applied');
    const prefix = `${runName}-${width}-actor-${actor}-${state}`;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.EventSource = class { readyState = 0; addEventListener() {} removeEventListener() {} close() { this.readyState = 2; } }; });
    await page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        requests.push({ method: request.method(), path: url.pathname });
        if (request.method() !== 'GET') { rejected.push(url.pathname); return route.abort(); }
        let body;
        if (url.pathname === '/api/auth/session' || url.pathname === '/api/auth/validate') body = { authenticated: true, csrf_token: 'c'.repeat(43), expires_at: '2030-01-01T00:00:00Z', identity: { account_id: actor, username: `synthetic-${actor}`, location: locations[actor - 1] } };
        else if (url.pathname === '/api/inventory/metadata') body = { locations, brands: ['TOYO'] };
        else if (url.pathname === '/api/inventory') body = { location: locations[actor - 1], items: [], page: Number(url.searchParams.get('page') ?? 1), page_size: Number(url.searchParams.get('page_size') ?? 10), total_variants: 0 };
        else if (url.pathname === '/api/transfers/counts') body = { pending_total: '0', action_count: '0' };
        else if (url.pathname === '/api/transfers') body = { page: Number(url.searchParams.get('page') ?? 1), page_size: Number(url.searchParams.get('page_size') ?? 25), status: url.searchParams.get('status') ?? 'pending', total_count: '0', records: [] };
        else if (url.pathname === '/api/transfers/1001') body = record;
        else if (url.pathname.endsWith('/count-corrections')) body = counts;
        else if (url.pathname.endsWith('/restitutions')) body = restitution;
        else { rejected.push(url.pathname); return route.abort(); }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (url.hostname === 'fixture.invalid' && request.resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
      if (url.hostname === 'fixture.invalid' && assets.has(url.pathname)) return route.fulfill({ status: 200,
        contentType: url.pathname.endsWith('.woff2') ? 'font/woff2' : url.pathname.endsWith('.woff') ? 'font/woff' : 'application/octet-stream',
        body: Buffer.from(assets.get(url.pathname)) });
      rejected.push(request.url()); return route.abort();
    });
    const screenshot = async suffix => {
      const name = `${prefix}-${suffix}.png`; screenshots.push(name);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(out, name), fullPage: true });
    };
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No page overflow');
    const checkGeometry = async (table, phase) => {
      if (width !== 390) return;
      const measurement = await table.evaluate(element => {
        const visible = node => node.getClientRects().length > 0;
        const rows = [...element.querySelectorAll('tbody > tr')].filter(visible);
        const cells = rows.flatMap(row => [...row.children]);
        const issues = [];
        for (const cell of cells) {
          const box = cell.getBoundingClientRect();
          if (cell.scrollHeight > cell.clientHeight + 1) issues.push({ label: cell.dataset.label ?? cell.tagName,
            scrollHeight: cell.scrollHeight, clientHeight: cell.clientHeight });
          for (const control of [...cell.querySelectorAll('button, summary')].filter(visible)) {
            if (control.getBoundingClientRect().bottom > box.bottom + 1) issues.push({ control: control.textContent, outsideCell: true });
          }
        }
        for (let i = 1; i < rows.length; i++) {
          if (rows[i - 1].getBoundingClientRect().bottom > rows[i].getBoundingClientRect().top + 1) issues.push({ row: i, overlapsPrevious: true });
        }
        return { rows: rows.length, cells: cells.length, issues };
      });
      geometry.push({ phase, ...measurement });
      assert.deepEqual(measurement.issues, [], `Mobile cells contain content and controls without overlap (${phase})`);
    };
    const selectManagement = async name => {
      await page.getByRole('button', { name: 'Gestiones', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };
    try {
      await page.goto('https://fixture.invalid/#/transferencias/1001');
      await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: bundle, type: 'module' });
      const main = page.getByRole('table', { name: 'Conteo efectivo', exact: true }); await main.waitFor();
      const before = await main.innerText();
      await screenshot('initial');
      await selectManagement('Restituciones de origen');
      const section = page.getByRole('region', { name: 'Restituciones de origen', exact: true });
      const table = section.getByRole('table', { name: 'Gestión de restituciones', exact: true }); await table.waitFor();
      const first = table.getByRole('rowgroup', { name: 'TOYO · Exact-1 · 75.125 Ah · L', exact: true });
      const second = table.getByRole('rowgroup', { name: 'TOYO · Exact-2 · 75.125 Ah · R', exact: true });
      assert.equal(await section.getByRole('table').count(), 1);
      assert.equal(await section.getByRole('combobox').count(), 0);
      assert.ok((await main.boundingBox()).y < (await page.getByRole('button', { name: 'Gestiones', exact: true }).boundingBox()).y);
      assert.ok((await main.boundingBox()).y < (await table.boundingBox()).y);
      for (const [group, values] of [[first, ['5', '3', state === 'applied' ? '1' : '0', state === 'applied' ? '1' : '2']], [second, ['1', '1', '0', '0']]]) {
        assert.deepEqual(await group.locator(':scope > tr:first-child > td').allTextContents().then(texts => texts.slice(0, 4)), values);
      }
      assert.equal(await second.getByText('Sin propuestas de restitución.', { exact: true }).isVisible(), true);
      const history = first.getByRole('button', { name: 'Historial completo · 1 propuesta(s)', exact: true });
      assert.equal(await history.getAttribute('aria-expanded'), 'false');
      assert.equal(await section.locator('.restitution-rules').getAttribute('open'), null);
      if (state === 'pending') {
        await first.getByText(actor === 1 ? 'Esperando revisión de Destino físico' : 'Propuesta de Origen físico · Requiere revisión en Destino físico', { exact: true }).waitFor();
        assert.equal(await first.locator('.restitution-pending .restitution-evidence').textContent(), reason);
        assert.equal(await first.getByText('Origen físico declara que estas 2 batería(s) permanecen físicamente en origen.', { exact: true }).isVisible(), true);
      } else assert.equal(await first.getByText('Restitución cerrada', { exact: true }).isVisible(), true);
      await noOverflow(); await screenshot('collapsed'); await checkGeometry(table, 'collapsed');
      const reads = requests.length;
      await history.click();
      await first.getByText('Ver detalle de propuesta 1', { exact: true }).click();
      const proposal = first.getByRole('region', { name: 'Propuesta 1', exact: true });
      assert.equal(await proposal.locator('.restitution-evidence').textContent(), `Motivo: ${reason}`);
      await proposal.getByText('Evidencia técnica', { exact: true }).click();
      assert.equal(await proposal.getByText('Clave: synthetic_proposal_01', { exact: true }).isVisible(), true);
      if (state === 'applied') {
        const application = first.getByRole('region', { name: 'Aplicación 1', exact: true });
        await application.getByText('Evidencia técnica', { exact: true }).click();
        assert.equal(await application.getByText('Existencias de origen registradas: 10 → 11', { exact: true }).isVisible(), true);
        assert.equal(await first.getByRole('region', { name: 'Decisión 1', exact: true }).getByText('Motivo de decisión: Aceptación exacta', { exact: true }).isVisible(), true);
      }
      assert.equal(requests.length, reads, 'Disclosures perform no reads or writes');
      await noOverflow(); await screenshot('history'); await checkGeometry(table, 'expanded-history');
      await history.click();
      const actions = actor === 1 ? ['Proponer restitución'] : ['Aceptar restitución', 'Rechazar restitución'];
      for (const name of actions) assert.equal(await first.getByRole('button', { name, exact: true }).isDisabled(), true, 'Passive evidence never grants consent');
      await section.getByRole('button', { name: 'Consultar para revisar restitución', exact: true }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Consultar para revisar restitución')?.disabled);
      for (const name of actions) {
        const trigger = first.getByRole('button', { name, exact: true });
        if (state === 'applied') { assert.equal(await trigger.isDisabled(), true, 'Partial application closes the variant'); continue; }
        assert.equal(await trigger.isEnabled(), true);
        assert.ok((await trigger.boundingBox()).height >= 44);
        await trigger.click(); const modal = page.getByRole('dialog'); await modal.waitFor();
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
        if (actor === 1) {
          await modal.getByRole('textbox', { name: /Cantidad retenida en origen/ }).fill('2');
          await modal.getByRole('textbox', { name: /Motivo de restitución/ }).fill('Retención sintética verificada');
          await modal.getByRole('checkbox').check();
        } else await modal.getByRole('textbox', { name: name.startsWith('Aceptar') ? 'Motivo de aceptación (obligatorio)' : 'Motivo de rechazo (obligatorio)', exact: true }).fill('Decisión sintética sin envío');
        await modal.getByRole('button', { name: 'Revisar restitución', exact: true }).click();
        assert.equal(await modal.getByRole('heading', { level: 3 }).evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await modal.getByRole('button', { name: 'Cerrar restitución', exact: true }).evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await modal.getByRole('button', { name: actor === 1 ? 'Editar datos' : 'Cancelar', exact: true }).evaluate(el => el === document.activeElement), true);
        await screenshot(name.startsWith('Rechazar') ? 'reject-review' : 'review');
        await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
      }
      await selectManagement('Corregir conteo');
      await page.getByRole('table', { name: 'Gestión de conteo', exact: true }).waitFor();
      assert.equal(await main.innerText(), before);
      await selectManagement('Restituciones de origen'); await table.waitFor();
      assert.equal(await main.innerText(), before);
      await noOverflow(); await checkGeometry(table, 'after-management-switch');
      assert.deepEqual(rejected, []); assert.deepEqual(errors, []);
      assert.equal(requests.some(r => r.method !== 'GET'), false);
      results.push({ width, actor, state, passed: true, requests, screenshots, geometry, businessWrites: 0 });
    } catch (error) {
      await screenshot('failure');
      results.push({ width, actor, state, passed: false, error: error.stack, rejected, errors, requests, screenshots, geometry });
      throw error;
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await fs.writeFile(path.join(out, mobileOnly ? `${runName}-results.json` : 'integrated-results-corrected.json'), JSON.stringify(results, null, 2) + '\n');
}
console.log(JSON.stringify(results.map(({ width, actor, state, passed, screenshots, businessWrites }) => ({ width, actor, state, passed, screenshots, businessWrites })), null, 2));
