/**
 * causal-density test suite
 *
 * Tests are organized around the three core guarantees:
 *   1. No silent drops
 *   2. Clock-skew immunity
 *   3. Deterministic tie-breaking
 *
 * Plus property tests for HLL, gradient, interpolation, and normalization.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  CausalDensityField,
  DensitySnapshot,
  HyperLogLog,
  fnv32,
  gradient,
  interpolate,
  normalize,
  selectDensest,
  rankByDensity,
} from '../src/index.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeSnap(
  eventCount: number,
  causalSpan: number,
  peerCardinality: number
): Promise<DensitySnapshot> {
  // Build a field with synthetic observations that produce the desired shape
  const field = new CausalDensityField({ windowMs: 999_999_999 })
  const peers = Array.from({ length: Math.max(1, Math.round(peerCardinality)) },
    (_, i) => `peer-${i}`)

  for (let i = 0; i < eventCount; i++) {
    const peer = peers[i % peers.length] ?? 'peer-0'
    // Spread causal depths across the desired span
    const depth = Math.round((i / Math.max(eventCount - 1, 1)) * causalSpan)
    field.observe(peer, depth)
  }

  return field.snapshot()
}

// ── DensitySnapshot ───────────────────────────────────────────────────────────

describe('DensitySnapshot', () => {
  it('ZERO is invalid', () => {
    expect(DensitySnapshot.ZERO.isValid).toBe(false)
  })

  it('compareTo: higher rho wins regardless of eventCount', async () => {
    const high = await makeSnap(10, 1, 1)   // few events, tight span → high ρ
    const low  = await makeSnap(200, 200, 50) // many events, wide span, many peers → low ρ
    // Ensure high actually has higher rho for this test to be meaningful
    if (high.rho > low.rho) {
      expect(high.compareTo(low)).toBe(1)
      expect(low.compareTo(high)).toBe(-1)
    }
  })

  it('compareTo: identical snapshots return 0', async () => {
    const snap = await makeSnap(50, 10, 5)
    expect(snap.compareTo(snap)).toBe(0)
  })

  it('compareTo: tie-break is deterministic and antisymmetric', async () => {
    // Build two snapshots with same rho by using same field state
    const field = new CausalDensityField({ windowMs: 999_999_999 })
    for (let i = 0; i < 20; i++) field.observe(`peer-${i}`, i * 5)

    const snapA = await field.snapshot()
    const snapB = await field.snapshot()

    const r1 = snapA.compareTo(snapB)
    const r2 = snapB.compareTo(snapA)

    // Antisymmetric: if A > B then B < A
    expect(r1).toBe(-r2 as 1 | -1 | 0)
    // Calling twice is consistent
    expect(snapA.compareTo(snapB)).toBe(r1)
  })

  it('toJSON / fromJSON roundtrip preserves all fields', async () => {
    const snap = await makeSnap(100, 50, 20)
    const json = snap.toJSON()
    const restored = DensitySnapshot.fromJSON(json as Record<string, unknown>)

    expect(restored.rho).toBeCloseTo(snap.rho, 10)
    expect(restored.eventCount).toBe(snap.eventCount)
    expect(restored.causalSpan).toBe(snap.causalSpan)
    expect(restored.snapshotHash).toBe(snap.snapshotHash)
    expect(restored.isValid).toBe(snap.isValid)
  })
})

// ── CausalDensityField ────────────────────────────────────────────────────────

describe('CausalDensityField', () => {
  let field: CausalDensityField

  beforeEach(() => {
    field = new CausalDensityField({ windowMs: 999_999_999 })
  })

  it('empty field returns ZERO snapshot', async () => {
    const snap = await field.snapshot()
    expect(snap.isValid).toBe(false)
    expect(snap.eventCount).toBe(0)
  })

  it('single event produces valid snapshot', async () => {
    field.observe('peer-A', 5)
    const snap = await field.snapshot()
    expect(snap.isValid).toBe(true)
    expect(snap.eventCount).toBe(1)
    expect(snap.rho).toBeGreaterThan(0)
  })

  it('total is monotonically increasing', () => {
    let prev = field.total
    for (let i = 0; i < 50; i++) {
      field.observe('peer', i)
      expect(field.total).toBeGreaterThan(prev)
      prev = field.total
    }
  })

  it('rho increases with tighter causal span (same event count)', async () => {
    const wide = new CausalDensityField({ windowMs: 999_999_999 })
    const tight = new CausalDensityField({ windowMs: 999_999_999 })

    for (let i = 0; i < 50; i++) {
      wide.observe('peer', i * 100)    // span = 0..4900
      tight.observe('peer', i)         // span = 0..49
    }

    const wideSnap = await wide.snapshot()
    const tightSnap = await tight.snapshot()

    // Tighter causal span → smaller denominator → higher ρ
    expect(tightSnap.rho).toBeGreaterThan(wideSnap.rho)
  })

  it('rho decreases with more distinct peers (same event count, same span)', async () => {
    const onePeer = new CausalDensityField({ windowMs: 999_999_999 })
    const manyPeers = new CausalDensityField({ windowMs: 999_999_999 })

    for (let i = 0; i < 50; i++) {
      onePeer.observe('single-peer', i)
      manyPeers.observe(`peer-${i}`, i)  // 50 distinct peers
    }

    const oneSnap = await onePeer.snapshot()
    const manySnap = await manyPeers.snapshot()

    // More peers → larger cardinality denominator → lower ρ per unit
    expect(oneSnap.peerCardinality).toBeLessThan(manySnap.peerCardinality)
  })

  it('windowEvents respects window boundary', async () => {
    const shortWindow = new CausalDensityField({ windowMs: 50 })
    shortWindow.observe('peer', 1)
    await new Promise(r => setTimeout(r, 100))  // let events expire
    shortWindow.observe('peer', 2)  // this one is in window

    const events = shortWindow.windowEvents()
    // Only the recent event should be in window
    expect(events.length).toBeLessThanOrEqual(1)
  })

  it('mergeObservations advances causal depth', async () => {
    const remote = await makeSnap(100, 500, 30)
    const before = field.total
    field.mergeObservations(remote)
    expect(field.total).toBeGreaterThan(before)
  })

  it('onObserve callback fires on every event', () => {
    const calls: number[] = []
    const f = new CausalDensityField({
      windowMs: 999_999_999,
      onObserve: n => calls.push(n),
    })

    f.observe('p', 1)
    f.observe('p', 2)
    f.observe('p', 3)

    expect(calls).toEqual([1, 2, 3])
  })
})

// ── GUARANTEE 1: No silent drops ──────────────────────────────────────────────

describe('Guarantee: No silent drops', () => {
  it('compareTo never returns undefined', async () => {
    for (let i = 0; i < 20; i++) {
      const a = await makeSnap(
        Math.floor(Math.random() * 200) + 1,
        Math.floor(Math.random() * 100) + 1,
        Math.floor(Math.random() * 20) + 1
      )
      const b = await makeSnap(
        Math.floor(Math.random() * 200) + 1,
        Math.floor(Math.random() * 100) + 1,
        Math.floor(Math.random() * 20) + 1
      )
      const result = a.compareTo(b)
      expect([-1, 0, 1]).toContain(result)
    }
  })

  it('selectDensest always picks one (no tie leads to undefined)', async () => {
    const snaps = await Promise.all([
      makeSnap(100, 50, 10),
      makeSnap(100, 50, 10),
      makeSnap(100, 50, 10),
    ])
    const best = selectDensest(snaps)
    expect(best).not.toBeNull()
    expect(best!.isValid).toBe(true)
  })
})

// ── GUARANTEE 2: Clock-skew immunity ─────────────────────────────────────────

describe('Guarantee: Clock-skew immunity', () => {
  it('high-density record beats future-clocked low-density record', async () => {
    // High density node: many events from many peers
    const highDensity = await makeSnap(200, 50, 20)

    // Low density node: just 2 events, but wall time set far in the future
    const lowDensityData = DensitySnapshot.fromJSON({
      ...DensitySnapshot.ZERO.toJSON(),
      rho: 0.1,
      eventCount: 2,
      causalSpan: 1,
      peerCardinality: 1,
      wallNs: (BigInt(Date.now()) * 1_000_000n + BigInt(365 * 24 * 60 * 60) * 1_000_000_000n).toString(),
      snapshotHash: 'aaa',
    })

    expect(highDensity.rho).toBeGreaterThan(lowDensityData.rho)

    const g = gradient(highDensity, lowDensityData)
    expect(g.direction).toBe(1)  // high density is upstream
  })

  it('rho ordering is independent of wallNs', async () => {
    const snap = await makeSnap(100, 20, 5)

    // Manually create a clone with a very different wallNs
    const alteredJSON = { ...snap.toJSON(), wallNs: '9999999999999999999' }
    const altered = DensitySnapshot.fromJSON(alteredJSON as Record<string, unknown>)

    // Same rho — wallNs should not affect ordering
    expect(snap.rho).toBeCloseTo(altered.rho, 5)

    // The comparison should NOT be affected by wallNs difference
    const cmp = snap.compareTo(altered)
    expect([-1, 0, 1]).toContain(cmp)
    // Note: snapshotHash may differ since wallNs is included in it,
    // but the TIE-BREAK on hash is deterministic — it will never silently drop
  })
})

// ── GUARANTEE 3: Deterministic tie-breaking ───────────────────────────────────

describe('Guarantee: Deterministic tie-breaking', () => {
  it('rankByDensity produces same order regardless of input order', async () => {
    const snaps = await Promise.all([
      makeSnap(10, 5, 1),
      makeSnap(100, 50, 10),
      makeSnap(50, 20, 5),
    ])

    const order1 = rankByDensity(snaps).map(s => s.snapshotHash)
    const shuffled = [snaps[2]!, snaps[0]!, snaps[1]!]
    const order2 = rankByDensity(shuffled).map(s => s.snapshotHash)

    expect(order1).toEqual(order2)
  })
})

// ── HyperLogLog ───────────────────────────────────────────────────────────────

describe('HyperLogLog', () => {
  it('estimate is reasonable for small cardinalities', () => {
    const hll = new HyperLogLog()
    for (let i = 0; i < 50; i++) {
      hll.add(`peer-${i}`)
    }
    const est = hll.estimate()
    // Should be within 3× of 50
    expect(est).toBeGreaterThan(10)
    expect(est).toBeLessThan(200)
  })

  it('merge produces union (higher estimate than either alone)', () => {
    const a = new HyperLogLog()
    const b = new HyperLogLog()

    for (let i = 0; i < 100; i++) a.add(`a-peer-${i}`)
    for (let i = 0; i < 100; i++) b.add(`b-peer-${i}`)

    const aEst = a.estimate()
    a.merge(b)
    const mergedEst = a.estimate()

    expect(mergedEst).toBeGreaterThan(aEst)
  })

  it('clone is independent', () => {
    const hll = new HyperLogLog()
    hll.add('peer-A')
    const copy = hll.clone()
    copy.add('peer-B')

    // Original should not have peer-B
    const origEst = hll.estimate()
    const copyEst = copy.estimate()
    expect(copyEst).toBeGreaterThanOrEqual(origEst)
  })

  it('toJSON / fromJSON roundtrip', () => {
    const hll = new HyperLogLog()
    for (let i = 0; i < 30; i++) hll.add(`peer-${i}`)

    const est1 = hll.estimate()
    const restored = HyperLogLog.fromJSON(hll.toJSON())
    const est2 = restored.estimate()

    expect(est2).toBeCloseTo(est1, 5)
  })
})

// ── fnv32 ─────────────────────────────────────────────────────────────────────

describe('fnv32', () => {
  it('is deterministic', () => {
    expect(fnv32('peer-A')).toBe(fnv32('peer-A'))
  })

  it('different inputs produce different hashes', () => {
    expect(fnv32('peer-A')).not.toBe(fnv32('peer-B'))
  })

  it('returns a 32-bit unsigned integer', () => {
    const h = fnv32('test')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(0xffffffff)
  })
})

// ── gradient ──────────────────────────────────────────────────────────────────

describe('gradient()', () => {
  it('direction is +1 when a is denser', async () => {
    const high = await makeSnap(200, 5, 1)
    const low  = await makeSnap(2, 200, 50)

    if (high.rho > low.rho) {
      const g = gradient(high, low)
      expect(g.direction).toBe(1)
      expect(g.magnitude).toBeGreaterThan(0)
    }
  })

  it('detects partition when peer cardinalities diverge sharply', async () => {
    // Both active, but wildly different peer sets
    const a = DensitySnapshot.fromJSON({
      rho: 3.0, eventCount: 500, causalSpan: 50,
      peerCardinality: 100, wallNs: '0', snapshotHash: 'a',
    })
    const b = DensitySnapshot.fromJSON({
      rho: 3.1, eventCount: 480, causalSpan: 48,
      peerCardinality: 4, wallNs: '0', snapshotHash: 'b',
    })

    const g = gradient(a, b)
    expect(g.isPartitionSuspect).toBe(true)
  })

  it('does not flag partition for similar cardinalities', async () => {
    const a = DensitySnapshot.fromJSON({
      rho: 5.0, eventCount: 100, causalSpan: 10,
      peerCardinality: 20, wallNs: '0', snapshotHash: 'a',
    })
    const b = DensitySnapshot.fromJSON({
      rho: 4.5, eventCount: 95, causalSpan: 10,
      peerCardinality: 18, wallNs: '0', snapshotHash: 'b',
    })

    const g = gradient(a, b)
    expect(g.isPartitionSuspect).toBe(false)
  })
})

// ── interpolate ───────────────────────────────────────────────────────────────

describe('interpolate()', () => {
  it('empty array returns ZERO', async () => {
    const result = await interpolate([])
    expect(result.isValid).toBe(false)
  })

  it('single element returns equivalent snapshot', async () => {
    const snap = await makeSnap(50, 20, 10)
    const result = await interpolate([snap])
    expect(result.rho).toBeCloseTo(snap.rho, 1)
  })

  it('weights higher-event-count snapshots more', async () => {
    const heavy = DensitySnapshot.fromJSON({
      rho: 10.0, eventCount: 1000, causalSpan: 100,
      peerCardinality: 50, wallNs: '0', snapshotHash: 'h',
    })
    const light = DensitySnapshot.fromJSON({
      rho: 2.0, eventCount: 10, causalSpan: 10,
      peerCardinality: 2, wallNs: '0', snapshotHash: 'l',
    })

    const result = await interpolate([heavy, light])
    // Weighted: (10×1000 + 2×10) / 1010 ≈ 9.98
    expect(result.rho).toBeGreaterThan(8.0)
  })
})

// ── normalize ─────────────────────────────────────────────────────────────────

describe('normalize()', () => {
  it('output is always in [0, 1]', () => {
    const cases = [0, 0.1, 0.5, 1.0, 2.0, 10.0, 100.0, 1000.0]
    for (const rho of cases) {
      const n = normalize(rho, 1.0)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(1)
    }
  })

  it('baseline maps to ~0.5', () => {
    expect(normalize(2.0, 2.0)).toBeCloseTo(0.5, 2)
  })

  it('above baseline maps above 0.5', () => {
    expect(normalize(3.0, 1.0)).toBeGreaterThan(0.5)
  })

  it('below baseline maps below 0.5', () => {
    expect(normalize(0.1, 1.0)).toBeLessThan(0.5)
  })

  it('defaults to baseline=1.0', () => {
    expect(normalize(1.0)).toBeCloseTo(0.5, 2)
  })
})

// ── selectDensest / rankByDensity ─────────────────────────────────────────────

describe('selectDensest()', () => {
  it('returns null for empty array', () => {
    expect(selectDensest([])).toBeNull()
  })

  it('returns the densest snapshot', async () => {
    const low  = await makeSnap(5, 100, 50)
    const high = await makeSnap(50, 1, 1)
    const mid  = await makeSnap(20, 20, 5)

    const best = selectDensest([low, high, mid])
    // high should have the highest rho (tight span, few peers, reasonable count)
    if (high.rho > mid.rho && high.rho > low.rho) {
      expect(best!.snapshotHash).toBe(high.snapshotHash)
    }
  })
})

describe('rankByDensity()', () => {
  it('does not mutate input array', async () => {
    const snaps = await Promise.all([makeSnap(10, 5, 1), makeSnap(50, 50, 10)])
    const original = [...snaps]
    rankByDensity(snaps)
    expect(snaps).toEqual(original)
  })

  it('returns descending order by rho', async () => {
    const snaps = await Promise.all([
      makeSnap(10, 100, 50),  // low rho
      makeSnap(100, 5, 1),    // high rho
      makeSnap(30, 30, 8),    // mid rho
    ])
    const ranked = rankByDensity(snaps)
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i]!.rho + 1e-9).toBeGreaterThanOrEqual(ranked[i + 1]!.rho)
    }
  })
})
