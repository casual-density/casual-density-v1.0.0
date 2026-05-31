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

// ── Snapshot hash (Web Crypto / Node crypto) ──────────────────────────────────

/**
 * Compute SHA-256 of the snapshot's numeric fields.
 * Binds the density values — prevents inflation attacks.
 * Works in browser (SubtleCrypto) and Node 18+ (globalThis.crypto).
 */
async function computeSnapshotHash(
  rho: number,
  eventCount: number,
  causalSpan: number,
  wallNs: bigint
): Promise<string> {
  const buf = new ArrayBuffer(24)
  const view = new DataView(buf)

  // rho as IEEE 754 double, little-endian
  view.setFloat64(0, rho, true)
  // eventCount uint32 LE
  view.setUint32(8, eventCount, true)
  // causalSpan uint32 LE
  view.setUint32(12, causalSpan, true)
  // wallNs as two uint32s (BigInt64 not universally available in DataView)
  view.setUint32(16, Number(wallNs & 0xffffffffn), true)
  view.setUint32(20, Number((wallNs >> 32n) & 0xffffffffn), true)

  const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── DensitySnapshot ───────────────────────────────────────────────────────────

export interface DensitySnapshotData {
  /** ρ = EventCount / (CausalSpan × PeerCardinality) */
  readonly rho: number
  /** Raw event count in measurement window */
  readonly eventCount: number
  /** max(causalDepth) − min(causalDepth) in window */
  readonly causalSpan: number
  /** HLL-estimated distinct contributing peers */
  readonly peerCardinality: number
  /** Wall clock at snapshot time (fallback / audit only — NOT used for ordering) */
  readonly wallNs: bigint
  /** SHA-256 binding rho||eventCount||causalSpan||wallNs */
  readonly snapshotHash: string
}

/**
 * DensitySnapshot is an immutable causal density stamp.
 *
 * Create via `CausalDensityField.snapshot()` — do not construct directly
 * unless deserializing from JSON.
 */
export class DensitySnapshot implements DensitySnapshotData {
  readonly rho: number
  readonly eventCount: number
  readonly causalSpan: number
  readonly peerCardinality: number
  readonly wallNs: bigint
  readonly snapshotHash: string

  constructor(data: DensitySnapshotData) {
    this.rho = data.rho
    this.eventCount = data.eventCount
    this.causalSpan = data.causalSpan
    this.peerCardinality = data.peerCardinality
    this.wallNs = data.wallNs
    this.snapshotHash = data.snapshotHash
  }

  /** Returns true if this snapshot carries real density data (not a zero value). */
  get isValid(): boolean {
    return this.eventCount > 0 && this.snapshotHash !== ''
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
  compareTo(other: DensitySnapshot): 1 | -1 | 0 {
    const EPS = 1e-9

    // Rule 1: density scalar
    if (this.rho > other.rho + EPS) return 1
    if (other.rho > this.rho + EPS) return -1

    // Rule 2: raw event count (confidence)
    if (this.eventCount > other.eventCount) return 1
    if (other.eventCount > this.eventCount) return -1

    // Rule 3: deterministic hash tie-break
    if (this.snapshotHash > other.snapshotHash) return 1
    if (other.snapshotHash > this.snapshotHash) return -1

    return 0
  }

  /** Serialize to plain object for JSON transport. */
  toJSON(): Record<string, unknown> {
    return {
      rho: this.rho,
      eventCount: this.eventCount,
      causalSpan: this.causalSpan,
      peerCardinality: this.peerCardinality,
      wallNs: this.wallNs.toString(),
      snapshotHash: this.snapshotHash,
    }
  }

  /** Deserialize from JSON. */
  static fromJSON(obj: Record<string, unknown>): DensitySnapshot {
    return new DensitySnapshot({
      rho: Number(obj['rho']),
      eventCount: Number(obj['eventCount']),
      causalSpan: Number(obj['causalSpan']),
      peerCardinality: Number(obj['peerCardinality']),
      wallNs: BigInt(String(obj['wallNs'])),
      snapshotHash: String(obj['snapshotHash']),
    })
  }

  /** Zero-value snapshot (represents a node with no observations). */
  static readonly ZERO: DensitySnapshot = new DensitySnapshot({
    rho: 0,
    eventCount: 0,
    causalSpan: 0,
    peerCardinality: 0,
    wallNs: 0n,
    snapshotHash: '',
  })
}

// ── Factory ───────────────────────────────────────────────────────────────────

const MIN_CAUSAL_SPAN = 1.0
const MIN_PEER_CARDINALITY = 1.0

/**
 * Build a DensitySnapshot from raw measurements.
 * Async because it computes a SHA-256 hash.
 * Called internally by CausalDensityField.snapshot().
 */
export async function buildSnapshot(
  eventCount: number,
  minDepth: number,
  maxDepth: number,
  peerCardinalityEstimate: number
): Promise<DensitySnapshot> {
  if (eventCount === 0) return DensitySnapshot.ZERO

  const causalSpan = Math.max(maxDepth - minDepth, MIN_CAUSAL_SPAN)
  const peerCardinality = Math.max(peerCardinalityEstimate, MIN_PEER_CARDINALITY)
  const rho = eventCount / (causalSpan * peerCardinality)
  const wallNs = BigInt(Date.now()) * 1_000_000n

  const snapshotHash = await computeSnapshotHash(rho, eventCount, causalSpan, wallNs)

  return new DensitySnapshot({
    rho,
    eventCount,
    causalSpan,
    peerCardinality,
    wallNs,
    snapshotHash,
  })
}
