import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
afterEach(() => {
  cleanup();
  // Navigation is browser state: each test starts independently, just like its DOM.
  window.history.replaceState(null, '', '/');
});
