# Seven Degrees of Wikipedia Backend

Local backend/data engine for a Wikipedia shortest-path app. This repo is intentionally backend-only right now: no frontend, no UI scaffolding, just the import pipeline, in-memory runtime engine, API surface, and persistent stats/analytics layer.

## What It Does

- Discovers and parses local Wikipedia SQL dump files from `data/`
- Reads `page`, `redirect`, `linktarget`, and `pagelinks`
- Filters to main namespace articles only (`ns = 0`)
- Resolves redirect chains to canonical articles
- Builds a directed article graph with dense integer node IDs
- Persists a prebuilt runtime artifact to `artifacts/wiki-runtime.v8`
- Preloads the full runtime graph/index state into RAM on startup
- Exposes HTTP endpoints for resolve, suggest, pathfinding, status, and stats
- Tracks lifetime + current-session search analytics with disk persistence

## Runtime Design

The runtime is optimized for low query latency after startup, not low memory usage.

- Graph representation: CSR-style adjacency with `Uint32Array`
  - `forwardOffsets`
  - `forwardAdjacency`
  - `reverseOffsets`
  - `reverseAdjacency`
- Title resolution:
  - canonical title array
  - alias/redirect title array
  - exact lookup `Map<string, aliasIndex>`
  - prefix-sorted alias index for autocomplete
- Pathfinding:
  - bidirectional BFS
  - integer node traversal only
  - reusable typed-array scratch buffers
  - forward + reverse graph both resident in RAM
- Caching:
  - in-memory LRU-style path result cache for repeated lookups

This intentionally keeps redundant structures in memory because runtime responsiveness is the priority.

## Expected Dumps

Place the dump files in `data/`:

- `enwiki-*-page.sql.gz`
- `enwiki-*-redirect.sql.gz`
- `enwiki-*-linktarget.sql.gz`
- `enwiki-*-pagelinks.sql.gz`

The loader discovers these by pattern, so exact dated filenames are fine.

## Commands

```bash
npm install
npm run build:graph
npm run start
```

During development:

```bash
npm run dev
```

To inspect an already-built artifact:

```bash
npm run inspect:artifact
```

## Build Pipeline

`npm run build:graph` performs the import/build flow:

1. Parse `page.sql.gz`
2. Keep only `page_namespace = 0`
3. Split canonical articles from redirects
4. Parse `redirect.sql.gz` and resolve redirect chains
5. Build canonical + alias lookup indexes
6. Parse `linktarget.sql.gz` and map modern link targets to canonical node IDs
7. Parse `pagelinks.sql.gz` twice
8. First pass counts graph degrees
9. Second pass fills forward/reverse CSR adjacency arrays
10. Persist the runtime artifact to disk

The runtime artifact is what the server loads into RAM at startup. The raw SQL dumps are not used during normal query serving.

## API Surface

### `GET /api/status`

Returns build/runtime readiness, discovered dumps, artifact location, and loaded runtime summary.

### `GET /api/articles/resolve?title=Alan%20Turing`

Response shape:

```json
{
  "query": "Alan Turing",
  "result": {
    "query": "Alan Turing",
    "normalizedQuery": "alan turing",
    "matchedTitle": "Alan Turing",
    "canonicalTitle": "Alan Turing",
    "canonicalId": 12345,
    "viaRedirect": false,
    "kind": "canonical"
  }
}
```

### `GET /api/articles/suggest?q=alan&limit=10`

Response shape:

```json
{
  "query": "alan",
  "suggestions": [
    {
      "title": "Alan Turing",
      "canonicalTitle": "Alan Turing",
      "canonicalId": 12345,
      "viaRedirect": false,
      "kind": "canonical"
    }
  ]
}
```

### `GET /api/paths?from=Alan%20Turing&to=Shrek`

Response shape:

```json
{
  "request": {
    "from": "Alan Turing",
    "to": "Shrek"
  },
  "resolution": {
    "from": {
      "query": "Alan Turing",
      "normalizedQuery": "alan turing",
      "matchedTitle": "Alan Turing",
      "canonicalTitle": "Alan Turing",
      "canonicalId": 12345,
      "viaRedirect": false,
      "kind": "canonical"
    },
    "to": {
      "query": "Shrek",
      "normalizedQuery": "shrek",
      "matchedTitle": "Shrek",
      "canonicalTitle": "Shrek",
      "canonicalId": 67890,
      "viaRedirect": false,
      "kind": "canonical"
    },
    "redirectsApplied": false
  },
  "result": {
    "found": true,
    "cached": false,
    "pathLength": 4,
    "pathTitles": [
      "Alan Turing",
      "Mathematician",
      "United Kingdom",
      "DreamWorks Animation",
      "Shrek"
    ],
    "pathNodeIds": [12345, 456, 789, 901, 67890],
    "metrics": {
      "durationMs": 2.1,
      "nodesVisited": 1842,
      "nodesExpanded": 921,
      "frontierExpansions": 8,
      "forwardVisited": 1012,
      "reverseVisited": 830
    }
  }
}
```

### Stats Endpoints

- `GET /api/stats/session`
- `GET /api/stats/lifetime`
- `GET /api/stats/recent?limit=50`
- `GET /api/stats/performance?scope=lifetime`
- `GET /api/stats/top-searches`
- `GET /api/stats/connectors`
- `GET /api/stats/leaderboard`

These expose:

- total/success/failure counts
- duration aggregates
- approximate median / p95 / p99 via histograms
- average path length
- longest/shortest non-trivial discovered paths
- top start/end articles
- top article pairs
- top successful/failed searches
- top connector/bridge articles
- first-hop and last-hop leaderboards
- most frequently resolved redirects
- recent searches

## Notes

- The graph is directed because Wikipedia links are directed.
- Redirect pages are not runtime graph nodes; they resolve to canonical nodes.
- The importer is schema-driven enough to handle modern `pagelinks` with `pl_target_id`, and it can fall back to `pl_namespace` + `pl_title` if needed.
- If the runtime artifact is missing but all dumps are present, the server will auto-build once on first startup.
- If the dumps are incomplete, the server still boots and exposes status, but search endpoints will return a readiness error until the artifact exists.
