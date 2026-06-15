# @smriti/sync-relay

A **zero-knowledge** blob store for Smriti's optional end-to-end-encrypted
memory sync. It is deliberately tiny: a single Cloudflare Worker backed by one
KV namespace that stores opaque encrypted bytes keyed by an opaque `syncId`.

The relay **never** sees:
- your memories' plaintext,
- the recovery code, or
- the derived AES key.

All encryption/decryption happens on-device in the extension's offscreen
document (`packages/extension/lib/sync-crypto.ts`). The relay only ever holds
`iv || ciphertext` blobs and a `syncId` it cannot link back to a recovery code.

## API

All routes are under `/v1/blob/:syncId`, where `syncId` is exactly 32 lowercase
hex characters (a 128-bit value HKDF-derived from the recovery code).

| Method   | Behavior                                              |
| -------- | ---------------------------------------------------- |
| `GET`    | `200` octet-stream with the stored blob, or `404`.   |
| `PUT`    | Store the request body (max 2 MB). `200` on success. |
| `DELETE` | Forget this sync group's blob. `200`.                |
| `OPTIONS`| CORS preflight (`204`).                              |

CORS is wildcard (`Access-Control-Allow-Origin: *`). That's safe here: the body
is ciphertext the relay can't read, there are no cookies/credentials, and the
`syncId` is a 128-bit-derived secret that isn't guessable.

## Deploy

Requires a Cloudflare account and `wrangler` (installed as a devDependency).

```bash
cd packages/sync-relay
npx wrangler login

# 1. Create the KV namespace and copy the printed id into wrangler.toml
#    (replace REPLACE_WITH_KV_NAMESPACE_ID).
npx wrangler kv namespace create SYNC_KV

# 2. Deploy. Note the printed workers.dev URL, e.g.
#    https://smriti-sync-relay.<your-subdomain>.workers.dev
npm run deploy
```

### Post-deploy wiring (manual, one-time)

The extension ships with a placeholder relay host. After deploying, replace
`smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev` with your real workers.dev
hostname in **three** places, then rebuild the extension:

1. `packages/extension/lib/sync.ts` — `DEFAULT_RELAY_URL`
2. `packages/extension/wxt.config.ts` — `host_permissions`
3. `packages/extension/wxt.config.ts` — `content_security_policy` `connect-src`

```bash
cd packages/extension && npm run build
```

### Rate limiting

Keep the Worker itself minimal — configure a **Rate Limiting** rule on the
route from the Cloudflare dashboard (Security → WAF → Rate limiting rules)
rather than in Worker code.

## Local development

```bash
npm run dev   # wrangler dev, serves on http://localhost:8787
```

`wrangler dev` uses a local KV simulation by default, so you can exercise
`GET`/`PUT`/`DELETE` without touching production data.

## Security model & known limitations

The `syncId` is a 128-bit value HKDF-derived from the recovery code. It is
both the lookup key **and** the bearer credential: knowing it grants read/write
to that one blob, and it can't be guessed or reversed into the recovery code or
the AES key. That's the whole auth model — deliberately so, to stay
zero-knowledge.

Two consequences are worth calling out for v1:

- **Writes are unauthenticated beyond knowing the `syncId`.** A client could
  `PUT` random 32-hex ids to churn KV. We can't add per-user server-side auth
  without a secret the relay would have to know (breaking zero-knowledge), so
  abuse is handled operationally: the 2 MB body cap (in-Worker), a Cloudflare
  **Rate Limiting** rule on the route (see above), and KV's account write
  quotas. A future option is a global write token (a shared secret gating all
  writes) if public abuse becomes a problem.
- **No compare-and-swap, so concurrent writers can clobber.** Each sync does a
  full pull → merge → push. If two devices sync at the same instant, both push
  full state and the later `PUT` wins, dropping the other's just-merged changes
  until the next sync reconciles them. Cloudflare **KV has no atomic CAS**, so
  true conditional writes would require migrating the relay to a **Durable
  Object** (which can serialize writes and hold a revision token). That's the
  intended path if multi-device concurrency becomes common; v1 accepts the
  small race because sync is user-initiated and the data volume is tiny.
