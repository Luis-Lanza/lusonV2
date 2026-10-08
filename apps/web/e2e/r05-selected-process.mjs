// No default spawn: compose the frozen selected reader with owned-handle execution.
import { types } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createR05SelectedMetadataReader } from './r05-selected-metadata.mjs';
const refuse = () => { throw new Error('R05 selected process refused.'); };
const check = v => { if (!v) refuse(); };
function own(v) {
  check(v && typeof v === 'object' && !types.isProxy(v) && Object.getPrototypeOf(v) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(ds).every(k => typeof k === 'string' && ds[k].enumerable && 'value' in ds[k])); return ds;
}
function exact(v, names) {
  const ds = own(v); check(Object.keys(ds).sort().join(' ') === names.split(' ').sort().join(' ')); return ds;
}
function copy(input) {
  let nodes = 0, bytes = 0;
  function visit(v, depth) {
    check(depth <= 8 && ++nodes <= 128);
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); check(v.length <= 4096 && bytes <= 16384); return v; }
    const ds = own(v); check(Object.keys(ds).length <= 16); const result = {};
    for (const k of Object.keys(ds)) {
      check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k));
      result[k] = visit(ds[k].value, depth+1);
    }
    return result;
  }
  return visit(input, 0);
}
const callable = v => typeof v === 'function' && !types.isProxy(v);
const path = v => typeof v === 'string' && isAbsolute(v) && resolve(v) === v && !/[\s\x00-\x1f\x7f]/.test(v);
function freeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v;
}
export function createR05SelectedProcessReader(input) {
  try {
    const ds = own(input); exact(input, 'project volumeName images binary cwd env spawn'+(ds.clock ? ' clock' : ''));
    const config = copy(Object.fromEntries(['project', 'volumeName', 'images', 'binary', 'cwd', 'env'].map(k => [k, ds[k].value])));
    check(path(config.binary) && path(config.cwd));
    for (const [k, v] of Object.entries(config.env)) {
      check(['LANG', 'LC_ALL', 'HOME', 'DOCKER_CONFIG', 'DOCKER_HOST'].includes(k));
      check(k === 'LANG' || k === 'LC_ALL' ? v === 'C' : k === 'DOCKER_HOST' ? v.startsWith('unix://') && path(v.slice(7)) : path(v));
    }
    const refs = ['HOME', 'DOCKER_CONFIG', 'DOCKER_HOST'].filter(k => k in config.env); check(refs.length === 0 || refs.length === 3);
    const spawn = ds.spawn.value; check(callable(spawn));
    const clock = ds.clock ? ds.clock.value : { now: () => performance.now(), setTimeout, clearTimeout };
    const timers = exact(clock, 'now setTimeout clearTimeout'); check(Object.values(timers).every(d => callable(d.value)));
    const now = timers.now.value, arm = timers.setTimeout.value, clear = timers.clearTimeout.value;
    return createR05SelectedMetadataReader({ project: config.project, volumeName: config.volumeName, images: config.images,
      execute: request => execute(spawn, config, request, now, arm, clear) });
  } catch { refuse(); }
}
function execute(spawn, config, request, now, arm, clear) {
  return new Promise((resolveResult, reject) => {
    const start = now(); check(Number.isFinite(start) && start >= 0);
    const deadline = start+request.timeout_ms;
    const child = spawn(config.binary, [...request.argv], freeze({ cwd: config.cwd, env: { ...config.env },
      shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] }));
    let failed = false, ended = false, closed = false, settled = false, cancelAttempted = false;
    let outClosed = child.stdout === null, errClosed = child.stderr === null, alarm = null, last = start, bytes = 0, chunks = [];
    const listeners = [];
    const stop = () => { if (alarm !== null) { try { clear(alarm); } catch {} alarm = null; } };
    const fail = () => {
      if (failed) return; failed = true; chunks = []; stop();
      // kill()/killed are NOT termination proof. Never use PID/group signalling.
      if (!ended && !closed && child.exitCode === null && child.signalCode === null && !cancelAttempted) {
        cancelAttempted = true; try { child.kill(); } catch {} // One default SIGTERM attempt only.
      }
    };
    const expired = () => {
      try { const time = now(); if (!Number.isFinite(time) || time < last || time >= deadline) return true; last = time; return false; }
      catch { return true; }
    };
    const settle = () => {
      if (settled || !closed || !outClosed || !errClosed) return;
      if (expired()) fail(); settled = true; stop();
      for (const [target, event, fn] of listeners) target.removeListener(event, fn);
      if (failed) { reject(new Error('R05 selected process refused.')); return; }
      try { resolveResult({ exitCode: 0, stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)) }); }
      catch { reject(new Error('R05 selected process refused.')); }
      chunks = [];
    };
    const on = (target, event, fn) => { target.on(event, fn); listeners.push([target, event, fn]); };
    if (child.stdout) {
      on(child.stdout, 'data', chunk => {
        if (failed) return;
        if (expired() || !Buffer.isBuffer(chunk) || bytes+chunk.length > request.max_stdout_bytes) { fail(); return; }
        bytes += chunk.length; chunks.push(Buffer.from(chunk)); // Copy only after raw-byte admission.
      });
      on(child.stdout, 'error', fail);
      on(child.stdout, 'close', () => { outClosed = true; if (expired()) fail(); settle(); });
    }
    if (child.stderr) {
      on(child.stderr, 'data', chunk => { if (!Buffer.isBuffer(chunk) || chunk.length > request.max_stderr_bytes) fail(); });
      on(child.stderr, 'error', fail);
      on(child.stderr, 'close', () => { errClosed = true; if (expired()) fail(); settle(); });
    }
    on(child, 'error', fail); // Spawn error is NOT close; retain settlement listeners.
    on(child, 'exit', (code, signal) => { ended = true; if (code !== 0 || signal !== null || expired()) fail(); });
    on(child, 'close', (code, signal) => { closed = true; ended = true; if (code !== 0 || signal !== null) fail(); settle(); });
    if (expired()) fail();
    else if (!failed) {
      try { alarm = arm(() => { alarm = null; fail(); }, Math.max(0, deadline-last)); }
      catch { fail(); } // Scheduling failure still owns a live handle: quarantine, do not reject early.
    }
  });
}
