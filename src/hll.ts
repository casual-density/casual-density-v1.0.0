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

const HLL_PRECISION = 8
const HLL_M = 1 << HLL_PRECISION          // 256 registers
const HLL_ALPHA = 0.7213 / (1 + 1.079 / HLL_M)

// ── FNV-1a 32-bit hash ────────────────────────────────────────────────────────

/**
 * fnv32 computes FNV-1a 32-bit hash of a string.
 * Used to convert peer IDs into register indices + rho values for HLL.
 * No external dependency — keeps this package zero-dep.
 */
export function fnv32(s: string): number {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

// ── HyperLogLog ───────────────────────────────────────────────────────────────

export class HyperLogLog {
  private readonly registers: Uint8Array

  constructor() {
    this.registers = new Uint8Array(HLL_M)
  }

  /** Add a peer ID string to the sketch. O(1). */
  add(peerID: string): void {
    const hash = fnv32(peerID)
    // Top HLL_PRECISION bits → register index
    const idx = hash >>> (32 - HLL_PRECISION)
    // Remaining bits → leading zeros + 1 (rho value)
    const w = (hash << HLL_PRECISION) >>> 0
    const rho = Math.clz32(w) + 1
    if (rho > (this.registers[idx] ?? 0)) {
      this.registers[idx] = rho
    }
  }

  /** Estimate cardinality. O(256). */
  estimate(): number {
    let sum = 0
    let zeros = 0
    for (let i = 0; i < HLL_M; i++) {
      const v = this.registers[i] ?? 0
      sum += Math.pow(2, -v)
      if (v === 0) zeros++
    }

    let est = HLL_ALPHA * HLL_M * HLL_M / sum

    // Small range correction
    if (est <= 2.5 * HLL_M && zeros > 0) {
      est = HLL_M * Math.log(HLL_M / zeros)
    }

    return est
  }

  /** Merge another sketch into this one (union). O(256). */
  merge(other: HyperLogLog): void {
    const otherRegs = other.registers
    for (let i = 0; i < HLL_M; i++) {
      const ov = otherRegs[i] ?? 0
      if (ov > (this.registers[i] ?? 0)) {
        this.registers[i] = ov
      }
    }
  }

  /** Return a deep copy of this sketch. */
  clone(): HyperLogLog {
    const copy = new HyperLogLog()
    copy.registers.set(this.registers)
    return copy
  }

  /** Serialize registers to a plain array (for JSON transport). */
  toJSON(): number[] {
    return Array.from(this.registers)
  }

  /** Restore from a serialized register array. */
  static fromJSON(registers: number[]): HyperLogLog {
    const hll = new HyperLogLog()
    for (let i = 0; i < Math.min(registers.length, HLL_M); i++) {
      hll.registers[i] = registers[i] ?? 0
    }
    return hll
  }
}
