import { useEffect, useMemo, useState } from 'react';
import type { Location } from './model';
import { WarrantyCaseAPIError, createWarrantyCasesAPI, warrantyCaseErrorMessages } from './warrantyCasesAPI';
import {
  usedStockAt, usedStockTotals, usedStockUnits, usedStockUnavailable, usedStockWarehouse,
  type UsedStockRow,
} from './usedStockModel';
import { subscribeWarrantyInvalidation } from './useInventory';
import './warranty-cases.css';
import './warehouse-warranty.css';

/**
 * The warehouse's view of the used batteries (S24, S27). The Almacén is where the pool lives: the
 * branches deliver their used batteries in the closed settlements, the factory sends back the units it
 * refused, the counter lends them to the clients of a warranty case and gets some of them back.
 *
 * Every number here is derived and none is stored (S18): the screen publishes the five terms of the
 * contract and their signed sum, so an operator who counts reads the documents the figure is made of
 * instead of trusting a ledger that does not exist. The used battery is never sellable stock — it does
 * not enter the catalogue and the counter cannot sell it — and this vertical adds no sale, no fund and
 * no money (S28).
 */

export interface UsedStockProps {
  /** Every provisioned location: the stock is published per location and per model. */
  locations: readonly Location[];
  fetcher?: typeof globalThis.fetch;
}

interface StockState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly UsedStockRow[];
  readonly problem: string;
}

/** A refusal this screen can act on says so; any other failure is the read that could not be made. */
function problemOf(failure: unknown): string {
  if (failure instanceof WarrantyCaseAPIError
    && (failure.code === 'forbidden' || failure.code === 'unauthenticated')) {
    return warrantyCaseErrorMessages[failure.code];
  }
  return usedStockUnavailable;
}

const locationName = (locations: readonly Location[], id: number): string =>
  locations.find(entry => entry.id === id)?.name ?? `Ubicación ${id}`;
const models = (count: number): string => `${count} ${count === 1 ? 'modelo' : 'modelos'}`;

export default function UsedStock({ locations, fetcher = globalThis.fetch }: UsedStockProps) {
  const api = useMemo(() => createWarrantyCasesAPI(fetcher), [fetcher]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<StockState>({ phase: 'loading', rows: [], problem: usedStockUnavailable });

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setState(current => ({ phase: 'loading', rows: current.rows, problem: usedStockUnavailable }));
    void (async () => {
      try {
        const rows = await api.usedStock(controller.signal);
        if (alive) setState({ phase: 'ready', rows, problem: '' });
      } catch (failure) {
        if (alive) setState({ phase: 'error', rows: [], problem: problemOf(failure) });
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [api, revision]);

  // A loan takes a unit out of a location and a factory return puts one in, so the stock of this screen
  // changes with the case: the participant invalidation of the guarantee re-reads it, without a reload.
  useEffect(() => subscribeWarrantyInvalidation(() => setRevision(value => value + 1)), []);

  const held = usedStockAt(state.rows, usedStockWarehouse);
  const heldTotals = usedStockTotals(held);
  const everywhereTotals = usedStockTotals(state.rows);

  return <section className="used-stock" aria-labelledby="used-stock-title">
    <header className="warranty-heading">
      <small>Almacén / Garantías</small>
      <h1 id="used-stock-title">Stock de usadas</h1>
      <p>Las baterías usadas que el Almacén tiene, por modelo: lo que entregaron las sucursales en sus
        rendiciones cerradas, lo que fábrica devolvió al no cubrir una garantía, lo que salió prestado a
        un cliente y lo que volvió del préstamo. Se calcula con esos documentos.</p>
    </header>

    {/* Stated once, above the numbers: an operator who counts must not take this for a ledger. */}
    <div className="warranty-custody">
      <strong>Es un stock derivado: no hay ningún saldo guardado.</strong>
      <p>La cifra es la suma firmada de los hechos ya registrados —compras, rendiciones cerradas,
        préstamos y devoluciones de fábrica— y ninguna tabla guarda un total, así que el número no puede
        quedar desfasado de los documentos. Por la misma razón nadie lo ajusta a mano: lo que cambia es
        el hecho, y la suma lo sigue. No es stock vendible: la usada no entra al catálogo, no se revende
        y el punto de venta no puede venderla.</p>
    </div>

    <section className="warranty-list" aria-label="Stock del Almacén" aria-busy={state.phase === 'loading'}>
      {state.phase === 'loading' && state.rows.length === 0
        && <p className="warranty-message" role="status">Consultando el stock derivado…</p>}
      {state.phase === 'error' && <p className="warranty-message" role="alert">{state.problem}
        <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar stock</button></p>}
      {state.phase === 'ready' && held.length === 0 && <p className="warranty-message" role="status">
        El Almacén no tiene ninguna usada registrada. Las usadas entran con lo que las sucursales entregan
        en sus rendiciones cerradas y con lo que fábrica devuelve al no cubrir una garantía: sin ese hecho
        no hay una fila que mostrar.
      </p>}
      {state.phase !== 'error' && held.length > 0 && <>
        <h2 className="used-stock-title">Lo que el Almacén tiene</h2>
        <div className="warranty-table-wrap">
          <table className="warranty-table used-stock-table">
            <caption>El stock del Almacén por modelo: los cinco hechos que lo forman y su suma. La entrega
              de una sucursal entra acá y sale de la sucursal, y una devolución de fábrica es del Almacén,
              que fue quien envió la batería y quien la recibió de vuelta.</caption>
            <thead><tr>
              <th scope="col">Modelo</th>
              <th scope="col" className="num">Compradas</th>
              <th scope="col" className="num">Devueltas de fábrica</th>
              <th scope="col" className="num">Entregadas por sucursales</th>
              <th scope="col" className="num">Prestadas</th>
              <th scope="col" className="num">Devueltas de préstamo</th>
              <th scope="col" className="num">Disponible</th>
            </tr></thead>
            <tbody>{held.map(row => <tr key={row.model} data-model={row.model}>
              <td data-label="Modelo"><strong>{row.model}</strong></td>
              <td data-label="Compradas" className="num">{row.purchased}</td>
              <td data-label="Devueltas de fábrica" className="num">{row.factory_returns}</td>
              <td data-label="Entregadas por sucursales" className="num">{row.delivered}</td>
              <td data-label="Prestadas" className="num">{row.loans_given}</td>
              <td data-label="Devueltas de préstamo" className="num">{row.loans_returned}</td>
              <td data-label="Disponible" className="num">{row.available}
                <span className="purchases-unit">unidades</span></td>
            </tr>)}</tbody>
            <tfoot><tr>
              <td className="label">{`${models(held.length)} · ${usedStockUnits(heldTotals.available)}`}</td>
              <td className="num">{heldTotals.purchased}</td>
              <td className="num">{heldTotals.factory_returns}</td>
              <td className="num">{heldTotals.delivered}</td>
              <td className="num">{heldTotals.loans_given}</td>
              <td className="num">{heldTotals.loans_returned}</td>
              <td className="num">{heldTotals.available}</td>
            </tr></tfoot>
          </table>
        </div>
      </>}
    </section>

    {state.phase !== 'error' && state.rows.length > 0 && <section className="warranty-list"
      aria-label="Dónde está la usada">
      <h2 className="used-stock-title">Dónde está la usada</h2>
      <p className="warranty-note used-stock-note">El mismo número, por ubicación y por modelo. El préstamo
        de una usada puede salir de la sucursal del caso, del Almacén o de otra sucursal, así que el
        mostrador lee las tres antes de prometer una batería.</p>
      <div className="warranty-table-wrap">
        <table className="warranty-table used-stock-table">
          <caption>Lo que cada ubicación tiene de cada modelo. Una ubicación sin ningún hecho de un modelo
            no tiene fila: acá no se inventan ceros.</caption>
          <thead><tr>
            <th scope="col">Ubicación</th>
            <th scope="col">Modelo</th>
            <th scope="col" className="num">Disponible</th>
          </tr></thead>
          <tbody>{state.rows.map(row => <tr key={`${row.location_id}-${row.model}`}
            data-location={row.location_id} data-model={row.model}>
            <td data-label="Ubicación">{locationName(locations, row.location_id)}</td>
            <td data-label="Modelo"><strong>{row.model}</strong></td>
            <td data-label="Disponible" className="num">{row.available}
              <span className="purchases-unit">unidades</span></td>
          </tr>)}</tbody>
          <tfoot><tr>
            <td className="label">{`${models(state.rows.length)} en toda la instalación`}</td>
            <td className="num" />
            <td className="num">{everywhereTotals.available}</td>
          </tr></tfoot>
        </table>
      </div>
    </section>}

    <p className="warranty-note used-stock-footline">Un número negativo no es un error de la pantalla: es
      la suma de todo el historial y nunca un tope, y una usada que se prestó antes de que el préstamo
      validara su origen igual cuenta. La usada es la misma corriente que la chatarra, contada por unidad
      y por modelo en vez de por kilo.</p>
  </section>;
}
