# Platform design

## Trust boundary

The platform domain (`$GATEWAY_DOMAIN`, written `sites.example.org` throughout
this document) is the public control surface. Caddy's wildcard site route and
the `*.` DNS beneath it stay private. The Cloudflare Tunnel has exactly
one hostname mapping: the root domain to `platform:3000`.

The public control-plane container has no Docker socket. It validates requests,
stores source archives, and queues fixed-shape jobs. The private executor is
the only component with Docker and infrastructure administrator credentials.
PostgreSQL/storage administration, root ingress, wildcard ingress, public
control egress, rendering, and build egress use separate Docker networks.

## Request flow

1. Google signs in an account in `AUTH_ALLOWED_EMAIL_DOMAINS`, or an MCP client completes
   OAuth 2.1 authorization code + PKCE and an explicit CSRF-bound consent POST.
2. The user creates a project. The executor provisions a distinct PostgreSQL
   database, migration/runtime/write roles, bucket, storage identity, and quota.
3. Source is uploaded as a SHA-256 verified gzip tar archive.
4. A disposable Node build container validates `ritsdev.site.json`, installs a
   locked npm tree, builds static assets, and caches Deno dependencies. Its
   workspace is a size-limited tmpfs and its internal network reaches only a
   public-HTTPS CONNECT proxy.
5. A ready version has an owner-only preview hostname.
6. Deployment migrations run one file/transaction at a time. Only after they
   succeed does the executor atomically switch the current version.
7. Caddy forwards wildcard requests to the gateway. Static assets are served
   without a tenant container; `/api/*` transparently wakes a Deno runtime.

## Data isolation

PostgreSQL is one server/cluster with many logical databases: one database per
project. Projects do not share schemas inside one database. PgBouncer routes
each runtime connection to its own database and caps it at five connections.

Each project also receives a distinct RustFS bucket, access key, secret, and
bucket policy. RustFS remains behind an S3-compatible driver boundary and must
pass the conformance gate before open registration.

Function containers do not share a tenant bridge. The executor creates one
network per project and attaches only that project's runtimes plus the gateway,
PgBouncer, and RustFS. A separately encrypted per-runtime credential is
required on every proxied request as defense in depth.

## Managed LLM binding

A project may request `resources.llm` alongside PostgreSQL and object storage.
The platform then mints a project-scoped key on the LiteLLM proxy behind
the configured LLM proxy, stores it with `SecretBox` in `project_resources`, and the
executor injects `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` when the runtime
starts. The `--allow-env` allowlist is derived from the injected names, so tenant
code reads them by construction; the key is only as isolated as the project.

Minting is the platform's job and cannot move to the executor. The executor is
attached only to `data-control` and `storage-control`, both internal, so it has
no egress to the proxy at all. That isolation is deliberate — the executor holds
the Docker socket — so it only ever decrypts a key the platform already minted.
The admin credential that mints keys is therefore set on the platform service
alone, never in the shared environment block.

Rate limits are enforced by the proxy, not here. The platform never sees
inference traffic: the proxy is reachable directly and runtimes call it
over 443. All the platform does is store the limits, as `llm_rpm_max` and
`llm_tpm_max` on `projects` next to the byte quotas, and pass them at issuance;
the proxy answers `429` once a project exceeds them. Requests per minute bounds a
hot loop, tokens per minute bounds actual work, since one long generation can
cost more than many short ones.

Keys are issued with a fixed TTL (`LLM_KEY_DURATION`, 90 days by default) rather
than renewed in the background, because the platform runs no scheduler. Since
credentials are injected at cold start, a running function keeps its key until it
restarts, so the executor logs an explicit expiry error into the project's own
logs rather than letting an expired key surface as an opaque upstream 401. A key
is revoked when deletion is requested — not at purge — so a project in its
grace window stops holding a share of shared capacity; restoring it mints a new
one.

## Site authentication

Control-plane cookies are host-only for `sites.example.org`. An owner-only app
redirects there, receives a short-lived one-time ticket, and exchanges it on
its app hostname for a second host-only site cookie. App code never receives
either platform cookie.

Previews are always owner-only. `network` production sites do not require a
visitor login, but Caddy authenticates its gateway hop and the gateway verifies
the forwarded visitor address against `NETWORK_CIDRS`. Caddy also binds only
to `LAN_BIND_IP`.

## The showcase tier

`access_mode` is a ladder of three: `owner`, `network`, `showcase`. The third is
`network` plus a card in the gallery on the dashboard, so it is reachable by the
same people and advertised to them. It is a third value on the existing column
rather than a flag beside it because a flag admits a state the ladder cannot —
an owner-only project listed on everyone's home page.

Everything that asks whether a site is reachable therefore tests `<> 'owner'`
rather than `= 'network'`, through `isNetworkReachable`. Written the other way,
a tier added above `showcase` later would silently make every site under it
either owner-only or exempt from the network check. `requiresOwnerSession` in
the gateway is the single place that decision is made.

Listing needs a deployed version and one line from the owner. A `capture_showcase`
job then renders the live page in the same Playwright container a preview uses,
keeps a viewport-sized screenshot — not the full-page shot a preview takes,
because a card is a fixed rectangle — and asks the control plane to draft a
description from the page's own text.

That draft is where the interesting property is. A site review reads a hostile
page and produces a verdict the model may only ever raise, so a page that
manipulates the reviewer lands on the static floor. A description has no such
floor: a sentence has no safe default, and the page it is summarising was
written by the person asking to be advertised to everyone else. So the draft is
stored in `showcase_draft`, the gallery reads only `showcase_description`, and
the only thing that writes that second column is an owner supplying the text.
The containment is the two columns and the two separate calls, never the prompt.

The gallery has two readers and they are reached differently. A signed-in
account reads `GET /v1/showcase` on the dashboard origin. A logged-out visitor
cannot, because publishing it there would put internal project names and
screenshots on the open internet — the dashboard is the one surface the tunnel
exposes.

A network test on that origin cannot help, and this is the fact the design turns
on: `sites.example.org` resolves to Cloudflare from inside the network as well
as outside it, with no split-horizon record, so every request arrives through
the tunnel and the control plane sees a public egress address. It cannot tell a
person on the LAN from a stranger.

`*.sites.example.org` resolves, publicly, to `LAN_BIND_IP` — an address that
does not route from the internet. So the logged-out gallery is served on
`showcase.sites.example.org`, by the control plane rather than the gateway, and
the dashboard embeds it in an iframe. On the network the frame loads; anywhere
else it never resolves and the section stays hidden.

The iframe is how the page finds out, and it is not the control. The data is
served only on that host, which is absent from the tunnel, reachable only
through Caddy on `LAN_BIND_IP`, verified by the edge token, and checked against
`NETWORK_CIDRS`. A check in the page would have been decoration, since anyone
could read the endpoint behind it. `showcase` is a reserved slug for the same
reason: a project of that name would take the hostname from under the gallery.

One consequence worth stating: this is the only place a site review verdict has
any effect. A project whose latest review is `urgent` is not rendered in the
gallery. It is not taken down and it stays reachable at its own hostname — the
rule that a model's opinion must never take a site down still holds — but the
platform declines to put it on every other user's home page. Declining to
promote is not the same as blocking.

## Execution

- Build: 1 GiB, 1 CPU, five minutes, a 768 MiB workspace, one concurrent job.
- Function: 256 MiB, 0.25 CPU, 128 PIDs, 60-second request.
- Both: read-only root, dropped capabilities, bounded local logs, and no Docker
  socket. Builds see source read-only and return only their declared output.
- Functions sleep after 15 minutes without API traffic and cold-start
  transparently.
- Runtime egress permits the operator-selected public/intranet policy. The
  host firewall must deny peer project bridges, metadata, SMTP, Docker, and
  platform/host administration endpoints.
- Private preview rendering runs non-root on an internal renderer network.
  External HTTPS assets use the same public-only proxy; render credentials are
  injected only for the gateway origin.

Docker is the v1 executor. Its interface and job descriptors are deliberately
orchestrator-neutral so k3s can replace it when the platform needs a second
node, HA, or more than the tested single-host concurrency.
