# Deployment Guide (Cloudflare Workers Builds)

This fork deploys through **Cloudflare Workers Builds** connected to GitHub.
The old GitHub Actions deployment workflow has been removed; ignore older guides or
templates that still mention an Actions-based deploy job.

---

## 1. Prerequisites

- A Cloudflare account with a domain (zone) or a `workers.dev` subdomain
- A D1 database, KV namespace, and R2 bucket created in Cloudflare
- The repository forked/cloned and connected to a Cloudflare Worker

### Wrangler configuration

The repository tracks a route- and resource-specific `wrangler.jsonc` for this
deployment (`wrangler.jsonc` is also listed in `.gitignore`, so it is tracked
deliberately with real resource IDs). `wrangler.example.jsonc` is the template
used by CI.

Do **not** overwrite `wrangler.jsonc` with the example on the deploy branch.
When bindings change, update **both** files. CI verifies they match:

```bash
bun run wrangler:verify
```

This checks that the bindings in `wrangler.jsonc` match `wrangler.example.jsonc`
and that `worker-configuration.d.ts` contains the corresponding types.

If you prefer generating the config from environment variables instead, the
legacy helper still exists:

```bash
DOMAIN=blog.example.com \
D1_DATABASE_ID=xxx \
KV_NAMESPACE_ID=yyy \
BUCKET_NAME=blog \
bun run wrangler:prepare
```

Cloudflare Workers Builds in this fork uses the committed `wrangler.jsonc`.

---

## 2. Connect the Worker to GitHub

1. Cloudflare Dashboard → **Workers & Pages** → **Create application** →
   **Connect to Git** (Workers Builds).
2. Select the repository and branch (`main`).
3. Set the build settings:

| Setting | Value |
| :--- | :--- |
| Build command | `bun run build` |
| Deploy command | `bun run deploy` |
| Root directory | repository root |

4. Add build-time environment variables:

| Variable | Value | Notes |
| :--- | :--- | :--- |
| `BUN_VERSION` | `1.3.8` | Must match `packageManager` in `package.json` |
| `NODE_OPTIONS` | `--max-old-space-size=6144` | Required; without it the Vite build may OOM |
| `THEME` | `default` or `fuwari` | Optional, defaults to `default`; this is a **build-time** value |
| `VITE_UMAMI_WEBSITE_ID` | your Umami website ID | Optional; baked into the client bundle |
| `VITE_TURNSTILE_SITE_KEY` | your Turnstile site key | Optional; needed for Turnstile on login |

> `THEME` and `VITE_*` values are baked in at build time. Changing them requires
> a new deployment, not just a runtime variable update.

5. Deploy. The deploy command runs only `wrangler deploy`; **database
   migrations are not run automatically** (see section 4).

---

## 3. Runtime variables and secrets

After the first successful deployment, open the Worker →
**Settings → Variables and Secrets** and add the runtime values.

### Required

| Name | Description |
| :--- | :--- |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Public URL, e.g. `https://blog.example.com` |
| `ADMIN_EMAIL` | Admin email; email/password signup for this address is blocked, log in via GitHub OAuth or an existing account |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `CLOUDFLARE_ZONE_ID` | Zone ID used for CDN cache purging |
| `CLOUDFLARE_PURGE_API_TOKEN` | Token with Cache Purge permission |
| `DOMAIN` | Public hostname, e.g. `blog.example.com` |

### Optional

| Name | Description |
| :--- | :--- |
| `GITHUB_TOKEN` | Fine-grained token for update checks / avoiding GitHub API rate limits |
| `CDN_DOMAIN` | Separate CDN hostname, preferred when purging cache |
| `PAGEVIEW_SALT` | Salt for anonymized pageview hashes |
| `UMAMI_SRC` | Umami tracking proxy URL |
| `TURNSTILE_SECRET_KEY` | Turnstile secret (required if Turnstile is enabled) |

Site identity (title, description, icons, background images, email/SMTP, etc.)
is edited in **Admin → Settings**, not through environment variables.

> **CDN cache**: after publishing a post the app purges the affected URLs via
> the Cloudflare API. If a purge fails, use the admin **Settings → Clear CDN
> Cache** action. Pages (`text/html`) are intentionally **not** shared-cached,
> because their content depends on the visitor's locale.

---

## 4. Database migrations

Migrations are **manual and deliberate** in this fork. The deploy script no
longer runs them automatically, so a failed deployment cannot leave the database
ahead of the Worker code.

Before deploying a commit that contains schema changes:

```bash
# from the repository root
bun db:migrate
```

This script:

1. Captures a local snapshot (local target) or a D1 Time Travel bookmark (remote target)
2. Applies pending migrations
3. Verifies post/comment counts are unchanged
4. Automatically restores the snapshot/bookmark if the migration **or its
   verification** fails

Useful variants:

```bash
bun db:migrate:local     # local D1 (requires .wrangler/state; run `bun dev` once first)
bun db:migrate:unsafe    # bypass safety checks (do not use against production)
```

For remote migrations, Wrangler needs Cloudflare credentials, e.g.
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, in your shell environment.

If a remote migration fails and automatic rollback also fails, the script prints
the manual restore command:

```bash
bunx wrangler d1 time-travel restore DB --bookmark <bookmark>
```

CI checks for migration drift (`bun run db:generate` must not change
`migrations/`). Generate migrations locally with `bun run db:generate` and commit
them before merging.

---

## 5. What CI checks

On every pull request **and** push to `main`:

```bash
bun run wrangler:verify    # config + Env type consistency
bun scripts/generate-manifest.ts && git diff --exit-code
bun lint
bun run i18n:compile       # local inlang plugins, no CDN
bun run i18n:verify
bun tsc --noEmit
bun run db:generate && git diff --exit-code -- migrations
bun run test:node
bun run test
bun run build
```

Run the same commands locally before pushing. The `i18n` plugins are installed
as dev dependencies, so builds no longer download plugins from jsDelivr.

---

## 6. Troubleshooting

### Build runs out of memory

Set `NODE_OPTIONS=--max-old-space-size=6144` in the Cloudflare build environment
variables. This is required for this project.

### `binding AI of type ai failed to generate: internal error [code: 10021]`

Transient Cloudflare build-side error. Retry the build. If it persists, check
the AI binding in `wrangler.jsonc` and the Cloudflare dashboard.

### Paraglide / i18n compile errors

The project now uses locally installed inlang plugins. Run:

```bash
bun install
bun run i18n:compile
```

If you still see CDN URLs, check `project.inlang/settings.json`.

### `wrangler:verify` fails after adding a binding

Update both `wrangler.jsonc` and `wrangler.example.jsonc`, then regenerate types:

```bash
bun run cf-typegen
```

### Pages look stale after deployment

- Verify the Worker version in the Cloudflare dashboard.
- Check `cf-cache-status` / `age` response headers.
- Use **Admin → Settings → Clear CDN Cache**.
- HTML pages are not CDN-cached by design; API documents (sitemap, RSS, Atom,
  JSON feed) are cached for 1 hour and purged on publish.

---

## 7. Rollback

Cloudflare keeps previous Worker versions. If a deployment is broken:

1. Cloudflare Dashboard → Workers → the Worker → **Deployments/Versions**
2. Roll back to the last known good version.

Database migrations are not automatically rolled back with the Worker version.
If a migration must be undone, use D1 Time Travel with the bookmark captured by
`bun db:migrate`.
