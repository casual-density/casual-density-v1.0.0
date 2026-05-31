/**
 * analysis.ts — density field analysis utilities
 *
 * gradient()     — directional density difference between two snapshots
 * interpolate()  — weighted average across multiple peer snapshots
 * normalize()    — sigmoid mapping to [0, 1] for cross-network comparison
 * selectDensest() — pick the most causally authoritative snapshot from a set
 */

import { DensitySnapshot } from './snapshot.js'

// ── DensityGradient ───────────────────────────────────────────────────────────

/**
 * DensityGradient represents the directional density difference between two
 * causal positions. Analogous to a gradient field in physics — tells you
 * which direction is "causally upstream" (toward higher authority).
 */
export interface DensityGradient {
  /** Signed density difference: a.rho − b.rho */
  readonly delta: number
  /** +1 if a is denser, -1 if b is denser, 0 if equal */
  readonly direction: 1 | -1 | 0
  /** |delta| — strength of the gradient */
  readonly magnitude: number
  /**
   * Estimated difference in peer cardinality between a and b.
   * High PeerDivergence with low magnitude → possible network partition:
   * both nodes are active but observing different peer sets.
   */
  readonly peerDivergence: number
  /**
   * True when the gradient suggests a network partition rather than
   * normal causal ordering.
   *
   * Heuristic: both nodes active (eventCount > 10) AND peer cardinalities
   * diverge by more than 50% of the larger value.
   */
  readonly isPartitionSuspect: boolean
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
export function gradient(a: DensitySnapshot, b: DensitySnapshot): DensityGradient {
  const delta = a.rho - b.rho
  const magnitude = Math.abs(delta)

  const direction: 1 | -1 | 0 =
    delta > 1e-9 ? 1 : delta < -1e-9 ? -1 : 0

  const peerDivergence = Math.abs(a.peerCardinality - b.peerCardinality)

  const bothActive = a.eventCount > 10 && b.eventCount > 10
  const maxCard = Math.max(a.peerCardinality, b.peerCardinality)
  const isPartitionSuspect = bothActive && maxCard > 0 &&
    peerDivergence > 0.5 * maxCard

  return { delta, direction, magnitude, peerDivergence, isPartitionSuspect }
}

// ── Interpolation ─────────────────────────────────────────────────────────────

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
export async function interpolate(snapshots: DensitySnapshot[]): Promise<DensitySnapshot> {
  if (snapshots.length === 0) return DensitySnapshot.ZERO
  if (snapshots.length === 1) {
    const s = snapshots[0]
    return s !== undefined ? s : DensitySnapshot.ZERO
  }

  let totalWeight = 0
  let weightedRho = 0
  let maxCount = 0
  let maxSpan = 0
  let maxCard = 0

  for (const s of snapshots) {
    if (!s.isValid) continue
    const w = s.eventCount
    totalWeight += w
    weightedRho += s.rho * w
    if (s.eventCount > maxCount) maxCount = s.eventCount
    if (s.causalSpan > maxSpan) maxSpan = s.causalSpan
    if (s.peerCardinality > maxCard) maxCard = s.peerCardinality
  }

  if (totalWeight === 0) return DensitySnapshot.ZERO

  const { buildSnapshot } = await import('./snapshot.js')
  // Reconstruct span from maxSpan (conservative — uses widest observed span)
  return buildSnapshot(maxCount, 0, maxSpan, maxCard)
}

// ── Normalization ─────────────────────────────────────────────────────────────

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
export function normalize(rho: number, baseline = 1.0): number {
  const b = baseline > 0 ? baseline : 1.0
  // Sigmoid centered at baseline, ±2× baseline → ~0.12 / 0.88
  const x = (rho - b) / (b * 0.5)
  return 1 / (1 + Math.exp(-x))
}

// ── Selection ─────────────────────────────────────────────────────────────────

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
export function selectDensest(snapshots: DensitySnapshot[]): DensitySnapshot | null {
  if (snapshots.length === 0) return null

  let best = snapshots[0]
  if (best === undefined) return null

  for (let i = 1; i < snapshots.length; i++) {
    const s = snapshots[i]
    if (s !== undefined && s.compareTo(best) > 0) {
      best = s
    }
  }

  return best
}

/**
 * Sort snapshots from densest (most authoritative) to least.
 * Returns a new array — does not mutate the input.
 *
 * @example
 * const ranked = rankByDensity(peerSnapshots)
 * // ranked[0] is the most causally authoritative peer
 */
export function rankByDensity(snapshots: DensitySnapshot[]): DensitySnapshot[] {
  return [...snapshots].sort((a, b) => b.compareTo(a))
}
