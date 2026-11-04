import { Component, Fragment, type ReactNode } from 'react';
import './catalog-prices.css';

/** The one message the reader sees when the section itself fails. */
export const catalogSectionFailureMessage =
  'La sección del catálogo dejó de responder. El resto de la aplicación sigue funcionando.';

interface BoundaryProps { readonly children: ReactNode }
/** `attempt` is the identity of the mounted section: a retry changes it. */
interface BoundaryState { readonly failed: boolean; readonly attempt: number }

/**
 * Contains a failing catalogue section: the rest of the shell keeps working and
 * the reader can retry. The retry remounts the section under a new key, so the
 * new attempt starts from a fresh read instead of the state that just threw.
 */
export default class CatalogSectionBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true };
  }

  private retry = () => {
    this.setState(current => ({ failed: false, attempt: current.attempt + 1 }));
  };

  render() {
    if (this.state.failed) {
      return <section className="catalog-prices" role="alert">
        <section className="catalog-panel">
          <p className="catalog-message">{catalogSectionFailureMessage}</p>
          <button type="button" onClick={this.retry}>Reintentar catálogo</button>
        </section>
      </section>;
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
