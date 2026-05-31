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

import { HyperLogLog } from './hll.js'
import { DensitySnapshot, buildSnapshot } from './snapshot.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const RING_SIZE = 256   // must be power of 2
const RING_MASK = RING_SIZE - 1
const DEFAULT_WINDOW_MS = 5 * 60_000  // 5 minutes

// ── DensityEvent ──────────────────────────────────────────────────────────────

interface DensityEvent {
  wallMs: number    // wall clock of observation (window expiry)
  causalDepth: number  // VSE parent_ids chain length — position in causal graph
  peerID: string    // contributing peer ID (fed into HLL)
}

// ── CausalDensityFieldOptions ─────────────────────────────────────────────────

export interface CausalDensityFieldOptions {
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
  windowMs?: number

  /**
   * Called after every observe() call with the current total event count.
   * Use for Prometheus counters or debug logging.
   */
  onObserve?: (totalEvents: number) => void
}

// ── CausalDensityField ────────────────────────────────────────────────────────

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
export class CausalDensityField {
  private readonly ring: (DensityEvent | null)[]
  private head = 0
  private totalEvents = 0
  private readonly windowMs: number
  private readonly onObserve: ((n: number) => void) | undefined

  // Full HLL sketch — updated on every observe()
  // Rebuilt over the window on snapshot() to exclude expired events
  private sketch = new HyperLogLog()

  constructor(options: CausalDensityFieldOptions = {}) {
    this.ring = new Array<DensityEvent | null>(RING_SIZE).fill(null)
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.onObserve = options.onObserve
  }

  /**
   * Record a new DHT/network event from a peer.
   *
   * @param peerID      - peer identifier string (peer.ID, node address, etc.)
   * @param causalDepth - VSE parent_ids chain length. Pass 0 if unknown.
   *                      Higher = deeper in the causal graph = more history.
   */
  observe(peerID: string, causalDepth: number): void {
    const evt: DensityEvent = {
      wallMs: Date.now(),
      causalDepth,
      peerID,
    }

    this.ring[this.head & RING_MASK] = evt
    this.head = (this.head + 1) & 0x7fffffff  // prevent overflow
    this.totalEvents++
    this.sketch.add(peerID)

    this.onObserve?.(this.totalEvents)
  }

  /**
   * Compute and return the current density snapshot.
   * Async because it computes a SHA-256 hash for tamper-proofing.
   * O(256) — safe to call frequently.
   *
   * @returns DensitySnapshot — immutable, JSON-serializable, embeddable
   */
  async snapshot(): Promise<DensitySnapshot> {
    const now = Date.now()
    const cutoff = now - this.windowMs

    let eventCount = 0
    let minDepth = Infinity
    let maxDepth = -Infinity
    const windowSketch = new HyperLogLog()

    // Scan ring — collect events within the window
    for (let i = 0; i < RING_SIZE; i++) {
      const evt = this.ring[i]
      if (!evt) continue
      if (evt.wallMs < cutoff) continue

      eventCount++
      if (evt.causalDepth < minDepth) minDepth = evt.causalDepth
      if (evt.causalDepth > maxDepth) maxDepth = evt.causalDepth
      windowSketch.add(evt.peerID)
    }

    if (eventCount === 0) return DensitySnapshot.ZERO

    return buildSnapshot(
      eventCount,
      minDepth,
      maxDepth,
      windowSketch.estimate()
    )
  }

  /**
   * Advance this field's causal depth tracking from a remote snapshot.
   * Call when receiving a DensitySnapshot from a peer.
   *
   * This is the density equivalent of HLC's "receive" step:
   * learning from a peer that has observed more causally deep events
   * advances our own position in the causal graph.
   */
  mergeObservations(remote: DensitySnapshot): void {
    if (!remote.isValid) return
    // Observe a synthetic event at the remote's causal span depth
    // to advance our causal depth tracking
    this.observe('__remote__', remote.causalSpan)
  }

  /** Total events ever observed (monotonic counter). */
  get total(): number {
    return this.totalEvents
  }

  /** Current window duration in milliseconds. */
  get windowDuration(): number {
    return this.windowMs
  }

  /**
   * Peek at events in the current window without computing density.
   * Useful for debugging / visualization.
   */
  windowEvents(): DensityEvent[] {
    const now = Date.now()
    const cutoff = now - this.windowMs
    const result: DensityEvent[] = []
    for (let i = 0; i < RING_SIZE; i++) {
      const evt = this.ring[i]
      if (!evt) continue
      if (evt.wallMs < cutoff) continue
      
      result.push({
        wallMs: evt.wallMs,
        causalDepth: evt.causalDepth,
        peerID: evt.peerID
      })
    }
    return result
  }
}
