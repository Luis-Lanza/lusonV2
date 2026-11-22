import { describe, expect, it, vi } from 'vitest';
import {
  CashCategoriesAPIError, cashCategoriesAdmittedErrors, cashCategoriesErrorMessages,
  createCashCategoriesAPI, parseAdminCashCategories, parseAdminCashCategory, parseCashCategoriesError,
} from './cashCategoriesAPI';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const category = (overrides: Record<string, unknown> = {}) => ({
  id: 1, label: 'Alquiler', sort_order: 1, state: 'active', retired_at: null, retired_by: null, ...overrides,
});
const envelope = (value: unknown) => JSON.stringify({ categories: [value] });
const one = (value: unknown) => JSON.stringify({ category: value });

describe('the admin catalogue of cash motives', () => {
  it('reads the whole list, archived included, in the order the server publishes it', () => {
    const raw = JSON.stringify({ categories: [
      category({ id: 1, label: 'Alquiler', sort_order: 1 }),
      category({ id: 11, label: 'Otros gastos', sort_order: 11 }),
      category({ id: 12, label: 'Gas', sort_order: 12, state: 'retired',
        retired_at: '2026-11-12T10:00:00Z', retired_by: 'dev_almacen' }),
    ] });
    const list = parseAdminCashCategories(raw);
    expect(list.map(row => [row.id, row.label, row.state])).toEqual([
      [1, 'Alquiler', 'active'], [11, 'Otros gastos', 'active'], [12, 'Gas', 'retired'],
    ]);
    expect(list[2].retired_at).toBe('2026-11-12T10:00:00Z');
    expect(list[2].retired_by).toBe('dev_almacen');
  });

  it('reads one category from the answer of a write', () => {
    expect(parseAdminCashCategory(one(category({ id: 4, label: 'Limpieza', sort_order: 12 })))).toEqual({
      id: 4, label: 'Limpieza', sort_order: 12, state: 'active', retired_at: null, retired_by: null,
    });
  });

  it('refuses a category whose state and archive stamps disagree', () => {
    // Archived without an instant or an author is not a row this catalogue wrote.
    expect(() => parseAdminCashCategories(envelope(category({ state: 'retired' })))).toThrow();
    expect(() => parseAdminCashCategories(envelope(category({ retired_at: '2026-11-12T10:00:00Z' })))).toThrow();
    expect(() => parseAdminCashCategories(envelope(category({ retired_by: 'dev_almacen' })))).toThrow();
  });

  it('refuses an unknown key, a repeated identity and an instant that is not RFC 3339', () => {
    expect(() => parseAdminCashCategories(envelope({ ...category(), pinned: true }))).toThrow();
    const duplicated = JSON.stringify({ categories: [category(), category({ label: 'Internet' })] });
    expect(() => parseAdminCashCategories(duplicated)).toThrow();
    expect(() => parseAdminCashCategories(envelope(category({
      state: 'retired', retired_at: 'ayer', retired_by: 'dev_almacen',
    })))).toThrow();
  });

  it('maps every rejection code to its own admitted status', () => {
    expect([...cashCategoriesAdmittedErrors.entries()].map(([status, codes]) => [status, [...codes]])).toEqual([
      [400, ['invalid_request']],
      [403, ['forbidden']],
      [404, ['category_unknown']],
      [409, ['duplicate_label', 'category_pinned', 'last_category']],
    ]);
    const answers: [number, string][] = [
      [400, 'invalid_request'], [403, 'forbidden'], [404, 'category_unknown'],
      [409, 'duplicate_label'], [409, 'category_pinned'], [409, 'last_category'],
    ];
    for (const [status, code] of answers) {
      expect(parseCashCategoriesError(JSON.stringify({ error: code }), status)).toBe(code);
      expect(cashCategoriesErrorMessages[code as keyof typeof cashCategoriesErrorMessages]).toBeTruthy();
    }
    // The messages are distinct: a refusal always says which one it is.
    const messages = answers.map(([, code]) => cashCategoriesErrorMessages[code as keyof typeof cashCategoriesErrorMessages]);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('refuses a code the status does not admit, an unknown code and a malformed envelope', () => {
    expect(() => parseCashCategoriesError(JSON.stringify({ error: 'duplicate_label' }), 404)).toThrow();
    expect(() => parseCashCategoriesError(JSON.stringify({ error: 'todo_roto' }), 409)).toThrow();
    expect(() => parseCashCategoriesError(JSON.stringify({ error: 'invalid_request', extra: 1 }), 400)).toThrow();
    expect(() => parseCashCategoriesError('no es json', 400)).toThrow();
  });
});

describe('the admin motive client', () => {
  it('reads the list without a token and decodes the exact envelope', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(envelope(category())));
    const list = await createCashCategoriesAPI(fetcher).list();
    expect(fetcher).toHaveBeenCalledWith('/api/admin/cash-categories', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    }));
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Alquiler');
  });

  it('creates a motive with the label alone and admits only its own echo', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(one(category({ id: 4, label: 'Limpieza', sort_order: 12 })), 201));
    const created = await createCashCategoriesAPI(fetcher).create('Limpieza', csrf);
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe('/api/admin/cash-categories');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(init?.body))).toEqual({ label: 'Limpieza' });
    expect(created.id).toBe(4);
    expect(created.label).toBe('Limpieza');
  });

  it('renames, retires and reactivates through their own routes', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/rename')) return json(one(category({ label: 'Alquiler del local' })));
      if (url.endsWith('/retire')) return json(one(category({
        state: 'retired', retired_at: '2026-11-12T10:00:00Z', retired_by: 'dev_almacen',
      })));
      return json(one(category()));
    });
    const api = createCashCategoriesAPI(fetcher);
    const renamed = await api.rename(1, 'Alquiler del local', csrf);
    expect(renamed.label).toBe('Alquiler del local');
    expect(fetcher.mock.calls[0][0]).toBe('/api/admin/cash-categories/1/rename');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ label: 'Alquiler del local' });
    const retired = await api.retire(1, csrf);
    expect(retired.state).toBe('retired');
    expect(fetcher.mock.calls[1][0]).toBe('/api/admin/cash-categories/1/retire');
    expect(fetcher.mock.calls[1][1]?.body).toBeUndefined();
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({ 'X-CSRF-Token': csrf });
    const reactivated = await api.reactivate(1, csrf);
    expect(reactivated.state).toBe('active');
    expect(fetcher.mock.calls[2][0]).toBe('/api/admin/cash-categories/1/reactivate');
  });

  it('refuses an echo that does not repeat the write it answered', async () => {
    const wrongLabel = vi.fn<typeof fetch>(async () => json(one(category({ label: 'Otra cosa' })), 201));
    await expect(createCashCategoriesAPI(wrongLabel).create('Limpieza', csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
    const notRetired = vi.fn<typeof fetch>(async () => json(one(category())));
    await expect(createCashCategoriesAPI(notRetired).retire(1, csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('turns every refusal into its own typed error', async () => {
    const cases: [number, string][] = [
      [400, 'invalid_request'], [403, 'forbidden'], [404, 'category_unknown'],
      [409, 'duplicate_label'], [409, 'category_pinned'], [409, 'last_category'],
    ];
    for (const [status, code] of cases) {
      const fetcher = vi.fn<typeof fetch>(async () => json(JSON.stringify({ error: code }), status));
      const failure = await createCashCategoriesAPI(fetcher).create('Limpieza', csrf).catch(error => error);
      expect(failure).toBeInstanceOf(CashCategoriesAPIError);
      expect(failure.code).toBe(code);
      expect(failure.status).toBe(status);
    }
  });

  it('reports a missing token as a rejected request and a dropped connection as network', async () => {
    const never = vi.fn<typeof fetch>();
    await expect(createCashCategoriesAPI(never).create('Limpieza', '!')).rejects.toMatchObject({
      code: 'invalid_request', status: null,
    });
    expect(never).not.toHaveBeenCalled();
    const down = vi.fn<typeof fetch>(async () => { throw new TypeError('sin red'); });
    await expect(createCashCategoriesAPI(down).list()).rejects.toMatchObject({ code: 'network' });
  });
});
