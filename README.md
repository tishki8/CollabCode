# CollabCode

A browser-based collaborative code editor for small teams. Open a shared project, edit
together in real time, run the code, and always see **who wrote what**, like Google Docs,
but for code, and without depending on anyone's machine being online.

> **Status: Phase 4 of 7 (authorship tracking).** Sign-in, projects, file tree, live multi-user
> editing with named cursors, share links with guests / approval / expiry / roles, and now
> **who wrote what**: a blame view, per-person contribution colours, per-person history with a
> diff, and a project contribution timeline. Review tools (comments, suggestions, checkpoints),
> code execution and export arrive in later phases. Sections marked *(planned)* describe the
> target design.

## Architecture

```mermaid
flowchart LR
  Browser["Browser<br/>Next.js + Monaco"] -->|"/api/v1 (rewrite)"| API["API<br/>Fastify + zod"]
  Browser -->|"WebSocket"| Collab["Collab server<br/>Hocuspocus + Yjs"]
  Browser -->|"Auth.js"| Web["Web (Next.js server)"]
  API --> PG[("PostgreSQL")]
  Web --> PG
  Collab --> PG
  Collab <-->|"pub/sub"| Redis[("Redis")]
  API -->|"BullMQ (Phase 6)"| Redis
  Redis --> Runner["Runner<br/>sandboxed Docker runs"]
  Runner --> Proxy["docker-socket-proxy"]
```

| Path | What it is | Status |
|---|---|---|
| `apps/web` | Next.js (App Router) + Tailwind UI, Auth.js sign-in, Monaco editor | Phase 1-2 |
| `apps/api` | Fastify REST API: projects, files, share links, collab tokens, permissions | Phase 1-2 |
| `apps/collab` | Hocuspocus (Yjs) WebSocket server: auth, persistence, Redis sync | Phase 2 |
| `apps/runner` | BullMQ worker running code in locked-down containers | placeholder |
| `packages/shared` | zod schemas, types, permission matrix, palette | Phase 1 |
| `packages/db` | Prisma schema, migrations, seed script | Phase 1 |

## Running it

### Option A: Docker Compose

```bash
cp .env.example .env        # optional; defaults work for the demo login
docker compose up --build
```

Open <http://localhost:3000>. Use **Sign in as alice / bob** (development login, seeded demo
users). Compose starts Postgres and Redis, applies migrations, seeds the demo data, then
starts the services (web :3000, api :4000, collab :1234). The browser must be able to reach
port 1234 (the collab WebSocket); change `COLLAB_PUBLIC_URL` if you expose it elsewhere.

### Try the collaboration flow (about 2 minutes)

1. **Alice:** open <http://localhost:3000>, click *Sign in as alice*, create a project (any
   language). The default file opens in the editor and the status shows **Live**.
2. Click **Share project** (top of the sidebar). Pick what people can do (*edit / comment / view
   only*), how long the link lasts (*1 hour / 1 day / 7 days / never*), optionally tick *Require my
   approval to join*, then **Create link** and **Copy link**.
3. **A guest (no account):** open a *private/incognito window* and paste the link. Type a display
   name and click *Continue as guest*. You are in the project, marked **guest**, and Alice sees you
   in *Online now* and as a labelled cursor (e.g. "GG Gina Guest (guest)").
4. **Bob (has an account):** in another private window paste the link and choose *Sign in
   instead*, then *Sign in as bob*. You land in the project with the link's role.
5. Type in the windows: text appears live everywhere. With a *view only* or *comment* link the
   editor says *Read-only* and typing does nothing.
6. **Invite-only:** create a link with *Require my approval to join*. Whoever opens it (guest or
   account) sees "Waiting for approval". Alice's *Share project* button shows a badge ("1 waiting");
   open it and **Approve** or **Reject**. The waiting person is let in (or told no) within a few
   seconds.
7. **Expiry:** an expired link shows "This link has expired" instead of a name form. (To try it
   without waiting, create a 1-hour link and move its `expiresAt` into the past in the database.)
8. **Who wrote what (Phase 4).** Have Alice and Bob each type on a different line. Hover over a
   line: a card says who wrote it and when ("and 1 other" if two people wrote on the same line).
   Press **Contribution colours** to tint each person's text, with their initials in the gutter and
   a legend. Open the **History** tab, choose a person and a time range, and press *Show what
   ... changed* for a diff of exactly their additions and removals. Open **Contributions** for a
   timeline lane per person plus lines added/removed, active time and "lines still theirs".
9. Stop and restart the stack (`docker compose restart collab`): reopen the file and the text is
   still there. Edits made while briefly offline (e.g. pause the network in dev tools) merge when
   the connection returns. Hover again: the authors are the same.

### Option B: local development

Requires Node 22+, pnpm 10 and a PostgreSQL 16 database.

```bash
pnpm install
cp .env.example .env                       # set DATABASE_URL to your database
export $(grep -v '^#' .env | xargs)        # or use your shell's dotenv tooling
pnpm db:generate
pnpm --filter @collabcode/db exec prisma migrate deploy
pnpm db:seed
pnpm --filter @collabcode/collab start &   # ws://localhost:1234  (needs COLLAB_JWT_SECRET, REDIS_URL optional)
pnpm --filter @collabcode/api start &      # http://localhost:4000
pnpm --filter @collabcode/web dev          # http://localhost:3000
```

### Real sign-in with Google / GitHub

Create OAuth apps and set `AUTH_GOOGLE_ID/SECRET` and/or `AUTH_GITHUB_ID/SECRET` in `.env`.
Callback URLs: `http://localhost:3000/api/auth/callback/google` and `.../github`.
Set `AUTH_SECRET` to a random value (`openssl rand -base64 32`). Set `DEV_LOGIN=false` to hide
the demo login.

## Tests and checks

```bash
pnpm lint
pnpm typecheck
pnpm test                       # unit tests; API integration tests need DATABASE_URL + migrations
pnpm --filter @collabcode/web e2e    # Playwright; needs a migrated + seeded DB and DEV_LOGIN=true;
                                     # it starts collab, api and web itself if they aren't running
```

CI (`.github/workflows/ci.yml`) runs lint, type-check and tests against a Postgres service on every push.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | api, web, db | PostgreSQL connection string |
| `REDIS_URL` | collab, runner (later) | Redis connection string. When set, collab instances share documents and presence through Redis pub/sub, so you can run several. Optional for a single instance |
| `COLLAB_JWT_SECRET` | api, collab | Shared secret (min. 32 chars) that signs/verifies the short-lived collab tokens. Both services refuse to start without it |
| `COLLAB_PUBLIC_URL` | api | Collab WebSocket URL as the browser reaches it (default `ws://localhost:1234`) |
| `WEB_ORIGIN` | api | Origin of the web app; writes from other origins are rejected (CSRF check) |
| `API_URL` | web | Where the web server (and the `/api/v1` rewrite) reaches the API |
| `API_PORT` | api | API listen port (default 4000) |
| `PORT` | collab | Collab listen port (default 1234) |
| `TRUST_PROXY_HOPS` | api | Number of reverse proxies in front of the API (default 0). Compose sets `1` because the browser reaches the API through the web app's `/api/v1` proxy; the API then uses the client address that proxy appended to `X-Forwarded-For` and ignores anything the client wrote there. Keep the API port unpublished in production |
| `AUTH_SECRET`, `AUTH_URL` | web | Auth.js secret and public URL |
| `AUTH_GOOGLE_ID/SECRET`, `AUTH_GITHUB_ID/SECRET` | web | OAuth credentials; a provider is shown only when configured |
| `DEV_LOGIN` | web | `true` enables passwordless login as seeded demo users. **Never in production** (also hard-disabled when `NODE_ENV=production`) |

Secrets live in environment variables only; `.env` is git-ignored.

## Key design decisions (so far)

- **One permission matrix, enforced server-side.** `packages/shared/src/permissions.ts` maps
  role → allowed actions and is used by every API route (and, from Phase 2, by the collab
  server). Roles are always read from the database, never from the client. Non-members get a
  404 (not 403) so project existence isn't leaked. Deny-by-default.
- **Shared zod schemas.** Request validation lives in `packages/shared`, so the frontend and
  backend can't drift apart; all inputs are validated before touching the database.
- **Auth.js database sessions.** The session cookie is an opaque token that the API looks up in
  the `Session` table, so the API and web app share one login without sharing JWT secrets.
- **Same-origin API calls.** The browser calls `/api/v1/*`, which Next.js proxies to the API:
  cookies stay same-site, no CORS. As defence in depth, the API also rejects writes whose
  `Origin` header isn't the web app.
- **Soft-deleted files.** Deleting a file hides it but keeps the row so history, blame and
  replay (later phases) still work. Sibling-name uniqueness is a partial unique index, which
  also lets a deleted name be reused.
- **Author colours** come from a colour-blind-safe palette (Okabe-Ito + Tol), and the UI always
  pairs colour with initials or a name.

### Real-time collaboration (Phase 2)

- **Why CRDTs (Yjs).** Every file is a Yjs document. Concurrent edits from any number of people
  merge deterministically without a central lock, and edits made while offline simply merge when
  the client reconnects. The server is just another peer that also stores the document, so a
  project can be reopened when nobody is online. (OT would need the server to order every edit
  and is harder to make correct for offline work.)
- **Hocuspocus** is the Yjs WebSocket server. One room per file (`file:<id>`) plus one
  awareness-only room per project (`presence:<id>`) that powers the *Online now* list across files.
- **Who may connect is decided by the server, from the database.** The API gives a signed-in
  member a 10-minute JWT that proves *identity only*. On every connection the collab server
  verifies it, looks up the member's role in Postgres and makes viewers/commenters
  **read-only on the server**: their document updates are dropped, not just hidden in the UI.
  Unknown files, deleted files and non-members all get the same refusal, so ids can't be probed.
  A role change in the database takes effect on the next (re)connect.
- **Cursors can't be spoofed.** Awareness is client-supplied, so the server rewrites it before
  broadcasting: the displayed name, initials and colour always come from the database,
  unknown fields are dropped and sizes are capped. Labels show *initials and name*, never
  colour alone, and are rendered through a CSS builder that rejects anything but `#rrggbb`
  colours and escapes names.
- **Persistence.** Hocuspocus debounces writes and stores the whole document as one compacted
  snapshot per file (`DocSnapshot`); it is reloaded when the file is next opened. (The
  per-edit event log for authorship arrives in Phase 4.)
- **Horizontal scaling.** With `REDIS_URL` set, the Hocuspocus Redis extension syncs document
  updates and awareness between instances; an integration test runs two collab servers against
  one Redis.
- **Editor assets.** Monaco is copied into `apps/web/public/monaco` at dev/build time and served
  from our own origin (no CDN), so the editor works offline and in Docker. y-monaco is pointed
  at that already-loaded instance instead of bundling a second copy.

### Share links, guests and approval (Phase 3)

- **Links.** The owner creates a link with a role (*viewer*, *commenter* or *editor*, never
  owner), a lifetime (*1 hour*, *1 day*, *7 days*, *never*) and optionally "require approval". The
  secret is 256 random bits and **only its SHA-256 hash is stored**, so the full URL is shown once,
  at creation. Revoking stops the link and declines its pending requests; people who already
  joined keep access.
- **Guests (no account).** Opening a link without an account asks for a display name only. The
  server validates the link *before* creating anything, then creates a guest user (no email) and a
  30-day session cookie; only a hash of the cookie secret is stored. A guest gets exactly the
  link's role, can open the shared project(s) but **cannot create projects**, and is marked
  **guest** in the header, the presence list and on their cursor, so nobody can pass as a
  signed-in teammate by choosing a familiar name. Names are limited to 40 characters with control,
  bidirectional-override and zero-width characters rejected. Each project accepts at most 50 guests.
- **Invite-only.** Joining records one pending request and grants nothing. The owner sees pending
  requests (with who is asking, whether they are a guest, and the role they'd get) and approves or
  rejects them; the member always gets the **link's** role, never anything the requester sent. The
  waiting visitor's page re-checks every few seconds. A rejected person cannot simply ask again;
  revoking the link declines everything pending; a link accepts at most 50 pending requests.
- **Expiry.** Computed from the *server's* clock when the link is created and checked on every use.
  An expired link answers `410` with a specific message ("This link has expired"), whereas
  unknown and revoked links look identical (`404`). Expiry stops *new* joins; existing members keep
  access.
- **Commenter.** Gets read access now (the collab server makes the connection read-only) and will
  be able to comment once Phase 5 adds comments.
- **Edits are blocked on the server, not in the UI.** The collab server decides read-only from the
  database role on every connection and refuses document updates from viewers and commenters,
  including guests holding those roles. Tests drive the WebSocket with hand-built protocol frames
  (so no client library is involved) and also tamper with the page to unlock Monaco: the edit stays
  on the attacker's own screen, is never broadcast and never stored. A positive control proves
  those same frames *are* accepted from an editor.
- **Rate limits** are per signed-in/guest session, or per client address for anonymous calls (the
  guest-join endpoint allows 60/min per address so a classroom can join together; the link
  preview is limited per link because the web server makes that call on visitors' behalf).

### Authorship design (Phase 4)

**What is recorded.** Every character in a Yjs document lives in an *item* with a permanent id
`(clientID, clock)`. Typing in a row is one item, a paste is one item, so the data grows with how
often authorship *changes*, not with characters. Authorship is the mapping "item id range ->
authenticated user + server time". It is stored in the `DocEvent` table, one row per **batch** of
changes by one user (the row also holds the merged Yjs update, so the log can rebuild the file,
and counts of characters and newlines added/removed). It is never stored inside the document, where
a client could forge it. The user is always the verified identity of the WebSocket connection (the
Hocuspocus context loaded from the database), never anything in the update.

**Attribution happens at delivery, not by diffing the document.** The server decodes each incoming
update *before applying it* and credits the id ranges that are new to the server. The obvious
alternative, "see which ids appeared in this transaction", is wrong. Yjs holds back an update whose
dependencies have not arrived (pending structs). If Alice's update arrives before the update it
builds on, Yjs applies it later, in the transaction triggered by *whoever delivered the missing
piece*, and a transaction diff credits Alice's text to that person. A unit test reproduces it
(`authorship.test.ts`, "attribution at delivery, not by diffing the transaction"): the transaction
that delivers update 1 contains all 6 clocks, including the 3 that update 2 delivered earlier. Deleted text is measured in the same pre-apply step, because by the time Yjs emits its
`update` event it has already garbage-collected the deleted content.

**ClientID ownership.** The first authenticated user whose connection uses a clientID owns it; the
claim is persisted (`YClient`, first writer wins, so it also holds across server instances and
restarts). A clientID is claimed by an awareness (cursor) update or by delivering new items. An
update that introduces **new** items under a clientID owned by someone else is rejected: the
document connection is closed (Hocuspocus close reason `Forbidden`, code 4403) and the attempt is
logged with file, clientID, owner and offender. This stops a user pre-sending text under another
user's id, which would either steal credit for that text or "squat" the id so the real owner's
later edits collide with the planted items and are silently dropped by Yjs. Re-sending items that
are already on record (a normal reconnect sync) is allowed and never re-attributed.

**Batching.** Keystrokes are merged in memory per (file, user, clientID) and written after 1.5 s of
quiet or at most every 5 s, when someone disconnects, on shutdown, and **before every document
snapshot** (the authorship extension has a higher hook priority than the database extension, so a
saved snapshot never contains text whose attribution exists only in memory). Typing 60 characters
is one or two rows. Trade-offs: other people's fresh text shows up in your blame view after their
batch is saved plus your next poll (up to about 5 s + 3 s; your own typing is attributed
instantly); a hard crash can lose up to the last few seconds of attribution (see below); the log
grows with activity and is not compacted yet.

**Blame is computed in the browser** by walking the live text's items and joining them with the
attribution ranges (fetched once, then incrementally "after event N"). Each line shows its main
author (most non-whitespace characters) and "and N others". Hovering is free and always matches the
screen. Text with no record (written before Phase 4) is shown as *unknown author*, never guessed.

**History and the diff.** The timeline pages through `DocEvent` rows. The per-person diff replays
the file's events from the beginning onto a document that keeps deleted text, ordered by when each
batch started, and reports exactly what the person inserted and removed with line numbers. Replay is
capped at 20,000 events (a clear error asks for an earlier end date) until Phase 5 adds checkpoints
to replay from.

**Contribution summary.** "Lines" means newline characters typed or removed (so it adds up across
batches). Active time sums a person's working sessions, bridging gaps under 5 minutes. People are
listed in order of first activity, never ranked. "Lines still theirs" comes from the last saved
snapshot of each file.

### Known limitations (authorship)

- **Undo / restore credit.** Undo and redo re-insert text as new items, so restored text is credited
  to *whoever pressed undo*, even when it was originally someone else's. The same rule applies to
  deleting and retyping. Giving restored text back to its original author would need Yjs's own undo
  manager, which y-monaco does not use.
- **Times are server receive times.** Text typed offline shows the time it synced, because client
  clocks cannot be trusted.
- **Crash window.** A hard crash can lose up to ~5 s of buffered attribution. If other users' clients
  then re-send text that never reached the log, the ownership rule rejects *their* update (the
  original author's client heals it on reconnect) and closes their document connection until then.
  Graceful shutdowns flush everything.
- **ClientID collisions** (two users randomly picking the same 32-bit id, about 1 in 4 billion per
  pair) would get the second user's connection rejected until they reload.
- **History** replays from the start (20,000-event cap) and orders batches by start time, so under
  heavy concurrent editing the line numbers are "as of replay" and approximate.
- The event log is append-only with no retention or compaction yet; "lines still theirs" skips
  files over 2 MB and looks at the first 100 files.
- Several collab servers share ownership through the database, but each keeps its own in-memory
  "already recorded" ranges (loaded when it opens a file), so a very rare cross-server race is
  resolved by the database claim.

### Known limitations

- The file tree is not live: other people's new/renamed files appear after a reload.
- Owners cannot yet remove members or change their roles, and revoking a link does not remove
  people who already joined. Expiry likewise only stops new joins.
- Expired guest sessions and guests who were rejected are not yet cleaned up from the database.
- Pending requests are discovered by polling (every 3-5 s), not pushed.
- A guest holding an *editor* link can edit (guests get "the link's role"). If you'd rather cap
  guests at commenter, that is a one-line change in `services/share-links.ts`.
- Rate limit counters are in memory (per API instance); they move to Redis in Phase 6.
- Documents have no size cap yet (frames are capped at 5 MB).

*(planned)* How authorship tracking works and how the code sandbox is secured will be documented
here as those phases land.
