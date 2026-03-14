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
WIKI_BACKEND_URL=http://127.0.0.1:7878 npm run dev
```

Open [http://localhost:4500](http://localhost:4500).

If `WIKI_BACKEND_URL` is omitted, the frontend proxy defaults to `https://7wikiapi.skylarenns.com`.

## Server-Client Deployment Model

The browser should talk only to the frontend origin. This app now uses Next.js route handlers under `/api/*` to proxy requests to the backend server.

- Public entrypoint: `http://your-server:4500` or your Cloudflare Tunnel hostname
- Private backend: `http://127.0.0.1:7878`
- Browser API base: same-origin `/api/*`
- Frontend-to-backend hop: `WIKI_BACKEND_URL`

That means clients no longer need direct access to the backend host or port.

## Vercel Setup

If you connect this repo to Vercel, configure the project like this:

- Framework Preset: `Next.js`
- Root Directory: `frontend`
- Install Command: `npm install`
- Build Command: `npm run build`

Set this environment variable in Vercel:

```bash
WIKI_BACKEND_URL=https://7wikiapi.skylarenns.com
```

That URL should be the public Cloudflare Tunnel hostname for the backend running on your Linux machine.

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

The frontend now calls same-origin `/api/*` routes through `lib/api.ts`, and the Next.js server forwards those requests to the backend. The proxied backend still expects these shared surfaces:

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
