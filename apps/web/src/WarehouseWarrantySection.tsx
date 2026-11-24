import type { Location } from './model';
import UsedStock from './UsedStock';
import WarehouseWarrantyCases from './WarehouseWarrantyCases';
import './warranty-cases.css';

/**
 * The two screens of the warehouse side of the guarantee: the factory desk, where the cases are moved,
 * and the stock of used batteries, which is what the Almacén holds of them (S24). Both belong to the
 * same section and to the same warehouse authority, and only one of them is on the page at a time — the
 * desk's questions and the stock's five terms are two different readings and neither is a filter of the
 * other.
 *
 * The screen lives in the hash (`#/garantias` and `#/garantias/usadas`), so a reload lands back on the
 * one the operator left, exactly like the catalogue's own screens.
 */

export type WarehouseWarrantyTab = 'desk' | 'used-stock';

export interface WarehouseWarrantySectionProps {
  /** The screen the route names; the desk is the section's own. */
  screen: WarehouseWarrantyTab;
  onScreen: (screen: WarehouseWarrantyTab) => void;
  /** The session's CSRF token, captured by the shell that mounted this screen. */
  csrf: string;
  /** Every provisioned location: a case names its branch and the stock names where the usada is. */
  locations: readonly Location[];
  fetcher?: typeof globalThis.fetch;
  /** The clock the desk's ages are measured against; the tests freeze it. */
  now?: () => Date;
}

const tabs: { readonly screen: WarehouseWarrantyTab; readonly label: string }[] = [
  { screen: 'desk', label: 'Mesa de fábrica' },
  { screen: 'used-stock', label: 'Stock de usadas' },
];

export default function WarehouseWarrantySection({ screen, onScreen, csrf, locations,
  fetcher = globalThis.fetch, now }: WarehouseWarrantySectionProps) {
  return <div className="warranty-screens">
    <div className="warranty-phase-tabs" role="group" aria-label="Pantallas de garantías del Almacén">
      {tabs.map(tab => <button type="button" key={tab.screen} aria-pressed={screen === tab.screen}
        onClick={() => onScreen(tab.screen)}>{tab.label}</button>)}
    </div>
    {screen === 'used-stock'
      ? <UsedStock locations={locations} fetcher={fetcher} />
      : <WarehouseWarrantyCases csrf={csrf} locations={locations} fetcher={fetcher} now={now} />}
  </div>;
}
