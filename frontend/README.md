# Seven Degrees of Wikipedia

A single-view, constellation-map Wikipedia path explorer backed by the real graph runtime.

## Stack

- **Next.js 15** (App Router)
- **TypeScript**
- **Tailwind CSS**
- **Framer Motion**

## Setup

```bash
npm install
NEXT_PUBLIC_WIKI_BACKEND_URL=http://127.0.0.1:3030 npm run dev
```

Open [http://localhost:4500](http://localhost:4500) if you launch the frontend on port `4500`.

If `NEXT_PUBLIC_WIKI_BACKEND_URL` is omitted, the frontend defaults to `http://127.0.0.1:3030`.

## File Structure

```
app/
  page.tsx          — App-router entry point
  layout.tsx        — Fonts (Syne + Azeret Mono), metadata
  globals.css       — Tailwind, CSS vars, animations

Background.tsx          — Particle-field canvas background
ConstellationGraph.tsx  — Single constellation layout with RAF physics, drag, hover
SearchUI.tsx            — Origin/destination inputs, swap, autocomplete, find button
StatsPanel.tsx          — Floating HUD, stats, recent searches

lib/
  api.ts            — Shared backend client
  demoData.ts       — Demo article pairs for the idle state
  types.ts          — Shared frontend data contracts
```

## Backend Integration

The frontend now calls the backend through `lib/api.ts` and expects these shared surfaces:

- `GET /api/readiness`
- `GET /api/articles/suggest?q=...`
- `POST /api/path`
- `GET /api/stats/overview`

The frontend consumes one shared contract for suggestions, search results, readiness, and stats.

## Design Notes

- The graph is always rendered with the single constellation layout
- Node float physics uses a damped spring system in a RAF loop
- SVG positions are updated via direct DOM manipulation (no React re-renders)
- Drag propagation is capped at depth-1 adjacent nodes only
- Distance-from-start controls brightness (closer = brighter)
- The particle-field background is fixed across the app
- The app is dark-mode only, fully monotone/grayscale
- Font: **Syne** (display) + **Azeret Mono** (metadata/monospace)
