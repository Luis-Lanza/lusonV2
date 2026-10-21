// Run from apps/web: node ../../odd/design/transfer-count-compact/integrated-probe.mjs
// Synthetic-only actual App: no application server or live backend.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(path.resolve('package.json'));
const { build } = await import(require.resolve('vite'));
const { chromium } = require('@playwright/test');
const out = path.resolve('../../odd/design/transfer-count-compact');
const buildResult = await build({ logLevel: 'error', build: { write: false } });
const bundle = buildResult.output.find(x => x.type === 'chunk' && x.isEntry).code;
const styles = buildResult.output.filter(x => x.type === 'asset' && x.fileName.endsWith('.css')).map(x => x.source).join('\n');
const locations = ['Almacén', 'Sucursal A', 'Sucursal B'].map((name, i) => ({ id: i + 1, name }));
const stamp = '2028-01-03T00:00:00.000000001Z';
const record = {
  id: '1001', reference: 'TR-1001', kind: 'request_stock', status: 'received',
  creator_location_id: 2, creator_location_name: 'Sucursal A',
  origin_location_id: 1, origin_location_name: 'Almacén', destination_location_id: 2, destination_location_name: 'Sucursal A',
  approver_location_id: 1, approver_location_name: 'Almacén', decision_location_id: 1,
  created_at: '2028-01-01T00:00:00Z', decided_at: '2028-01-02T00:00:00Z',
  dispatch_location_id: 1, dispatched_at: stamp, receipt_location_id: 2, received_at: stamp,
  items: [1, 2].map(variant_id => ({ variant_id, brand: 'TOYO', model: `Exact-${variant_id}`, capacity_ah: '75.125', polarity: variant_id === 1 ? 'L' : 'R', quantity: '2' })),
  receipt: { items: [1, 2].map(variant_id => ({ variant_id, expected_quantity: '2', actual_quantity: '2', available_quantity: '2' })), exceptions: [] },
};
const history = { request_id: record.id, operations: [], lines: record.receipt.items.map((item, index) => ({ ...item,
  workflow_revision: index === 0 ? '2' : '0', applied_revision: index === 0 ? '1' : '0',
  effective_actual: index === 0 ? '1' : '2', effective_credit: index === 0 ? '1' : '2',
  proposals: index === 0 ? [
    { revision: '1', operation_key: 'applied_proposal_0001', initiator_location_id: 2, actual_quantity: '1', base_revision: '0', base_credit: '2', reason: 'Conteo aplicado conservado', recorded_at: stamp, state: 'applied',
      decision: { operation_key: 'applied_decision_0001', actor_location_id: 1, accepted: true, reason: 'Decisión conservada', recorded_at: stamp },
      application: { effective_credit: '1', delta: '-1', recorded_at: stamp } },
    { revision: '2', operation_key: 'pending_proposal_0002', initiator_location_id: 2, actual_quantity: '2', base_revision: '1', base_credit: '1', reason: '  Reconteo pendiente\n  Sin aplicar 🙂  ', recorded_at: stamp, state: 'pending', decision: null, application: null },
  ] : [] })) };
const restitutions = { request_id: record.id, operations: [], lines: history.lines.map(line => ({ variant_id: line.variant_id,
  expected_quantity: '2', original_credit: '2', workflow_revision: '0', applied_revision: '0', count_generation: line.workflow_revision,
  count_applied_revision: line.applied_revision, effective_credit: line.effective_credit, applied_retained_quantity: '0', proposals: [] })) };
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1280, 390]) for (const actor of [2, 1]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const requests = []; const rejected = []; const errors = [];
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
        else if (url.pathname === '/api/transfers/counts') body = { pending_total: '0', action_count: actor === 1 ? '1' : '0' };
        else if (url.pathname === '/api/transfers') body = { page: Number(url.searchParams.get('page') ?? 1), page_size: Number(url.searchParams.get('page_size') ?? 25), status: url.searchParams.get('status') ?? 'pending', total_count: '0', records: [] };
        else if (url.pathname === '/api/transfers/1001') body = record;
        else if (url.pathname.endsWith('/count-corrections')) body = history;
        else if (url.pathname.endsWith('/restitutions')) body = restitutions;
        else { rejected.push(url.pathname); return route.abort(); }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (request.resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
      return route.fulfill({ status: 200, body: '' });
    });
    try {
      await page.goto('https://fixture.invalid/#/transferencias/1001');
      await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: bundle, type: 'module' });
      const table = page.getByRole('table', { name: 'Conteo efectivo', exact: true });
      await table.waitFor();
      await page.getByRole('button', { name: 'Gestiones', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Corregir conteo', exact: true }).click();
      const count = page.getByRole('region', { name: 'Correcciones de conteo', exact: true });
      const card = count.getByRole('rowgroup', { name: 'TOYO · Exact-1 · 75.125 Ah · L', exact: true });
      await card.getByText('Conteo vigente: 1 → Propuesto: 2', { exact: true }).waitFor();
      assert.equal(await card.locator('.count-pending .count-evidence').textContent(), history.lines[0].proposals[1].reason);
      assert.ok((await table.boundingBox()).y < (await count.boundingBox()).y);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await table.evaluate(el => { const box = el.closest('.received-table'); const r = box.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && box.scrollWidth <= box.clientWidth; }), true);
      const historyToggle = card.getByRole('button', { name: 'Historial completo · 2 revisiones', exact: true });
      assert.equal(await historyToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await count.getByRole('table', { name: 'Gestión de conteo', exact: true }).count(), 1);
      assert.equal(await count.getByText('Sin correcciones', { exact: true }).count(), 1);
      assert.equal(await card.getByText('Efecto aplicado en destino: -1', { exact: true }).isVisible(), false);
      const tableBefore = await table.innerText();
      await page.screenshot({ path: path.join(out, `integrated-${width}-actor-${actor}-collapsed.png`), fullPage: true });
      await historyToggle.click();
      await page.screenshot({ path: path.join(out, `integrated-${width}-actor-${actor}-history.png`), fullPage: true });
      await card.getByRole('button', { name: 'Ver detalle de revisión 1', exact: true }).click();
      assert.equal(await card.getByText('Motivo de decisión: Decisión conservada', { exact: true }).isVisible(), true);
      await card.getByText('Evidencia técnica del conteo', { exact: true }).click();
      assert.equal(await card.getByText('Revisión de flujo', { exact: true }).isVisible(), true);
      const trigger = card.getByRole('button', { name: actor === 2 ? 'Reemplazar propuesta' : 'Consultar propuesta', exact: true });
      assert.ok((await trigger.boundingBox()).height >= 44);
      await trigger.click(); const modal = page.getByRole('dialog'); await modal.waitFor();
      if (actor === 1) { await modal.getByRole('button', { name: 'Aceptar propuesta', exact: true }).click(); await modal.getByRole('textbox', { name: 'Motivo de aceptación (obligatorio)', exact: true }).waitFor(); }
      else await modal.getByRole('textbox', { name: 'Cantidad corregida', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
      await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
      await page.getByRole('button', { name: 'Gestiones', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Restituciones de origen', exact: true }).click();
      const restitution = page.getByRole('region', { name: 'Restituciones de origen', exact: true }); await restitution.waitFor();
      await restitution.getByText('Sin propuestas de restitución.', { exact: true }).waitFor();
      assert.equal(await table.innerText(), tableBefore);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(rejected, []); assert.deepEqual(errors, []);
      assert.equal(requests.some(r => r.method !== 'GET'), false);
      results.push({ width, actor, passed: true, requests, screenshot: `integrated-${width}-actor-${actor}-collapsed.png` });
    } catch (error) {
      results.push({ width, actor, passed: false, error: error.message, rejected, errors, requests });
      throw error;
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await fs.writeFile(path.join(out, 'integrated-results.json'), JSON.stringify(results, null, 2) + '\n');
}
console.log(JSON.stringify(results.map(({ width, actor, passed, screenshot }) => ({ width, actor, passed, screenshot })), null, 2));
