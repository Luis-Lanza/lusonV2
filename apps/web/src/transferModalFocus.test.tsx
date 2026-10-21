import { StrictMode, useRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTransferModalFocus, type TransferModalFocusRequest } from './transferModalFocus';

afterEach(() => vi.unstubAllGlobals());

it.each((['unchanged', 'identity', 'scope', 'fence', 'authority', 'reopen', 'unmount', 'commit'] as const).flatMap(mode =>
  (['snapshot', 'live'] as const).map(requestMode => ({ mode, requestMode }))))(
  'consumes only a current explicit close with reused DOM under StrictMode: $mode/$requestMode', async ({ mode, requestMode }) => {
    let id = 'A'; let fence = 'fence-A'; let allowed = true; let scope = {};
    let saved!: () => void;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    let restore = vi.fn((request: TransferModalFocusRequest) => request.trigger.focus());
    const originalRestore = restore;
    function Harness() {
      const [active, setActive] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      const focus = useTransferModalFocus({ active, id, fence, current: () => allowed, binding: { scope, restore } });
      return <>
        <button ref={trigger} onClick={() => { focus.begin(); setActive(true); }}>Abrir</button>
        {active && <button onClick={() => {
          const request = { id, fence, trigger: trigger.current! };
          saved = () => { focus.queue(requestMode === 'snapshot' ? request : { ...request, id, fence }); setActive(false); };
        }}>Retener cierre</button>}
        <button onClick={() => setActive(false)}>Ocultar automáticamente</button>
      </>;
    }
    const element = () => <StrictMode><Harness /></StrictMode>;
    const view = render(element());
    const trigger = screen.getByRole('button', { name: 'Abrir' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Retener cierre' }));
    const restoration = vi.spyOn(trigger, 'focus');
    if (mode === 'reopen') { fireEvent.click(screen.getByRole('button', { name: 'Ocultar automáticamente' })); fireEvent.click(trigger); }
    if (mode === 'scope') scope = {};
    if (mode === 'identity') id = 'B';
    if (mode === 'authority') allowed = false;
    if (mode === 'fence') fence = 'fence-B';
    restore = vi.fn((request: TransferModalFocusRequest) => {
      expect(screen.queryByRole('button', { name: 'Retener cierre' })).not.toBeInTheDocument();
      request.trigger.focus();
    });
    if (mode === 'unmount') view.unmount();
    else if (mode !== 'commit') view.rerender(element());
    await act(async () => { saved(); if (mode === 'commit') { id = 'B'; view.rerender(element()); } });
    if (mode !== 'unmount') view.rerender(element());
    if (mode !== 'unmount') expect(screen.getByRole('button', { name: 'Abrir' })).toBe(trigger);
    expect(restoration).toHaveBeenCalledTimes(mode === 'unchanged' ? 1 : 0);
    expect(restore).toHaveBeenCalledTimes(mode === 'unchanged' ? 1 : 0);
    expect(originalRestore).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    restoration.mockRestore();
    view.unmount();
  },
);
