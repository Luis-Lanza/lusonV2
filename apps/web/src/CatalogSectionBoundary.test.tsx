import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CatalogSectionBoundary, { catalogSectionFailureMessage } from './CatalogSectionBoundary';

function Boom(): never { throw new Error('el catálogo arrojó'); }

const quietErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => { vi.restoreAllMocks(); });

const shell = (children: ReactNode) => <div>
  <p>Resto de la aplicación</p>
  <CatalogSectionBoundary>{children}</CatalogSectionBoundary>
</div>;

describe('catalogue section boundary', () => {
  it('contains a throwing section instead of letting it escape the app', () => {
    quietErrors();
    expect(() => render(shell(<Boom />))).not.toThrow();
    expect(screen.getByRole('alert')).toHaveTextContent(catalogSectionFailureMessage);
    expect(screen.getByText('Resto de la aplicación')).toBeInTheDocument();
    expect(screen.queryByText('el catálogo arrojó')).not.toBeInTheDocument();
  });

  it('remounts the section on retry so the reader gets a fresh attempt', () => {
    quietErrors();
    let broken = true;
    const renders = { count: 0 };
    function Section() {
      renders.count += 1;
      if (broken) throw new Error('el catálogo arrojó');
      return <p>Matriz de precios cargada</p>;
    }
    render(shell(<Section />));
    expect(screen.queryByText('Matriz de precios cargada')).not.toBeInTheDocument();
    const failed = renders.count;
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo' }));
    expect(screen.getByText('Matriz de precios cargada')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The section is mounted again, not merely re-rendered: one new child render.
    expect(renders.count).toBe(failed + 1);
  });

  it('keeps the failure contained while the section still throws', () => {
    quietErrors();
    render(shell(<Boom />));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo' }));
    expect(screen.getByRole('alert')).toHaveTextContent(catalogSectionFailureMessage);
    expect(screen.getByText('Resto de la aplicación')).toBeInTheDocument();
  });
});
