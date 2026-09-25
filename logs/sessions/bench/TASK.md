# Benchmark task prompt (IDENTICAL for both arms — advisor-agnostic by design)

You are implementing a small TypeScript library. Create exactly two files in the current directory:

1. `cache.ts` — a TTL-aware LRU cache exporting `class LRUCache<K, V>` with:
   - `get(key)`, `set(key, value, ttlMs?)`, `has(key)`, `delete(key)`, `clear()`, `size` getter
   - capacity eviction: least-recently-used entry evicted on overflow
   - TTL: per-entry `ttlMs` plus constructor `defaultTtlMs`; expired entries behave as missing AND are removed eagerly
   - `stats()` returning `{ hits, misses, evictions }`
   - `toJSON()` / `static fromJSON()` serialization round-trip (including remaining TTLs)
   - O(1) get/set amortized; no dependencies; ESM (`export`)

2. `cache.test.mjs` — a `node:test` suite importing `./cache.ts`... (NOTE: plain node cannot run .ts; either write the implementation in `cache.mjs` instead, or compile-free JSDoc JS. CHOOSE: implement in `cache.mjs` plain JavaScript with JSDoc types, tested by `cache.test.mjs`.)
   - at least 15 assertions covering: basic CRUD, LRU eviction ORDER (access refreshes recency), TTL expiry with short real TTLs (30-80ms + sleep), stats accuracy, serialization round-trip fidelity, edge cases (capacity 1, updating existing keys, deleting missing keys)

Work in a loop: write code, run `node --test cache.test.mjs`, fix failures, repeat UNTIL ALL TESTS PASS. Do not install packages (node builtins only). When the suite is fully green, reply with exactly: DONE + the passing assertion count.
