# Architecture decisions

## Shared cluster, separate databases

The platform uses one PostgreSQL 16 server containing one logical database per
project. A single database with per-project schemas was rejected because
database-level connect permissions, backup/restore, deletion, and usage
measurement are clearer and safer. A PostgreSQL server/container per app was
rejected for the pilot because its memory and operational cost would dominate
the two-core host.

Every database has:

- A migration owner capable of DDL.
- A runtime login with no DDL and five connections.
- A separately granted write role, which can be revoked at the quota boundary
  while retaining reads.

## No full Supabase stack

Self-hosted Supabase represents one project and does not provide the hosted
multi-project management plane. Running the complete stack per site would
consume too much memory. PostgreSQL and standard S3 bindings preserve the
option to add PostgREST, Auth, or Realtime later without imposing them now.

## RustFS pilot

The archived upstream MinIO server is not used for new deployment. RustFS is
pinned for the pilot and accessed using standard S3/mc operations. Open
registration is blocked until bucket policy, access-key isolation, quota,
multipart, restart, and restore tests pass. The executor's S3-compatible
contract allows Garage to replace it without changing projects.

## Docker before k3s

The current host has two CPUs and 7.5 GiB RAM. Hardened Docker preserves more
capacity than a single-node k3s control plane. Job, runtime, and storage
interfaces avoid Docker-specific public APIs. Move to k3s when a second node,
HA, or measured active-runtime capacity requires it.

## Forward-only database migrations

Each lexically ordered SQL file is checksummed and applied once in its own
transaction. Deployment activation follows successful migration. Code rollback
does not reverse schema changes, so migrations must use expand/contract
compatibility.

Migration files have a 60-second statement timeout, five-second lock timeout,
64 MiB temporary-file limit, ten-minute set deadline, and a transactional
database-size check. The shared-cluster quota remains a soft operational limit;
host free-space monitoring is still a launch gate.

## Isolated egress and tenant networks

Every function project gets a distinct Docker bridge. Gateway requests also
carry a per-runtime secret, so a compromised project cannot call another
project's handler even if a host firewall rule regresses.

Build and render networks are internal. Their only outbound path is a small
CONNECT proxy that resolves the target itself, rejects private, reserved,
link-local, and metadata addresses, and permits only public TCP/443. Function
egress remains policy-driven and must be enforced by the target host firewall.

## The operator view reads samples, not the Docker socket

The system admin view needs live memory and CPU for tenant runtimes, but the
control plane deliberately has no Docker socket, no host mount, and runs
read-only with every capability dropped. Handing it a socket to render a
dashboard would give the one public-facing service the ability to start
containers on the host — the single largest privilege in the deployment — in
exchange for a display.

The executor already holds the socket and already wakes once a minute for
housekeeping. It now also samples `docker stats` for running runtimes plus host
memory, load, and data-volume use, and writes the latest reading to
`runtime_samples`/`host_samples`. The operator API is then a plain read of the
control database, and the resource figures are at most one housekeeping pass
stale — which is the same freshness the usage quota enforcement already works
from.

Both tables keep only the current reading rather than a time series. Trends
belong in the monitoring stack that already alerts on host memory and queued
jobs; duplicating a retention and pruning path inside the control database to
draw graphs was not worth the cost for the pilot.

The operator role itself is read-only in this API only. It still bypasses
per-project ownership in the existing project API, so the view is a reason to
keep the operator list short, not a reason to widen it.

## Build artifacts stay on the platform filesystem

Static assets and function artifacts are written to `DATA_ROOT/artifacts` and
served by the gateway from local disk. Storing them in RustFS was considered
and deliberately not adopted for the pilot.

RustFS would decouple artifacts from a single host, which is what the k3s
trigger anticipates, and would inherit the bucket backup path that already
exists. It would also remove a whole class of POSIX permission faults: static
serving broke once because the executor runs as root while the gateway serves
as `PLATFORM_UID`, and the per-project artifact directory was mode 0700.

The blocker is the function runtime. A runtime receives its code through
`--mount type=bind,src=<artifact_path>,dst=/app,readonly`, and `DENO_DIR`
points inside that mount so `--cached-only` can resolve dependencies. An object
store cannot be bind-mounted, so functions would have to be downloaded to local
disk on every cold start, turning a roughly two-second cold start into an
unbounded transfer of the source plus the entire Deno cache.

That leaves static-in-RustFS and functions-on-disk as the only coherent split.
It is a reasonable end state, but it introduces a second artifact path, a
second cleanup path, and a gateway cache to avoid a network round trip per
asset. Revisit it together with the k3s move rather than separately, and gate
it on measured asset-serving latency.

## Function code ships in the source archive

Function entrypoints resolve from the uploaded tree, never from build output,
and the build cannot contribute a function.

The artifact's `source/` directory is simultaneously the `--cached-only`
resolution root, the target of `deno cache` at build time, and the read-only
bind mount the runtime sees at `/app`. Accepting build output there would need
a second staging tree and a second cleanup path, for something Deno's own
module resolution makes unnecessary — a function can import its dependencies
directly, so bundling buys nothing here.

The cost of the rule was that it was invisible: a build script writing
`functions/x.bundle.js` succeeded, and the deployment then failed with a Deno
"Module not found" naming a path the author could not see. The build now
refuses an entrypoint that is not in the archive and explains why.

## Database exports leave over an authenticated download

An owner can export their project database, but a full dump is never returned
inline through the API or MCP.

A schema-only export holds no tenant rows and is what an agent needs to reason
about the database, so it comes back as text. A full dump can be hundreds of
megabytes; returning it inline would put every row into the MCP client's
transcript and the model's context, and would not fit in either. It is fetched
from an authenticated route that streams from disk instead, with no capability
in the URL — a link pasted into a conversation is inert without the caller's own
credentials. Exports are deleted an hour after they are produced.

## Visit analytics is counted at the gateway, and is a time series

An owner can see how many people opened their site. The count is taken in the
gateway, from real requests, and stored as two per-day tables in the control
database.

Both halves of that contradict something already written down, so both are
argued here rather than left for a reader to find.

The first is the time series. "The operator view reads samples, not the Docker
socket" above rejected keeping one: `runtime_samples` and `host_samples` hold
only the current reading, because trends belonged in the monitoring stack and a
retention and pruning path inside the control database was not worth the cost.
That reasoning still holds for what it covered. It does not reach this, for
three reasons. Those samples are operator telemetry with a consumer that already
existed; this is a product feature whose consumer is the owner, and there is
nowhere else it could live. Those samples are taken continuously per runtime;
this is bounded at one row per project per day and one per distinct visitor per
day, so it does not grow with traffic. And a graph was the whole of the benefit
there, where here the trend is the thing being asked for.

The second is the hot-path write. `lib/metrics.ts` says no instrumentation was
added to hot paths, and every platform metric is still derived from tables
written for some other reason. A visit is not written down anywhere, so it
cannot be derived: Caddy's access log is rolled at 10 MB and read by nothing,
and the gateway's request log goes to a capped stdout. Counting it is the only
way to have it.

What makes that acceptable is that the write is not on the path. It is issued
without being awaited, so the response is not delayed; it cannot throw into the
handler, so a control-database fault cannot fail a static page; and it is
skipped entirely whenever a connection is already being queued for, so it
yields to cold starts rather than competing with them. The gateway already
writes per request in three other places — `project_runtime.last_seen_at` on
every proxied call, the login ticket exchange, and the cold-start enqueue — so
this is not a new kind of thing for that process, only a new reason.

Ingesting Caddy's log was the alternative and was rejected. Caddy cannot count
per site by itself: its Prometheus metrics omit the Host label deliberately, to
avoid the cardinality a per-vhost counter would create. So it would have meant a
log tailer with a rotation-safe checkpoint, a new bind mount, and a failure mode
that undercounts silently whenever the reader falls behind a log that keeps only
30 MB. That is more moving parts than the write it replaces, and it fails
quietly where the write fails loudly.

Two properties are worth stating because they are what make the numbers mean
anything. Only a navigation is counted — `sec-fetch-dest: document`, not merely
an HTML content type — because the SPA fallback serves `index.html` for every
missing path, so counting content types would inflate each project by however
many missing files its own HTML asks for. And a project cannot inflate itself:
the gateway refuses any peer inside the runtime pool before routing, so a
tenant container cannot loop back through it.

The visitor pseudonym is obfuscation with a secret, not anonymisation. It is an
HMAC over the address and user agent, and the address space is small enough to
enumerate, so anyone holding the key can reverse it — and anyone holding that
key already holds every project's database password. It is per project, so it
cannot follow anyone between projects, it never leaves the database, and it is
pruned well before the counts beside it. Retention is the control; the hash is
not.
