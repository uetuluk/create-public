---
name: create-ritsdev
description: Build, version, deploy, inspect, and manage private network web apps on a create-ritsdev platform using its remote MCP or ritsdev CLI. Use when a user mentions {{PLATFORM_HOST}}, wants to publish a static site or JS/TS HTTP functions to a private network, needs managed PostgreSQL, S3-compatible storage, or a managed LLM key for a site that calls a model, changes owner/network access, manages project secrets, reviews deploy logs, renders a private preview, rolls back, or deletes a hosted project.
---

# {{PLATFORM_HOST}}

Use the remote MCP at `{{PLATFORM_ORIGIN}}/mcp` whenever its tools are
available. Use the `ritsdev` CLI only when MCP is unavailable or a local source
tree can be uploaded more efficiently as one archive.

## Deployment workflow

1. Inspect the source tree and create `ritsdev.site.json` if it is absent.
   Read [references/site-contract.md](references/site-contract.md) for the
   manifest, function, migration, and binding contract.
2. Call `get_project`; create the project only when it does not exist. Default
   access to `owner` unless the user explicitly requests network-wide access.
   `create_project` takes `postgres` and `storage`, both true by default, and
   `llm`, false by default — ask for `llm: true` only when the site calls a
   model. If the project already exists without a resource you need, call
   `enable_project_resources` with `postgres`, `storage`, or `llm` rather than
   creating a second project, then wait for `resources.provisionState` to read
   `ready`. `get_project` reports what a project holds under `resources`.
3. Never put secrets in source. Write them with `set_project_secrets`; send
   `null` for a name to remove an obsolete secret.
4. Create a gzip tar source archive excluding `.git`, `node_modules`, build
   caches, local credentials, and `.env*`. Compute its lowercase SHA-256.
5. For MCP, call `begin_source_upload`, send ordered chunks no larger than the
   returned limit, then `complete_source_upload`. Send each chunk's own
   `sha256`: a bad chunk is then rejected on arrival instead of surfacing as a
   whole-archive mismatch at the end. If completion does fail, call
   `get_source_upload`, compare the per-chunk digests, and re-send only the
   chunk that differs — re-sending an earlier `chunkIndex` replaces it. Do not
   start a new upload. For the CLI, run `ritsdev push <slug> <directory>`.
6. Call `create_version` with a stable idempotency key and poll `get_version`
   until `ready` or `failed`.
7. Inspect the owner-only preview with `render_version`, and exercise
   endpoints with `probe_version`. Remote agents cannot browse the LAN URL
   directly: those two tools are the only way in. A `queued` reply means the
   render is still running — call again with the same arguments. A `failed`
   reply carries the page console output and errors.
8. Call `deploy_version` only after the build and preview are acceptable.
   Deployment is asynchronous because migrations run before atomic activation;
   poll `get_deployment` until it reports `active` or `failed`.
9. Use `get_logs` when a build, migration, cold start, or runtime fails. The
   `migrate` source records every file applied or skipped, and a runtime that
   dies at module scope has its stack trace recorded under `runtime`.
10. Use `get_analytics` to answer "has anyone used it?". It reports page loads,
    distinct visitors, and API requests over the last 30 days, counted at the
    edge from real requests, so nothing needs adding to the project's pages.
    Two things to pass on rather than let someone over-read: only page
    navigations count, so a single-page app that routes on the client reports
    the load that started the session and not the screens after it; and the
    owner's own visits count too, unless the site is set to owner-only. A
    brand-new project reporting zero is telling the truth.

Redeploy a previous ready version to roll back code. Database migrations are
forward-only; never assume code rollback reverses schema changes.

## Sharing a project in the gallery

There are three visitor tiers, and they are a ladder. `owner` is the owner alone
after signing in. `network` is anyone on the private network who already has the
URL. `showcase` is `network` **plus** a card — screenshot, one line, owner's
name — on every signed-in user's dashboard, so it advertises the project to
people who were not looking for it.

Only list a project when the person you are working for has asked you to. It is
their work being shown to everyone else on the platform, and it is not a default
you should pick for them.

1. Deploy the project first. `update_project_access` to `showcase` returns 409
   without a live version and a description.
2. Optionally call `get_showcase_draft`. It returns a sentence written by a
   model that read the deployed page. **It is a suggestion, not a listing.**
   Show it to the person you are working for and ask whether it is right — it
   was generated from their own page, so it can be wrong, overstated, or claim
   an affiliation the project does not have.
3. Call `set_showcase_listing` with **their** words, at most 200 characters. Do
   not pass the draft through unread. There is deliberately no argument that
   publishes the draft directly: this step exists so a person decides what
   others are told about their project.
4. Call `update_project_access` with `access: "showcase"`.
5. The platform screenshots the live page shortly afterwards, and again after
   every deploy. If that picture is not the one they want, call
   `set_showcase_screenshot` with a base64 PNG of at most 512 KiB; an uploaded
   image is never overwritten by a later automatic capture.

`list_showcase` browses what other people have shared. It is the only tool that
returns projects the caller does not own. Remember that those URLs resolve only
on the private network, so you generally cannot fetch them.

Setting access back to `network` or `owner` removes the card and deletes the
screenshot. The description is kept, so re-listing does not mean retyping it.

## Traps that catch first-time users

Every one of these was hit by an agent building a straightforward CRUD app, or
found gating the binding it names.
Read [references/site-contract.md](references/site-contract.md) for detail.

- **Do not use `npm:postgres`.** The runtime environment allowlist is exact and
  the driver probes `PGSSL`, so it dies at connect time. Use `jsr:@db/postgres`.
- **Do not use `BIGSERIAL` keys with JSON responses** unless you coerce
  `bigint` in a `JSON.stringify` replacer; it throws otherwise.
- **Import statically.** The runtime is `--cached-only`, so a dynamic
  `import()` that was not resolvable at build time fails.
- **`build.output` must be a subdirectory** and the build command has to
  populate it, even for a site with no build tooling.
- **Functions ship in the archive, never from build output.** The function
  entrypoint and everything it statically imports must be in the tar you
  upload. Anything your build command generates is discarded with the build
  workspace; only `build.output` survives, and only as static assets.
- **`Deno.env` is permission-scoped.** Only the variables the platform injects
  and the project secrets you declare may be read; anything else throws, and a
  throw at module scope kills the isolate before it serves a request. Declare
  the name with `set_project_secrets`, or guard the read.
- **The LLM binding is off unless you ask for it**, and asking is two steps.
  Create with `llm: true`, or add it later with `enable_project_resources`
  (`llm: true`), *and* set `resources.llm: true` in the manifest — the build
  refuses a manifest asking for a binding the project does not hold. Without
  the binding `LLM_API_KEY` is not on the environment allowlist, so reading it
  throws instead of returning undefined, which is the module-scope death above.
- **The LLM key is scoped to one model.** It works for `LLM_MODEL` and the
  proxy answers `403` for every other model name, including embeddings and
  image generation. Send `LLM_MODEL` verbatim; do not hardcode a model string.
- **The site database role cannot create tables.** `CREATE TABLE` at runtime
  fails with `permission denied for schema public`. All DDL belongs in the
  directory named by `database.migrations`, which is applied during deploy and
  recorded in `_ritsdev_migrations`. A deployment whose migrations cannot run
  now fails instead of activating.
- **An argument that looks ignored usually never arrived.** An MCP client caches
  each tool's schema when the connection opens and drops arguments that schema
  does not list, before the request is sent — so `create_project` with
  `llm: true` can return a project with `resources.llm` false, with no error
  anywhere. `get_skill` reports `toolSchemaVersion` and `toolParameters`, the
  arguments this server accepts right now. If what you sent is in that list, your
  connection is stale: reconnect it, most simply by restarting the session, then
  call the tool again. Do not re-provision or create a second project chasing it.
- **A green deployment is not a working site.** Use `probe_version` to exercise
  the API before telling the user it works. `get_logs` will not show a static
  asset that failed to appear.
- **First requests are slow.** A cold start takes tens of seconds. `render_version`
  and `probe_version` both wake the runtime first, so this shows up as latency,
  not as a failure.

## Guardrails

- App URLs are `https://<slug>.{{PLATFORM_HOST}}` and remain LAN-only.
- `owner` means only the project owner after Google authentication. `network`
  means unauthenticated access to anyone who can reach the LAN. `showcase` is
  `network` plus a listing in the dashboard gallery — same reachability, wider
  audience.
- A drafted description is never a published one. `get_showcase_draft` reads and
  `set_showcase_listing` writes, and nothing joins them, because the draft comes
  out of a model that read a page written by whoever wants it advertised. Always
  put it in front of a person before publishing it.
- Previews are always owner-only.
- Each project has a separate logical PostgreSQL database and object bucket.
- A project with the LLM binding gets `LLM_BASE_URL`, `LLM_API_KEY`, and
  `LLM_MODEL` in its function environment, and calls the endpoint itself with
  the OpenAI chat-completions shape. See
  [references/site-contract.md](references/site-contract.md) for a sample.
- The LLM key is a real credential on a shared proxy, minted per project and
  never shared between projects. Deleting the project revokes it at the
  deletion request rather than at purge; `restore_project` mints a new one.
  Never print it, log it, return it to a visitor, or copy it into source.
- LLM limits default to 60 requests and 200 000 tokens per minute, enforced by
  the proxy per key. Over either one it answers `429` with `Retry-After`, so
  back off rather than retrying immediately. `get_project` reports the current
  values as `quota.llmRequestsPerMinute` and `quota.llmTokensPerMinute`.
- Default limits are 256 MiB/0.25 CPU, 512 MiB PostgreSQL, 1.5 GiB objects,
  five retained versions, 25 MiB compressed source, and 100 MiB static output.
- Each account has a project quota. A new account gets three; an operator can
  raise an individual account, and operator accounts create against a floor of
  25, so yours may be higher and you cannot assume the number. Only creating is
  refused, with a `403` naming your limit. A project counts until it is purged,
  so one deleted an hour ago still occupies a slot for the rest of its seven-day
  recovery window.
- Builds have a 1 GiB workspace and can download only from public HTTPS
  destinations through the platform proxy. `npm ci` runs automatically when a
  root `package.json` is present, which requires a lockfile; set
  `build.install` to your own command, or to `false`, to change that.
- `export_database` returns the schema inline with `include: "schema"`, and a
  download URL for the full dump with `include: "all"`. The full dump is never
  returned inline. Both need the `database:read` scope, which is not granted by
  default and must be requested by name.
- Functions are request/response TypeScript or JavaScript under `/api`. Do not
  attempt Dockerfiles, custom processes, cron, background workers, or
  long-lived WebSockets.
- Confirm the exact slug before `delete_project`. Deletion has a seven-day
  recovery window before resource purge; use `restore_project` to cancel it.
  `immediate: true` purges at once and frees the slug and the quota slot with it,
  but it is refused unless you are an operator deleting your own project, and
  nothing about it can be undone — do not reach for it to work around a quota.

## CLI fallback

Install the CLI from the platform itself. It is a single self-contained file
that always matches the deployed API:

```sh
curl -fsSL {{PLATFORM_ORIGIN}}/cli -o ritsdev && chmod +x ritsdev
```

Do **not** install `@uetuluk/create-cli` from npm unless you have confirmed the
published version matches this platform. It has lagged a rewrite before, and a
stale client fails confusingly against the current API.

Create a personal token in the dashboard, then:

```sh
export RITSDEV_TOKEN=rits_...
./ritsdev create my-site
./ritsdev deploy my-site .
./ritsdev logs my-site
./ritsdev stats my-site
```

`RITSDEV_TOKEN` avoids an interactive login and is the right choice for agents.
Never print or commit it.
