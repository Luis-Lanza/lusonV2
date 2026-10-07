// No shell or resource client: dispatch is explicitly supplied by the parent.
import { admit, refused, digest } from './r05-binding.mjs';
export class R05OwnedCompose {
  #manifest; #inspect; #dispatch; #sequence = 0; #busy = false; #plans = new WeakSet();
  constructor({ manifest, inspect, dispatch } = {}) {
    if (!manifest || typeof inspect !== 'function' || typeof dispatch !== 'function') refused();
    try { this.#manifest = structuredClone(manifest); } catch { refused(); }
    this.#inspect = inspect; this.#dispatch = dispatch;
  }
  async #fresh(phase) {
    const snapshot = await this.#inspect();
    admit(this.#manifest, snapshot, phase);
    if (snapshot.sequence <= this.#sequence) refused();
    this.#sequence = snapshot.sequence;
  }
  async #guarded(phase, action) {
    if (this.#busy) refused();
    this.#busy = true;
    try { await this.#fresh(phase); return await action(); }
    catch { refused(); } finally { this.#busy = false; }
  }
  async createPlan() {
    return this.#guarded('prepare', async () => Object.freeze({ operation: 'prepare-new',
      project: this.#manifest.project, run_id: this.#manifest.run_id, config_digest: this.#manifest.config_digest }));
  }
  async sql(query) {
    // Driver must transport parameterized data on stdin, never argv or ENV.
    if (!query || Object.keys(query).sort().join(',') !== 'text,values' || typeof query.text !== 'string'
      || !query.text.length || query.text.length > 65536 || !Array.isArray(query.values)) refused();
    const stdin = structuredClone(query);
    return this.#guarded('active', () => this.#dispatch({ operation: 'sql', id: this.#manifest.services.db.id, stdin }));
  }
  async cleanupPlan() {
    return this.#guarded('active', async () => {
      const m = this.#manifest;
      const plan = Object.freeze({ operation: 'cleanup-exact', containers: Object.freeze([m.services.app.id,m.services.db.id]),
        network: m.network.id, volume: m.volume.id, binding: digest(m) });
      this.#plans.add(plan); return plan;
    });
  }
  async cleanup(plan, { settled } = {}) {
    if (settled !== true || !this.#plans.has(plan)) refused();
    return this.#guarded('active', async () => {
      this.#plans.delete(plan);
      // One checked transaction contract; no down/prune/force/adoption verbs.
      return this.#dispatch(plan);
    });
  }
}
