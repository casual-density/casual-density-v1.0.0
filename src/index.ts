/**
 * causal-density
 *
 * Time as density — clock-free causal ordering for distributed systems.
 *
 * Core concept:
 *   Instead of asking "when was this published?" (requires synchronized clocks),
 *   ask "how much of the network had this node witnessed before publishing?"
 *   (answerable locally, without coordination).
 *
 *   ρ = EventCount / (CausalSpan × PeerCardinality)
 *
 * Higher ρ = causally denser = more authoritative.
 * No NTP. No consensus. No clock skew bugs.
 *
 * @example
 * import { CausalDensityField, gradient, normalize } from 'causal-density'
 *
 * const field = new CausalDensityField({ windowMs: 5 * 60_000 })
 *
 * // On every observed network event:
 * field.observe(peerID, causalDepth)
 *
 * // When publishing a record:
 * const snap = await field.snapshot()
 * record.density = snap.toJSON()
 *
 * // When selecting between competing records:
 * const winner = selectDensest([snapA, snapB, snapC])
 *
 * // Gradient analysis:
 * const g = gradient(localSnap, remoteSnap)
 * if (g.isPartitionSuspect) console.warn('possible network partition')
 */

// Core types
export type { DensitySnapshotData } from './snapshot.js'
export { DensitySnapshot } from './snapshot.js'

// Options
export type { CausalDensityFieldOptions } from './field.js'

// Field
export { CausalDensityField } from './field.js'

// Analysis
export type { DensityGradient } from './analysis.js'
export {
  gradient,
  interpolate,
  normalize,
  selectDensest,
  rankByDensity,
} from './analysis.js'

// Low-level utilities (exported for advanced use / testing)
export { HyperLogLog, fnv32 } from './hll.js'
