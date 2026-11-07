# px-swipe-outreach-frontend

The swipe UI for PX Swipe Outreach. Each card shows one past customer:

* Their name, age, segment (loyal / at risk / lapsed), 21+ verification, location and the stores they shop at.
* Lifetime spend, days since their last purchase, and how many items they've bought.
* **Buying patterns**: favorite categories and brands, visits per month, average basket, and usual day and time.
* Their last purchase and recent items.
* An **AI suggestion**: title and reasoning, the chosen deal, why it was chosen, and the best time to send.
* An editable **suggested message** with a Text/Email toggle and a character count. Texts count toward the 480-char limit, including the signature and "Reply STOP to opt out.".

Next to the deck, **Deals this week** shows Mon–Sun slots of enabled promotions. Owners and admins can add, edit and remove deals there.

The ☰ menu (with an unread badge) links to:

* **Replies**: an iMessage-style inbox, polled every 15 s
* **Opt-out list**
* **Team**
* **Settings**: store name, default channel, max discount, email and text signatures, and promotions with enable checkboxes

See [docs/OUTREACH_FEATURES.md](../docs/OUTREACH_FEATURES.md).

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
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | *(empty)* | Enables Supabase Auth (login, magic link, sign-up). **Public anon/publishable key only.** The app refuses a service_role key |
| `VITE_DEMO_MODE` | *(empty)* | Without Supabase config, `npm run dev` runs in demo mode. Production builds show a configuration error unless this is `true` |

### Auth

`src/auth/` contains the Supabase client, `AuthProvider` (session tracking with auto-refresh, `/api/me` memberships, org selection persisted in localStorage) and `LoginPage` (password, magic link, sign-up). `Root.tsx` gates the app: login → loading → "no store access" → the deck. The API client adds `Authorization` and `X-Org-Id` headers and signs out on any `401`. Users with several orgs get an org switcher in the header.

### Team

`/team` (the people icon in the header) lists members and, for owners/admins, an invite form and pending invitations with resend/revoke. `/invite/accept?token=…` is where invitation emails land: it previews the invite, lets a signed-out invitee sign in or create an account with the invited email, then joins the org and switches to it. Routing is a tiny `history`-based helper in `src/router.ts`; the host must serve `index.html` for unknown paths (the bundled nginx config and Vite dev server do).

## Structure

```
src/
├── main.tsx
├── App.tsx                    # deck state, suggestion loading, skip/send, swipe + keyboard, toasts, empty/error states
├── api.ts                     # typed fetch client (ApiError, idempotency keys)
├── types.ts                   # Card / Suggestion shapes (mirror the backend DTOs)
├── components/Header.tsx      # logo, ☰ menu with unread badge, "AI Powered" pill
├── components/PageShell.tsx   # header + back link + title for secondary pages
├── components/CustomerCard.tsx# the card itself
├── deals/                     # DealsPanel (weekly slots), PromotionForm, useDeals
├── settings/                  # SettingsPage (signatures, defaults, promotions), OptOutsPage
├── replies/                   # RepliesPage (list + thread + composer), useUnreadCount (15 s polling)
├── lib/week.ts                # weekday, discount, category and relative-time helpers
├── team/                      # TeamPage, AcceptInvitePage, role helpers + tests
├── router.ts                  # pushState navigation
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
* Deals panel slots, segment and patterns, the chosen-deal chip, age-unverified blocking, the default channel from settings, and per-channel opt-out.

`src/pages.test.tsx` covers the hamburger menu and badge, Settings (save, promotions toggle/add/delete, read-only for staff), the Opt-out list (filter, search, pagination), and Replies (ordering, unread, mark read, reply with signature and count, opted-out block).
