/**
 * snapshot.ts — DensitySnapshot: immutable causal density stamp
 *
 * A DensitySnapshot is a 48-byte-equivalent record of a node's causal
 * density at a specific moment. Embed it in any record, message, or event
 * to give that artifact a clock-free causal position.
 *
 * Formula:
 *   ρ = EventCount / (CausalSpan × PeerCardinality)
 *
 * Where:
 *   EventCount      = events observed in sliding window
 *   CausalSpan      = max(causalDepth) − min(causalDepth) in window
 *                     (NOT wall time — causal depth = parent chain length)
 *   PeerCardinality = HLL-estimated distinct contributing peers
 *
 * Higher ρ = causally denser = more authoritative.
 * Clock is never consulted for ordering.
 */
interface DensitySnapshotData {
    /** ρ = EventCount / (CausalSpan × PeerCardinality) */
    readonly rho: number;
    /** Raw event count in measurement window */
    readonly eventCount: number;
    /** max(causalDepth) − min(causalDepth) in window */
    readonly causalSpan: number;
    /** HLL-estimated distinct contributing peers */
    readonly peerCardinality: number;
    /** Wall clock at snapshot time (fallback / audit only — NOT used for ordering) */
    readonly wallNs: bigint;
    /** SHA-256 binding rho||eventCount||causalSpan||wallNs */
    readonly snapshotHash: string;
}
/**
 * DensitySnapshot is an immutable causal density stamp.
 *
 * Create via `CausalDensityField.snapshot()` — do not construct directly
 * unless deserializing from JSON.
 */
declare class DensitySnapshot implements DensitySnapshotData {
    readonly rho: number;
    readonly eventCount: number;
    readonly causalSpan: number;
    readonly peerCardinality: number;
    readonly wallNs: bigint;
    readonly snapshotHash: string;
    constructor(data: DensitySnapshotData);
    /** Returns true if this snapshot carries real density data (not a zero value). */
    get isValid(): boolean;
    /**
     * Compare this snapshot to another.
     * Returns +1 if this is causally denser, -1 if other is, 0 if equal.
     *
     * Ordering rules (applied in sequence):
     *   1. Higher rho wins          — primary density signal, clock-free
     *   2. Higher eventCount wins   — more data = more confidence
     *   3. Larger snapshotHash wins — deterministic tie-break, never drops
     */
    compareTo(other: DensitySnapshot): 1 | -1 | 0;
    /** Serialize to plain object for JSON transport. */
    toJSON(): Record<string, unknown>;
    /** Deserialize from JSON. */
    static fromJSON(obj: Record<string, unknown>): DensitySnapshot;
    /** Zero-value snapshot (represents a node with no observations). */
    static readonly ZERO: DensitySnapshot;
}

/**
 * field.ts — CausalDensityField
 *
 * Maintains a sliding ring buffer of observed events and computes ρ on demand.
 * The ring buffer has fixed size (256 slots) — no unbounded memory growth.
 *
 * Usage:
 *
 *   const field = new CausalDensityField({ windowMs: 5 * 60_000 })
 *
 *   // Call on every observed network event
 *   field.observe('peer-QmAbc...', 42)    // peerID, causalDepth
 *
 *   // Embed in published records
 *   const snap = await field.snapshot()   // DensitySnapshot
 *
 *   // Advance when receiving records from peers
 *   field.mergeObservations(remoteSnapshot)
 */

interface DensityEvent {
    wallMs: number;
    causalDepth: number;
    peerID: string;
}
interface CausalDensityFieldOptions {
    /**
     * Sliding window duration in milliseconds.
     * Events older than this are excluded from density computation.
     * Default: 5 minutes (300_000 ms).
     *
     * Tune based on your system's event rate:
     *   - High-throughput DHT: 1–5 minutes
     *   - Low-traffic IoT: 30–60 minutes
     *   - Unit tests: 1_000 ms
     */
    windowMs?: number;
    /**
     * Called after every observe() call with the current total event count.
     * Use for Prometheus counters or debug logging.
     */
    onObserve?: (totalEvents: number) => void;
}
/**
 * CausalDensityField measures causal event density for a single node.
 *
 * ρ = EventCount / (CausalSpan × PeerCardinality)
 *
 * - EventCount    — events in the sliding window
 * - CausalSpan    — max(depth) − min(depth) in window (NOT wall time)
 * - PeerCardinality — HLL estimate of distinct contributing peers
 *
 * The result is a clock-free density scalar. Records stamped with high ρ
 * are causally authoritative over records stamped with low ρ, regardless
 * of what any wall clock says.
 */
declare class CausalDensityField {
    private readonly ring;
    private head;
    private totalEvents;
    private readonly windowMs;
    private readonly onObserve;
    private sketch;
    constructor(options?: CausalDensityFieldOptions);
    /**
     * Record a new DHT/network event from a peer.
     *
     * @param peerID      - peer identifier string (peer.ID, node address, etc.)
     * @param causalDepth - VSE parent_ids chain length. Pass 0 if unknown.
     *                      Higher = deeper in the causal graph = more history.
     */
    observe(peerID: string, causalDepth: number): void;
    /**
     * Compute and return the current density snapshot.
     * Async because it computes a SHA-256 hash for tamper-proofing.
     * O(256) — safe to call frequently.
     *
     * @returns DensitySnapshot — immutable, JSON-serializable, embeddable
     */
    snapshot(): Promise<DensitySnapshot>;
    /**
     * Advance this field's causal depth tracking from a remote snapshot.
     * Call when receiving a DensitySnapshot from a peer.
     *
     * This is the density equivalent of HLC's "receive" step:
     * learning from a peer that has observed more causally deep events
     * advances our own position in the causal graph.
     */
    mergeObservations(remote: DensitySnapshot): void;
    /** Total events ever observed (monotonic counter). */
    get total(): number;
    /** Current window duration in milliseconds. */
    get windowDuration(): number;
    /**
     * Peek at events in the current window without computing density.
     * Useful for debugging / visualization.
     */
    windowEvents(): DensityEvent[];
}

/**
 * analysis.ts — density field analysis utilities
 *
 * gradient()     — directional density difference between two snapshots
 * interpolate()  — weighted average across multiple peer snapshots
 * normalize()    — sigmoid mapping to [0, 1] for cross-network comparison
 * selectDensest() — pick the most causally authoritative snapshot from a set
 */

/**
 * DensityGradient represents the directional density difference between two
 * causal positions. Analogous to a gradient field in physics — tells you
 * which direction is "causally upstream" (toward higher authority).
 */
interface DensityGradient {
    /** Signed density difference: a.rho − b.rho */
    readonly delta: number;
    /** +1 if a is denser, -1 if b is denser, 0 if equal */
    readonly direction: 1 | -1 | 0;
    /** |delta| — strength of the gradient */
    readonly magnitude: number;
    /**
     * Estimated difference in peer cardinality between a and b.
     * High PeerDivergence with low magnitude → possible network partition:
     * both nodes are active but observing different peer sets.
     */
    readonly peerDivergence: number;
    /**
     * True when the gradient suggests a network partition rather than
     * normal causal ordering.
     *
     * Heuristic: both nodes active (eventCount > 10) AND peer cardinalities
     * diverge by more than 50% of the larger value.
     */
    readonly isPartitionSuspect: boolean;
}
/**
 * Compute the density gradient between two snapshots.
 *
 * @param a - first snapshot (typically the local node)
 * @param b - second snapshot (typically a remote peer)
 * @returns DensityGradient with direction, magnitude, and partition signal
 *
 * @example
 * const g = gradient(localSnap, remoteSnap)
 * if (g.direction === 1) {
 *   // local node is causally upstream — our records are authoritative
 * } else if (g.isPartitionSuspect) {
 *   // possible network partition — investigate before trusting either
 * }
 */
declare function gradient(a: DensitySnapshot, b: DensitySnapshot): DensityGradient;
/**
 * Compute a weighted average density across multiple peer snapshots.
 *
 * Weights are proportional to eventCount — peers with more observations
 * contribute more to the result. Use this during query consolidation when
 * responses arrive from many DHT peers.
 *
 * Returns DensitySnapshot.ZERO if the input array is empty or all invalid.
 *
 * @example
 * const peerSnaps = responses.map(r => r.density)
 * const networkDensity = await interpolate(peerSnaps)
 */
declare function interpolate(snapshots: DensitySnapshot[]): Promise<DensitySnapshot>;
/**
 * Map a raw density scalar to [0, 1] using a sigmoid centered at `baseline`.
 *
 * This allows density values from nodes at different network scales to be
 * compared meaningfully. A node on a small testnet and one on the main IPFS
 * network both map to comparable normalized values.
 *
 * @param rho      - raw density scalar from DensitySnapshot.rho
 * @param baseline - expected ρ for a "normal" node in your deployment.
 *                   Measure empirically over 24h, use the median.
 *                   Default: 1.0 (conservative starting point)
 *
 * @returns number in [0, 1] where 0.5 = at baseline density
 *
 * @example
 * const norm = normalize(snap.rho, myBaseline)
 * // norm > 0.5 → above average density → more authoritative
 * // norm < 0.5 → below average density → less authoritative
 */
declare function normalize(rho: number, baseline?: number): number;
/**
 * Select the most causally authoritative snapshot from a set of candidates.
 *
 * Applies DensitySnapshot.compareTo() — same rules as CausalSelector:
 *   1. Highest rho wins
 *   2. Highest eventCount wins on tie
 *   3. Largest snapshotHash wins (deterministic, never drops)
 *
 * Returns null if the array is empty.
 *
 * @example
 * const best = selectDensest(peerSnapshots)
 * if (best) dht.preferRecord(best)
 */
declare function selectDensest(snapshots: DensitySnapshot[]): DensitySnapshot | null;
/**
 * Sort snapshots from densest (most authoritative) to least.
 * Returns a new array — does not mutate the input.
 *
 * @example
 * const ranked = rankByDensity(peerSnapshots)
 * // ranked[0] is the most causally authoritative peer
 */
declare function rankByDensity(snapshots: DensitySnapshot[]): DensitySnapshot[];

/**
 * hll.ts — HyperLogLog cardinality estimator
 *
 * Used by CausalDensityField to estimate distinct peer counts in O(1) space.
 * p=8 → 256 registers → ~1.5% error at large cardinalities.
 *
 * References:
 *   Flajolet & Martin, "Probabilistic Counting" (1985)
 *   Heule et al., "HyperLogLog in Practice" (2013)
 */
/**
 * fnv32 computes FNV-1a 32-bit hash of a string.
 * Used to convert peer IDs into register indices + rho values for HLL.
 * No external dependency — keeps this package zero-dep.
 */
declare function fnv32(s: string): number;
declare class HyperLogLog {
    private readonly registers;
    constructor();
    /** Add a peer ID string to the sketch. O(1). */
    add(peerID: string): void;
    /** Estimate cardinality. O(256). */
    estimate(): number;
    /** Merge another sketch into this one (union). O(256). */
    merge(other: HyperLogLog): void;
    /** Return a deep copy of this sketch. */
    clone(): HyperLogLog;
    /** Serialize registers to a plain array (for JSON transport). */
    toJSON(): number[];
    /** Restore from a serialized register array. */
    static fromJSON(registers: number[]): HyperLogLog;
}

export { CausalDensityField, type CausalDensityFieldOptions, type DensityGradient, DensitySnapshot, type DensitySnapshotData, HyperLogLog, fnv32, gradient, interpolate, normalize, rankByDensity, selectDensest };
