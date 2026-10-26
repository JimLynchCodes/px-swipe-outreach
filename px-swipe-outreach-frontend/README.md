# px-swipe-outreach-frontend

The swipe UI for PX Swipe Outreach. Each card shows one past customer:

* Their name, age, gender, location and the stores they shop at.
* Lifetime spend, days since their last purchase, and how many items they've bought.
* Their last purchase.
* An **AI suggestion** (offer title and reasoning).
* An editable **suggested message** with a Text/Email toggle and a character count.

**Send** (swipe right or `→`) delivers the message through the backend. **Skip** (swipe left or `←`) moves on to the next customer.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173. Needs the backend on :3000 (see ../README.md: `npm run dev` at the root starts both)
```

| Script | |
| --- | --- |
| `npm run dev` | Vite dev server. Proxies `/api` and `/health` to the backend |
| `npm run build` | Type-checks (`tsc -b`) and bundles to `dist/` |
| `npm run preview` | Serves `dist/` (with the same proxy) |
| `npm test` / `npm run test:watch` | Vitest + jsdom + Testing Library |
| `npm run typecheck` | `tsc -b` |

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_API_BASE_URL` | *(empty)* | Leave empty to call same-origin `/api` (dev proxy or reverse proxy). Set it, e.g. to `https://api.example.com`, when the API is on another origin. The backend's `CORS_ORIGIN` must then include this app's origin |
| `VITE_PROXY_TARGET` | `http://localhost:3000` | Backend address used by the dev/preview proxy |

## Structure

```
src/
├── main.tsx
├── App.tsx                    # deck state, suggestion loading, skip/send, swipe + keyboard, toasts, empty/error states
├── api.ts                     # typed fetch client (ApiError, idempotency keys)
├── types.ts                   # Card / Suggestion shapes (mirror the backend DTOs)
├── components/Header.tsx      # logo, tagline, "AI Powered" pill
├── components/CustomerCard.tsx# the card itself
├── lib/format.ts              # money / days / char count
└── styles.css
```

Behavior worth knowing:

* **Suggestions.** Suggestions are fetched per card and per channel, so switching between Text and Email fetches channel-specific copy. A response that arrives after a newer request has been made is ignored.
* **Idempotency key.** Each card gets one idempotency key, so retrying a Send never double-messages the customer.
* **Unreachable channels.** A channel the customer can't be reached on is disabled, and the contact note explains why.
* **Product images.** If `imageUrl` is null (it is for all of the seed data), a bag icon is shown instead.

## Tests

`src/App.test.tsx` mocks `fetch` and covers:

* Rendering the card and suggestion.
* Editing the message, sending it, and advancing to the next card.
* Switching to email (subject shown) and skipping with the arrow key.
* The backend-down error state.
