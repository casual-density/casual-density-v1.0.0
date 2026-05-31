# causal-density

**Time as density — clock-free causal ordering for distributed systems.**

A TypeScript library for measuring event density in distributed systems without requiring synchronized clocks. Ideal for DHT records, CRDTs, event-sourced systems, and VSE (Vector State Evolution) reducer algebras.

## Overview

Instead of asking "when was this published?" (which requires NTP and exposes clock-skew bugs), ask:

> **How much of the network had this node witnessed before publishing?**

This can be answered locally without coordination. The answer is **causal density (ρ)**:

```
ρ = EventCount / (CausalSpan × PeerCardinality)
```

- **EventCount** — events in a sliding time window
- **CausalSpan** — `max(depth) - min(depth)` in causal graph (NOT wall time)
- **PeerCardinality** — HyperLogLog estimate of distinct contributing peers

Higher ρ means causally denser records, making them more authoritative candidates for conflict resolution.

## Features

- ✅ **Clock-free** — No NTP, no synchronized clocks, no clock-skew bugs
- ✅ **Local computation** — No consensus or coordination required
- ✅ **Fixed memory** — Ring buffer (256 slots) prevents unbounded growth
- ✅ **Distributed** — Merge observations from remote snapshots for causal advancement
- ✅ **Production-ready** — TypeScript strict mode, comprehensive tests, source maps
- ✅ **Zero dependencies** — Ships with embedded HyperLogLog implementation

## Installation

```bash
npm install causal-density
```

## Quick Start

```typescript
import { CausalDensityField, selectDensest } from 'causal-density'

// Create a field with a 5-minute window
const field = new CausalDensityField({ windowMs: 5 * 60_000 })

// On every observed network event
field.observe('peer-QmAbc...', 42)  // peerID, causalDepth

// When publishing a record
const snap = await field.snapshot()
record.density = snap.toJSON()

// When selecting between competing records
const records = [recordA, recordB, recordC]
const densestSnapshots = records.map(r => DensitySnapshot.fromJSON(r.density))
const winner = selectDensest(densestSnapshots)
```

## API Reference

### `CausalDensityField`

Core class that maintains causal density measurements.

```typescript
const field = new CausalDensityField({
  windowMs: 5 * 60_000,           // sliding window duration (default: 5 min)
  onObserve: (total) => {          // optional callback after each observe()
    prometheus.counter('events_total', total)
  }
})

// Record a network event from a peer
field.observe(peerID: string, causalDepth: number): void

// Get the current density measurement
const snap = await field.snapshot(): Promise<DensitySnapshot>

// Merge remote observations to advance causal depth tracking
field.mergeObservations(remote: DensitySnapshot): void

// Peek at events in the current window
const events = field.windowEvents(): DensityEvent[]

// Access field metadata
field.total       // total events ever observed (monotonic)
field.windowDuration  // current window in milliseconds
```

### `DensitySnapshot`

Immutable, JSON-serializable measurement at a point in time.

```typescript
// Create from field
const snap = await field.snapshot()

// Inspect
snap.eventCount        // events in the window
snap.causalSpan        // max depth - min depth
snap.peerCardinality   // estimated distinct peers (HLL)
snap.density           // ρ = eventCount / (span × cardinality)
snap.isValid           // false if snap is empty or invalid
snap.timestamp         // when snapshot was created (ms)

// Serialize / deserialize
const json = snap.toJSON()
const snap2 = DensitySnapshot.fromJSON(json)

// Compare two snapshots
const diff = snap1.compare(snap2)
```

### Analysis Functions

```typescript
import {
  gradient,
  interpolate,
  normalize,
  selectDensest,
  rankByDensity,
  DensityGradient
} from 'causal-density'

// Analyze difference between two snapshots
const g: DensityGradient = gradient(localSnap, remoteSnap)
g.densityDelta          // remote.density - local.density
g.eventCountDelta       // remote.eventCount - local.eventCount
g.isPartitionSuspect    // heuristic: might indicate network partition
g.direction             // 'ahead' | 'behind' | 'equal' | 'invalid'

// Normalize density to [0, 1] using reference densities
const normalized = normalize(snap, minDensity, maxDensity)

// Interpolate between two snapshots
const mid = interpolate(snapA, snapB, 0.5)  // 50% between A and B

// Select the single densest snapshot
const winner = selectDensest([snap1, snap2, snap3])

// Rank all snapshots by density (descending)
const ranked = rankByDensity([snap1, snap2, snap3, snap4])
```

## Advanced Usage

### Tuning the Window

The window duration should match your system's event rate:

```typescript
// High-throughput DHT / mesh network
const field = new CausalDensityField({ windowMs: 1 * 60_000 })  // 1 minute

// Low-traffic IoT / edge nodes
const field = new CausalDensityField({ windowMs: 30 * 60_000 })  // 30 minutes

// Unit tests / controlled experiments
const field = new CausalDensityField({ windowMs: 1_000 })  // 1 second
```

### Merging Remote Observations

When you receive a snapshot from a peer, merge it to advance your own causal depth:

```typescript
// Receive snapshot from peer
const remotePeer = await fetchPeerSnapshot(peerId)

// Advance this field's causal understanding
field.mergeObservations(remotePeer)

// Now your own snapshots may have higher density
const mySnap = await field.snapshot()
console.log(mySnap.density)  // potentially increased
```

### Integration with Event Sourcing

```typescript
// When publishing an event-sourced record
async function publishEvent(event: any) {
  const density = await densityField.snapshot()
  
  const record = {
    id: crypto.randomUUID(),
    event,
    density: density.toJSON(),
    timestamp: Date.now()
  }
  
  await dht.put(record.id, record)
}

// When selecting between conflicting records
function selectAuthoritative(records: Record[]) {
  const snapshots = records.map(r =>
    DensitySnapshot.fromJSON(r.density)
  )
  return records[rankByDensity(snapshots)[0]]
}
```

### Partition Detection

Use gradient analysis to detect potential network partitions:

```typescript
const localSnap = await field.snapshot()
const remoteSnap = DensitySnapshot.fromJSON(peerData.density)

const g = gradient(localSnap, remoteSnap)

if (g.isPartitionSuspect) {
  console.warn('⚠️  Possible network partition detected')
  console.log(`  Local density: ${g.direction}`)
  console.log(`  Delta: ${g.densityDelta.toFixed(6)}`)
  // Optionally: adjust quorum size, slow down publishing, etc.
}
```

## How It Works

### The Density Formula

```
ρ = EventCount / (CausalSpan × PeerCardinality)

Where:
  EventCount      = number of events observed in [now - windowMs, now]
  CausalSpan      = max(depth) - min(depth) for events in the window
  PeerCardinality = HyperLogLog estimate of distinct peers contributing to window
```

### Why It Works

1. **No clock dependency** — Causal depth is a property of the event graph, not wall time.
2. **Local computation** — Everything is computed from your local observations.
3. **Mergeable** — Remote snapshots inform your own causal advancement without agreement.
4. **Fair comparison** — Competing records are ranked by how densely observed they are, not by luck of clock skew.

### HyperLogLog Cardinality

This library uses HyperLogLog for efficient peer cardinality estimation:
- Space: O(1) — always ~2 KB per field
- Time: O(1) per insertion
- Error: ~2% standard error (tunable)

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm test:watch

# Type checking
npm run typecheck
```

## Building

```bash
# Build ESM + CJS + TypeScript declarations
npm run build

# Output in ./dist/
```

## Performance

- **Field creation**: ~1 µs
- **observe()**: ~10 µs (HyperLogLog insert + ring write)
- **snapshot()**: ~100 µs (scan 256 ring slots + HLL rebuild)
- **Memory**: ~16 KB per field (256 × 64 bytes + HLL sketch)

## Examples

### CRDT Vector Clock Alternative

```typescript
// Instead of Lamport/Vector clocks, use density for conflict resolution
const densityField = new CausalDensityField()

// Replica A publishes
await densityField.observe('replicaA', depthA)
const snapA = await densityField.snapshot()
const recordA = { value: 'foo', density: snapA.toJSON() }

// Replica B publishes
await densityField.observe('replicaB', depthB)
const snapB = await densityField.snapshot()
const recordB = { value: 'bar', density: snapB.toJSON() }

// Resolve conflict: pick the causally denser record
const winner = selectDensest([
  DensitySnapshot.fromJSON(recordA.density),
  DensitySnapshot.fromJSON(recordB.density)
])
```

### DHT Record Prioritization

```typescript
// When querying DHT for a record, prioritize responses by causal density
async function getRecord(key: string) {
  const responses = await dht.query(key)  // multiple replicas
  
  const ranked = rankByDensity(
    responses.map(r => DensitySnapshot.fromJSON(r.density))
  )
  
  return responses[ranked[0]]  // most authoritative response
}
```

## License

MIT

## Author

James Chapman <xhecarpenxer@gmail.com>

## References

- **HyperLogLog** — Flajolet et al., "HyperLogLog: the analysis of a near-optimal cardinality estimation algorithm"
- **Causal Ordering** — Lamport, "Time, Clocks, and the Ordering of Events in a Distributed System"
- **VSE** — Vector State Evolution; reducer algebra for conflict-free replicated data
- **CRDT** — Conflict-free Replicated Data Types (Shapiro et al.)
