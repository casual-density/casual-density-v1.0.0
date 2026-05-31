'use strict';

var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/snapshot.ts
var snapshot_exports = {};
__export(snapshot_exports, {
  DensitySnapshot: () => exports.DensitySnapshot,
  buildSnapshot: () => buildSnapshot
});
async function computeSnapshotHash(rho, eventCount, causalSpan, wallNs) {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  view.setFloat64(0, rho, true);
  view.setUint32(8, eventCount, true);
  view.setUint32(12, causalSpan, true);
  view.setUint32(16, Number(wallNs & 0xffffffffn), true);
  view.setUint32(20, Number(wallNs >> 32n & 0xffffffffn), true);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function buildSnapshot(eventCount, minDepth, maxDepth, peerCardinalityEstimate) {
  if (eventCount === 0) return exports.DensitySnapshot.ZERO;
  const causalSpan = Math.max(maxDepth - minDepth, MIN_CAUSAL_SPAN);
  const peerCardinality = Math.max(peerCardinalityEstimate, MIN_PEER_CARDINALITY);
  const rho = eventCount / (causalSpan * peerCardinality);
  const wallNs = BigInt(Date.now()) * 1000000n;
  const snapshotHash = await computeSnapshotHash(rho, eventCount, causalSpan, wallNs);
  return new exports.DensitySnapshot({
    rho,
    eventCount,
    causalSpan,
    peerCardinality,
    wallNs,
    snapshotHash
  });
}
var _DensitySnapshot; exports.DensitySnapshot = void 0; var MIN_CAUSAL_SPAN, MIN_PEER_CARDINALITY;
var init_snapshot = __esm({
  "src/snapshot.ts"() {
    _DensitySnapshot = class _DensitySnapshot {
      constructor(data) {
        this.rho = data.rho;
        this.eventCount = data.eventCount;
        this.causalSpan = data.causalSpan;
        this.peerCardinality = data.peerCardinality;
        this.wallNs = data.wallNs;
        this.snapshotHash = data.snapshotHash;
      }
      /** Returns true if this snapshot carries real density data (not a zero value). */
      get isValid() {
        return this.eventCount > 0 && this.snapshotHash !== "";
      }
      /**
       * Compare this snapshot to another.
       * Returns +1 if this is causally denser, -1 if other is, 0 if equal.
       *
       * Ordering rules (applied in sequence):
       *   1. Higher rho wins          — primary density signal, clock-free
       *   2. Higher eventCount wins   — more data = more confidence
       *   3. Larger snapshotHash wins — deterministic tie-break, never drops
       */
      compareTo(other) {
        const EPS = 1e-9;
        if (this.rho > other.rho + EPS) return 1;
        if (other.rho > this.rho + EPS) return -1;
        if (this.eventCount > other.eventCount) return 1;
        if (other.eventCount > this.eventCount) return -1;
        if (this.snapshotHash > other.snapshotHash) return 1;
        if (other.snapshotHash > this.snapshotHash) return -1;
        return 0;
      }
      /** Serialize to plain object for JSON transport. */
      toJSON() {
        return {
          rho: this.rho,
          eventCount: this.eventCount,
          causalSpan: this.causalSpan,
          peerCardinality: this.peerCardinality,
          wallNs: this.wallNs.toString(),
          snapshotHash: this.snapshotHash
        };
      }
      /** Deserialize from JSON. */
      static fromJSON(obj) {
        return new _DensitySnapshot({
          rho: Number(obj["rho"]),
          eventCount: Number(obj["eventCount"]),
          causalSpan: Number(obj["causalSpan"]),
          peerCardinality: Number(obj["peerCardinality"]),
          wallNs: BigInt(String(obj["wallNs"])),
          snapshotHash: String(obj["snapshotHash"])
        });
      }
    };
    /** Zero-value snapshot (represents a node with no observations). */
    _DensitySnapshot.ZERO = new _DensitySnapshot({
      rho: 0,
      eventCount: 0,
      causalSpan: 0,
      peerCardinality: 0,
      wallNs: 0n,
      snapshotHash: ""
    });
    exports.DensitySnapshot = _DensitySnapshot;
    MIN_CAUSAL_SPAN = 1;
    MIN_PEER_CARDINALITY = 1;
  }
});

// src/index.ts
init_snapshot();

// src/hll.ts
var HLL_PRECISION = 8;
var HLL_M = 1 << HLL_PRECISION;
var HLL_ALPHA = 0.7213 / (1 + 1.079 / HLL_M);
function fnv32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
var HyperLogLog = class _HyperLogLog {
  constructor() {
    this.registers = new Uint8Array(HLL_M);
  }
  /** Add a peer ID string to the sketch. O(1). */
  add(peerID) {
    const hash = fnv32(peerID);
    const idx = hash >>> 32 - HLL_PRECISION;
    const w = hash << HLL_PRECISION >>> 0;
    const rho = Math.clz32(w) + 1;
    if (rho > (this.registers[idx] ?? 0)) {
      this.registers[idx] = rho;
    }
  }
  /** Estimate cardinality. O(256). */
  estimate() {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < HLL_M; i++) {
      const v = this.registers[i] ?? 0;
      sum += Math.pow(2, -v);
      if (v === 0) zeros++;
    }
    let est = HLL_ALPHA * HLL_M * HLL_M / sum;
    if (est <= 2.5 * HLL_M && zeros > 0) {
      est = HLL_M * Math.log(HLL_M / zeros);
    }
    return est;
  }
  /** Merge another sketch into this one (union). O(256). */
  merge(other) {
    const otherRegs = other.registers;
    for (let i = 0; i < HLL_M; i++) {
      const ov = otherRegs[i] ?? 0;
      if (ov > (this.registers[i] ?? 0)) {
        this.registers[i] = ov;
      }
    }
  }
  /** Return a deep copy of this sketch. */
  clone() {
    const copy = new _HyperLogLog();
    copy.registers.set(this.registers);
    return copy;
  }
  /** Serialize registers to a plain array (for JSON transport). */
  toJSON() {
    return Array.from(this.registers);
  }
  /** Restore from a serialized register array. */
  static fromJSON(registers) {
    const hll = new _HyperLogLog();
    for (let i = 0; i < Math.min(registers.length, HLL_M); i++) {
      hll.registers[i] = registers[i] ?? 0;
    }
    return hll;
  }
};

// src/field.ts
init_snapshot();
var RING_SIZE = 256;
var RING_MASK = RING_SIZE - 1;
var DEFAULT_WINDOW_MS = 5 * 6e4;
var CausalDensityField = class {
  constructor(options = {}) {
    this.head = 0;
    this.totalEvents = 0;
    // Full HLL sketch — updated on every observe()
    // Rebuilt over the window on snapshot() to exclude expired events
    this.sketch = new HyperLogLog();
    this.ring = new Array(RING_SIZE).fill(null);
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.onObserve = options.onObserve;
  }
  /**
   * Record a new DHT/network event from a peer.
   *
   * @param peerID      - peer identifier string (peer.ID, node address, etc.)
   * @param causalDepth - VSE parent_ids chain length. Pass 0 if unknown.
   *                      Higher = deeper in the causal graph = more history.
   */
  observe(peerID, causalDepth) {
    const evt = {
      wallMs: Date.now(),
      causalDepth,
      peerID
    };
    this.ring[this.head & RING_MASK] = evt;
    this.head = this.head + 1 & 2147483647;
    this.totalEvents++;
    this.sketch.add(peerID);
    this.onObserve?.(this.totalEvents);
  }
  /**
   * Compute and return the current density snapshot.
   * Async because it computes a SHA-256 hash for tamper-proofing.
   * O(256) — safe to call frequently.
   *
   * @returns DensitySnapshot — immutable, JSON-serializable, embeddable
   */
  async snapshot() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let eventCount = 0;
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    const windowSketch = new HyperLogLog();
    for (let i = 0; i < RING_SIZE; i++) {
      const evt = this.ring[i];
      if (!evt) continue;
      if (evt.wallMs < cutoff) continue;
      eventCount++;
      if (evt.causalDepth < minDepth) minDepth = evt.causalDepth;
      if (evt.causalDepth > maxDepth) maxDepth = evt.causalDepth;
      windowSketch.add(evt.peerID);
    }
    if (eventCount === 0) return exports.DensitySnapshot.ZERO;
    return buildSnapshot(
      eventCount,
      minDepth,
      maxDepth,
      windowSketch.estimate()
    );
  }
  /**
   * Advance this field's causal depth tracking from a remote snapshot.
   * Call when receiving a DensitySnapshot from a peer.
   *
   * This is the density equivalent of HLC's "receive" step:
   * learning from a peer that has observed more causally deep events
   * advances our own position in the causal graph.
   */
  mergeObservations(remote) {
    if (!remote.isValid) return;
    this.observe("__remote__", remote.causalSpan);
  }
  /** Total events ever observed (monotonic counter). */
  get total() {
    return this.totalEvents;
  }
  /** Current window duration in milliseconds. */
  get windowDuration() {
    return this.windowMs;
  }
  /**
   * Peek at events in the current window without computing density.
   * Useful for debugging / visualization.
   */
  windowEvents() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const result = [];
    for (let i = 0; i < RING_SIZE; i++) {
      const evt = this.ring[i];
      if (!evt) continue;
      if (evt.wallMs < cutoff) continue;
      result.push({
        wallMs: evt.wallMs,
        causalDepth: evt.causalDepth,
        peerID: evt.peerID
      });
    }
    return result;
  }
};

// src/analysis.ts
init_snapshot();
function gradient(a, b) {
  const delta = a.rho - b.rho;
  const magnitude = Math.abs(delta);
  const direction = delta > 1e-9 ? 1 : delta < -1e-9 ? -1 : 0;
  const peerDivergence = Math.abs(a.peerCardinality - b.peerCardinality);
  const bothActive = a.eventCount > 10 && b.eventCount > 10;
  const maxCard = Math.max(a.peerCardinality, b.peerCardinality);
  const isPartitionSuspect = bothActive && maxCard > 0 && peerDivergence > 0.5 * maxCard;
  return { delta, direction, magnitude, peerDivergence, isPartitionSuspect };
}
async function interpolate(snapshots) {
  if (snapshots.length === 0) return exports.DensitySnapshot.ZERO;
  if (snapshots.length === 1) {
    const s = snapshots[0];
    return s !== void 0 ? s : exports.DensitySnapshot.ZERO;
  }
  let totalWeight = 0;
  let weightedRho = 0;
  let maxCount = 0;
  let maxSpan = 0;
  let maxCard = 0;
  for (const s of snapshots) {
    if (!s.isValid) continue;
    const w = s.eventCount;
    totalWeight += w;
    weightedRho += s.rho * w;
    if (s.eventCount > maxCount) maxCount = s.eventCount;
    if (s.causalSpan > maxSpan) maxSpan = s.causalSpan;
    if (s.peerCardinality > maxCard) maxCard = s.peerCardinality;
  }
  if (totalWeight === 0) return exports.DensitySnapshot.ZERO;
  const { buildSnapshot: buildSnapshot2 } = await Promise.resolve().then(() => (init_snapshot(), snapshot_exports));
  return buildSnapshot2(maxCount, 0, maxSpan, maxCard);
}
function normalize(rho, baseline = 1) {
  const b = baseline > 0 ? baseline : 1;
  const x = (rho - b) / (b * 0.5);
  return 1 / (1 + Math.exp(-x));
}
function selectDensest(snapshots) {
  if (snapshots.length === 0) return null;
  let best = snapshots[0];
  if (best === void 0) return null;
  for (let i = 1; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (s !== void 0 && s.compareTo(best) > 0) {
      best = s;
    }
  }
  return best;
}
function rankByDensity(snapshots) {
  return [...snapshots].sort((a, b) => b.compareTo(a));
}

exports.CausalDensityField = CausalDensityField;
exports.HyperLogLog = HyperLogLog;
exports.fnv32 = fnv32;
exports.gradient = gradient;
exports.interpolate = interpolate;
exports.normalize = normalize;
exports.rankByDensity = rankByDensity;
exports.selectDensest = selectDensest;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map