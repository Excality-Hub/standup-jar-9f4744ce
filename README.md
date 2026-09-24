# Standup Jar

A tiny, account-free app where a small team posts daily async standups
(Yesterday / Today / Blockers). Entries with blockers are highlighted red.

Everything lives in `src/index.js`, a single Cloudflare Worker that serves the
page and a JSON API. No frameworks, build tools or runtime dependencies.

## Local development

```sh
npm install
npm run dev   # wrangler dev, then open http://localhost:8787
```

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | The HTML page (always 200; also the liveness check). |
| GET | `/api/entries?date=YYYY-MM-DD` | 200 JSON array of that day's entries, newest first. 400 if `date` is missing/invalid. |
| POST | `/api/entries` | Body `{name, yesterday, today, blockers, date}`. 201 with the created entry, 400 `{error}` on validation failure. |
| other | `*` | 404 `{error: "Not found"}`; wrong method on a known path is 405. |

Validation: `name` required (≤ 50 chars); at least one of `yesterday`, `today`,
`blockers` required (≤ 1000 chars each); `date` must be a real `YYYY-MM-DD`
date no more than one day past the server's UTC today (defaults to UTC today).
Request bodies over 16KB are rejected.

Entry shape:

```json
{"id":"…","name":"Ana","yesterday":"…","today":"…","blockers":"","date":"2026-09-24","createdAt":"2026-09-24T09:15:02.123Z"}
```

## Storage (optional KV binding)

If a KV namespace is bound as `ENTRIES`, each entry is stored under its own key
`entries:<date>:<createdAt>:<id>`. Without the binding, the Worker uses an
in-memory store, which works but does **not** persist across isolates or
restarts. To enable KV:

```sh
npx wrangler kv namespace create ENTRIES
```

then uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and fill in the id.

Deployed to Cloudflare Workers automatically by the Shipline pipeline.
