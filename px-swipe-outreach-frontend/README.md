# PX Swipe Outreach — frontend

A responsive React + TypeScript + Vite frontend starter for the `px-swipe-outreach` project. It includes an interactive lead-swiping queue, search/filtering, local demo data, and an API adapter boundary ready to connect to the backend.

## Run locally

```bash
npm install
cp .env.example .env.local # optional; set VITE_API_BASE_URL to your backend
npm run dev
```

Production build: `npm run build`.

## Backend integration

Set `VITE_API_BASE_URL` to the backend origin. `src/api.ts` contains the typed fetch wrapper and example `getLeads` / `recordDecision` functions. The UI currently uses local demo data so it runs without a backend. Replace the demo data in `src/App.tsx` with `getLeads()` once the backend routes and response schema are confirmed.

**Important:** the repository's backend routes/schema were not available to this generated starter, so endpoint paths are intentionally not assumed. Swipe decisions are local-only until `recordDecision` is wired to the actual API.
