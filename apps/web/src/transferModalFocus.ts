import { useLayoutEffect, useRef } from 'react';

export interface TransferModalFocusRequest {
  id: string; fence: string; trigger: HTMLElement; scope?: object;
}
export interface TransferModalFocusBinding {
  scope: object;
  restore: (request: TransferModalFocusRequest) => void;
}
export function isTransferFocusTarget(target: HTMLElement | null): target is HTMLElement {
  return !!target?.isConnected && !target.matches(':disabled');
}
export function useTransferModalFocus(options: {
  active: boolean; id?: string; fence: string; current: () => boolean;
  binding?: TransferModalFocusBinding;
}) {
  const latest = useRef(options);
  latest.current = options;
  const opening = useRef<{ id: string | undefined; fence: string; scope?: object } | null>(null);
  const pending = useRef<TransferModalFocusRequest | null>(null);
  const opened = opening.current;
  useLayoutEffect(() => () => { pending.current = null; opening.current = null; }, []);
  useLayoutEffect(() => {
    const request = pending.current;
    if (options.active || !request) return;
    pending.current = null;
    const now = latest.current;
    if (!now.current() || now.id !== request.id || now.fence !== request.fence) return;
    if (now.binding) {
      if (now.binding.scope === request.scope) now.binding.restore(request);
    } else if (!request.scope && isTransferFocusTarget(request.trigger)) request.trigger.focus();
  });
  return {
    begin: () => { const now = latest.current; opening.current = { id: now.id, fence: now.fence, scope: now.binding?.scope }; pending.current = null; },
    queue: (request: Omit<TransferModalFocusRequest, 'scope'>) => {
      const now = latest.current;
      if (!opened || opening.current !== opened || !now.active || !now.current()
        || opened.id !== request.id || opened.fence !== request.fence || now.id !== request.id || now.fence !== request.fence
        || opened.scope !== now.binding?.scope) return;
      pending.current = { ...request, scope: opened.scope };
    },
  };
}
