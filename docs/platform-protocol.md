# Public protocol

## Authentication

Google login is open to verified accounts in `AUTH_ALLOWED_EMAIL_DOMAINS`. REST accepts the
host-only dashboard session or `Authorization: Bearer <token>`. MCP always
requires a bearer OAuth access token or personal token.

OAuth endpoints:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/jwks.json`
- `POST /oauth/register`
- `GET /oauth/authorize`
- `POST /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/revoke`

Authorization code requests require PKCE `S256` and the resource
`https://sites.example.org/mcp`. The GET displays the registered client,
redirect host, and requested scopes; a short-lived server-side request token
binds the user's explicit POST approval.

Scopes are `sites:read`, `sites:write`, `deployments:write`, `logs:read`, and
`database:read`. The first four are the implicit default for an authorization
request that names no scope and for a personal token created without an
explicit list. `database:read` is deliberately outside that default: it must be
requested by name, so adding it did not grant it to every existing client.
Personal access tokens can only be listed, created, or revoked with an
interactive dashboard session; delegated bearer tokens cannot mint stronger
credentials.

## REST

All project paths are under `/v1/projects`.

- `GET /v1/me`
- `GET|POST /v1/projects`
- `GET /v1/projects/:slug`
- `PATCH /v1/projects/:slug/access`
- `PUT /v1/projects/:slug/showcase`
- `PUT /v1/projects/:slug/showcase/screenshot`
- `POST /v1/projects/:slug/resources`
- `PUT /v1/projects/:slug/secrets`
- `POST /v1/projects/:slug/sources`
- `GET|POST /v1/projects/:slug/versions`
- `GET /v1/projects/:slug/versions/:version`
- `POST /v1/projects/:slug/versions/:version/render`
- `POST /v1/projects/:slug/versions/:version/probe`
- `POST /v1/projects/:slug/deployments`
- `GET /v1/projects/:slug/deployments/:deployment`
- `GET /v1/projects/:slug/analytics`
- `GET /v1/projects/:slug/logs`
- `POST /v1/projects/:slug/database/exports`
- `GET /v1/projects/:slug/database/exports/:jobId/download`
- `DELETE /v1/projects/:slug`
- `POST /v1/projects/:slug/restore`
- `GET|POST /v1/tokens`
- `DELETE /v1/tokens/:id`

The operator API is its own family. Reads need `platform_role = 'operator'`;
the two `PATCH` routes need `superadmin`, and the tier is re-read from the
control database on every request rather than taken from the caller's token:

- `GET /v1/admin/overview|projects|accounts|jobs|audit`
- `PATCH /v1/admin/accounts/:id` — `{projectQuota?, role?}`
- `PATCH /v1/admin/projects/:slug` — `{runtimeMemoryMiB?, runtimeCpu?, postgresBytes?, objectBytes?, versions?}`

Both PATCH routes reject unknown fields with `400` and audit the previous value
alongside the new one. `role` accepts `user` and `operator` only: `superadmin`
is granted by `PLATFORM_SUPERADMIN_EMAILS` on the host, and the API refuses both
to mint one and to demote one. A project PATCH answers with `runtimeRecycled`,
true when the change required a running runtime to be restarted.

The gallery is its own path family, because nothing under it is scoped to a
project the caller owns:

- `GET /v1/showcase`
- `GET /v1/showcase/:slug/screenshot.png`

Both require a signed-in session or a bearer token with `sites:read`. The
dashboard is the platform's one public surface while the sites themselves
resolve only on the internal network, so an unauthenticated gallery would put
internal project names and screenshots in front of the open internet.

Logged-out visitors read the same gallery from `showcase.sites.example.org`,
which the dashboard embeds in an iframe. That hostname resolves to a private
address and is absent from the tunnel, so it answers on the private network and
nowhere else; the route additionally requires Caddy's edge token and checks the
visitor against `NETWORK_CIDRS`. `showcase` is a reserved slug for that reason.
See docs/operations.md.

Accounts holding `platform_role = 'operator'` may additionally read the
platform-wide state. These paths are read-only and have no mutating verb:

- `GET /v1/admin/overview`
- `GET /v1/admin/projects`
- `GET /v1/admin/accounts`
- `GET /v1/admin/jobs?limit=`
- `GET /v1/admin/audit?limit=`

`limit` is clamped to 200. The role is re-read from the control database on
every request rather than trusted from the session or access token. The
browser view over the same data is served at `/admin`.

Direct source upload uses `application/gzip`, has a 25 MiB compressed limit,
and may include `X-Content-Sha256`. MCP source uploads use ordered base64
chunks of at most 512 KiB decoded; 256 KiB is recommended, because shorter
blocks transcribe more reliably. A chunk may carry its own `sha256`, checked
before anything is stored, and re-sending an earlier `chunkIndex` replaces that
chunk — so a single corrupted chunk costs one call, not the whole archive.

`POST /v1/projects/:slug/resources` adds `postgres`, `storage`, or `llm` to an
existing project; resources cannot be removed. Provisioning is asynchronous, and
`resources.provisionState` on the project reports `pending`, `ready`, or
`failed`. Adding `llm` mints the key immediately and returns `503` on a
deployment with no LLM admin credential, exactly as `POST /v1/projects` does;
asking for a binding the project already holds does not re-mint it.

The database export endpoint returns the schema inline for
`{"include":"schema"}` and, for `{"include":"all"}`, a download URL and never
the bytes. The download route requires the caller's own credentials; the URL
carries no capability, and exports expire after an hour.

`PATCH /v1/projects/:slug/access` accepts `owner`, `network`, and `showcase`.
The three are a ladder: each is reachable by everyone the one before it was,
plus more. `showcase` is `network` plus a card in the dashboard gallery, and it
returns `409` on a project with no `showcase_description` — a gallery of bare
slugs helps nobody, and the owner is the only person who can say what their app
is for. Entering `showcase` queues a site review and a screenshot capture;
leaving it deletes the screenshot and keeps the description, so re-listing does
not mean retyping it. `POST /v1/projects` deliberately does not accept
`showcase`: a project that does not exist yet has nothing to show.

`PUT /v1/projects/:slug/showcase` takes `{"description": "..."}`, at most 200
characters after whitespace is collapsed. `PUT
/v1/projects/:slug/showcase/screenshot` takes a raw `image/png` body up to 2
MiB, checked by magic bytes rather than by the declared content type. An
uploaded screenshot is recorded as such and is never replaced by a later
automatic capture.

`POST /v1/projects` accepts `postgres` and `storage`, which default to true, and
`llm`, which defaults to false because inference runs on shared hardware. A
project created with `llm` receives `LLM_BASE_URL`, `LLM_API_KEY`, and
`LLM_MODEL` in its function environment, and its manifest must declare
`resources.llm` to build. Asking for it on a deployment with no LLM admin
credential configured returns `503`.

Secret values are write-only. Sending `null` for a secret name deletes it.
Project deletion requires
`{"confirmation":"<slug>"}` and schedules purge after seven days.

## MCP

`POST /mcp` implements JSON-response Streamable HTTP. Stable tools:

- `list_projects`, `get_project`, `create_project`
- `update_project_access`, `set_project_secrets`
- `begin_source_upload`, `upload_source_chunk`, `complete_source_upload`
- `get_source_upload`, `abort_source_upload`
- `create_version`, `list_versions`, `get_version`
- `deploy_version`, `get_deployment`, `get_logs`, `get_analytics`,
  `render_version`, `probe_version`, `delete_project`, `restore_project`
- `enable_project_resources`, `export_database`, `get_skill`
- `list_showcase`, `get_showcase_draft`, `set_showcase_listing`,
  `set_showcase_screenshot`

`GET /v1/projects/:slug/analytics` and `get_analytics` answer with `views`,
`visitors`, `apiRequests`, and a zero-filled `daily` series over `days` (1-30,
default 30). Days are campus-local calendar days. Only page navigations are
counted, so a single-page app reports the load that began a session rather than
the client-side routes after it, and an owner's own visits to their own
`network` or `showcase` site count like anyone else's. The distinct-visitor
figure is owner-only; the gallery publishes page loads alone.

`create_project` and `enable_project_resources` carry the same three resource
flags as the REST routes, with the same defaults: `postgres` and `storage` true,
`llm` false. `get_project` reports all three under `resources`.

`DELETE /v1/projects/:slug` takes `{"confirmation": "<slug>"}` and answers `202`
with `deletedAt`, `purgeAfter`, and `immediate`. `purgeAfter` is seven days out
and `restore` cancels it until then. Adding `"immediate": true` — or the
`immediate` argument to `delete_project` — brings the purge to now and answers
with `immediate: true`; there is no recovery window. It is refused with `403`
unless the caller holds `platform_role = 'operator'` in the control database at
the time of the call *and* owns the project, both checked independently of the
role the caller's token carries.

The server also implements `resources/list` and `resources/read`, advertising
the `resources` capability when the repository mount is present. They expose an
allowlist of the platform's own documentation — the skill and the site contract
— under their real public URLs, so an MCP client can read the contract it is
expected to follow. `get_skill` returns the same text for clients that consume
tools only.

`update_project_access` carries all three tiers. `list_showcase` browses what
other people have shared and is the one tool that returns projects the caller
does not own; it reports a slug, a URL, the owner's description and the owner's
name, and nothing else.

`get_showcase_draft` and `set_showcase_listing` are separate tools on purpose,
and no argument joins them. The draft is written by a model that read the
project's own page — a page written by the person asking to be advertised — so
the only thing between that text and every other user's home page is that
publishing it requires a person to have supplied it. An argument that copied the
draft across in one call would remove exactly that step. `set_showcase_listing`
therefore takes the text and nothing else.

`set_showcase_screenshot` takes a base64 PNG capped at 512 KiB decoded, because
the `/mcp` body limit is one mebibyte and base64 costs a third more than the
bytes it carries. Larger images go over REST.

`probe_version` performs one HTTP request against a version's private host and
returns status, headers, and body. The caller supplies a path, never a host, so
it cannot be aimed at anything other than the version named. It wakes the
runtime first, as `render_version` does.

Build and deployment requests accept idempotency keys. Every tool returns both
text JSON and structured content. `render_version` returns native MCP image
content plus browser console/status diagnostics when the private executor
finishes within the request window. Callers may retry the same render request
while it is queued; render files expire after 24 hours.
