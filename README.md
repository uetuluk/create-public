# create-ritsdev

A self-hosted Sites platform for a private network. Agents and people upload a
small web project through a public control plane; the deployed site, database,
objects, and functions stay inside your network.

Each installation runs on its own domain. This document writes that domain as
`sites.example.org`; yours is whatever you set `GATEWAY_DOMAIN` to.

Licensed under the [GNU AGPL v3](LICENSE) — if you run a modified copy as a
service, its source has to be available to its users. The `cli/` directory is
[MIT](cli/LICENSE), so a client can be embedded and redistributed freely.

**[See the dashboard](https://uetuluk.github.io/create-demo-static)** — a static
demo, no sign-up and nothing installed. Then
[try it in about five minutes](docs/try-it.md) from published images, or see
[docs/deploying-your-own.md](docs/deploying-your-own.md) to stand one up
properly.

## What a project gets

- `https://<slug>.sites.example.org` on the private network.
- Immutable source revisions, build versions, owner-only previews, atomic
  deployments, and rollback by redeploying an earlier version.
- A separate logical PostgreSQL database inside the shared PostgreSQL 16
  cluster, connected through PgBouncer.
- A separate S3-compatible RustFS bucket and access identity.
- An optional Deno HTTP function mounted at `/api`.
- Visitor access set to `owner`, `network`, or `showcase`.
- A count of who has been there: page loads, distinct visitors, and API
  requests over the last 30 days, on the dashboard card, `ritsdev stats`, and
  `get_analytics`.

Access is a ladder. `owner` is the owner alone, after signing in. `network` is
anyone on your private network who already has the URL. `showcase` is `network` plus
a card in the gallery on every signed-in user's dashboard, so it advertises the
project to people who were not looking for it.

Listing a project needs a deployed version and one line from its owner saying
what the app is for. The platform screenshots the live page when the project is
listed and after every deploy; the owner can upload their own picture instead.
An owner can also ask for a suggested description, drafted by a model that read
the page — it is a suggestion, and only text the owner supplies is ever shown to
anyone else.

Visits are counted at the edge, from real requests. Nothing is added to a
project's pages, no script and no cookie, and a project cannot influence its own
numbers. Only page navigations count, so an app that routes on the client
reports the load that began a session rather than every screen after it; and an
owner's own visits count like anyone else's unless the site is owner-only, since
on the other tiers the browser carries nothing to tell them apart. A project in
the gallery shows its page loads to everyone who can see the gallery; the
distinct-visitor figure stays with its owner.

Accounts marked as operators also get a read-only system admin view at
`/admin`: every project and account, live runtime and host resource use, the
job queue, and recent audit events. The same data is available as JSON under
`/v1/admin`. See [docs/operations.md](docs/operations.md#system-admin-view).

Operators create against a higher project quota than the three a new account
gets, and can purge a project *they own* immediately instead of waiting out its
seven-day recovery window. Neither applies to anyone else's projects.

Accounts named in `PLATFORM_SUPERADMIN_EMAILS` sit one rung above that and can
write through `/admin`: any account's project quota and role, and any project's
resource limits, each change audited with the value it replaced. The superadmin
role itself is granted only by that variable — the API refuses to mint or demote
one — so no single request can lock the platform out of its own admin surface.

The public surface is limited to the dashboard, Google/OAuth endpoints, REST
control API, and Streamable HTTP MCP at:

```text
https://sites.example.org/mcp
```

The wildcard app domain must never be added to the public Cloudflare Tunnel.
Wildcard TLS binds only to the configured LAN/VPN address, and `network`
projects are additionally checked against `NETWORK_CIDRS` by the gateway.

## Project contract

Create `ritsdev.site.json` in the project root:

```json
{
  "schemaVersion": 1,
  "build": {
    "command": "npm run build",
    "output": "dist",
    "spa": true
  },
  "functions": {
    "entrypoint": "functions/index.ts",
    "mount": "/api"
  },
  "database": {
    "migrations": "migrations"
  },
  "resources": {
    "postgres": true,
    "storage": true
  }
}
```

Static-only projects may omit `functions`, `database`, and unused resources.
Function modules export a Fetch-style handler:

```ts
export default {
  async fetch(request: Request): Promise<Response> {
    return Response.json({ok: true, path: new URL(request.url).pathname})
  },
}
```

Functions receive `DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, and
`RITSDEV_PROJECT_ID` when the corresponding resources are enabled.

Tenant runtimes use per-project Docker networks and a gateway-to-runtime
credential. Build containers have no direct network route or writable host
workspace; dependency downloads are limited to public HTTPS through the
build-egress proxy.

## CLI

Create a personal token in the dashboard, then:

```sh
cd cli
npm ci
npm run build
node dist/cli.js login
node dist/cli.js create my-site
node dist/cli.js deploy my-site ../my-site
node dist/cli.js logs my-site
```

The published binary is `ritsdev`. `RITSDEV_TOKEN` and `RITSDEV_SERVER` may be
used instead of the credentials file.

## Repository layout

- `deploy/platform`: control plane, private site gateway, and executor.
- `deploy/compose.yaml`: PostgreSQL, PgBouncer, RustFS, Caddy, and platform
  services.
- `cli`: generic source/version/deployment CLI.
- `skills/create-ritsdev`: agent instructions for the public MCP and CLI.
- `docs`: architecture, protocol, security, and operations.

See [docs/deploying-your-own.md](docs/deploying-your-own.md) to run your own,
and [docs/operations.md](docs/operations.md) for running one day to day.

---

Built with [Claude](https://claude.com/claude-code).
