# Site contract

## Manifest

```json
{
  "schemaVersion": 1,
  "build": {
    "command": "npm run build",
    "output": "dist",
    "spa": true,
    "install": false
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
    "storage": true,
    "llm": false
  }
}
```

- At least `build` or `functions` is required.
- Paths are project-relative and may not contain `..`.
- Build output must be a subdirectory, not the project root. A site with no
  build tooling still needs a command that populates it, for example
  `{"command": "mkdir -p dist && cp -r public/. dist/", "output": "dist"}`.
- `build.install` controls the install step. Omit it and `npm ci` runs whenever
  a root `package.json` exists, which requires a committed `package-lock.json`.
  Set it to a string to run that command instead, or to `false` to install
  nothing — in either case the lockfile is no longer required.
- `database` requires `resources.postgres: true`, and the reverse is also
  checked: shipping a `migrations` directory with no `database` block fails the
  build rather than silently never applying it.
- `resources.llm` declares the managed LLM binding, and is checked the same way
  at build time: a manifest asking for it on a project created without it fails
  the build. It is an assertion, not a switch — the binding itself is a
  property of the project, not of the manifest.
- Static sites may omit functions, database, and unused resources.
- A resource can be added after the project exists with
  `enable_project_resources` (`POST /v1/projects/<slug>/resources`, or
  `ritsdev resources <slug> --postgres|--storage|--llm`). Resources cannot be
  removed. A running runtime keeps the environment it started with, so rebuild
  and redeploy afterwards — for the LLM binding that rebuild is mandatory
  anyway, because the manifest has to start declaring `resources.llm`.

## Function code ships in the archive

The function entrypoint is resolved from the source tree you upload, never from
build output. The build runs in a copy of the tree and only `build.output`
survives it, as static assets — so a build step that generates or bundles a
function produces a file the runtime will never see, and the build fails with a
message saying so. Ship the entrypoint and everything it statically imports in
the archive.

## Functions

Export a Fetch-compatible handler:

```ts
export default {
  async fetch(request: Request): Promise<Response> {
    return Response.json({path: new URL(request.url).pathname})
  },
}
```

All function routes retain the `/api` prefix. Requests time out after 60
seconds. The runtime does not grant subprocess or FFI permissions.

### Dependencies must be cached at build time

The runtime starts with `deno run --cached-only`, and the dependency graph is
cached during the build. Use static top-level imports with literal specifiers.
A dynamic `import()` whose specifier is not statically analysable will not be
cached and fails at runtime.

### The environment allowlist is exact

`--allow-env` grants only the binding names listed below, plus `PORT`,
`DENO_DIR`, `HOME`, and **every project secret you have declared** — declaring a
secret with `set_project_secrets` is what adds its name to the allowlist.
Reading any other variable throws.

The allowlist is built from the variables actually injected, so a binding name
is granted only while the project holds that resource: `DATABASE_URL` without
PostgreSQL, or `LLM_API_KEY` without the LLM binding, throws exactly like an
undeclared name.

A throw at module scope kills the isolate before it can serve anything. Read
tuning variables inside a guard rather than at the top level:

```ts
function readEnv(name: string, fallback: string): string {
  try { return Deno.env.get(name) ?? fallback } catch { return fallback }
}
```

This breaks Node-compatibility database drivers that probe standard
environment variables. `npm:postgres` fails at connect time with
`Requires env access to "PGSSL"`. **Use a Deno-native driver instead:**

```ts
import {Pool} from "jsr:@db/postgres"
const pool = new Pool(Deno.env.get("DATABASE_URL"), 3, true)
```

### bigint columns do not survive JSON.stringify

`jsr:@db/postgres` returns `BIGSERIAL` and `BIGINT` columns as JavaScript
`BigInt`, and `JSON.stringify` throws `Do not know how to serialize a BigInt`.
Every first-time user of the recommended driver hits this. Either use `INT`
for keys, or coerce on the way out:

```ts
const body = JSON.stringify(rows, (_key, value) =>
  typeof value === "bigint" ? Number(value) : value)
```

Note that a write can commit before response serialization fails, so a 500 on
a POST does not mean nothing was inserted.

### Calling the managed LLM

A project holding the binding receives `LLM_BASE_URL`, `LLM_API_KEY`, and
`LLM_MODEL`, whose values depend on the platform it is deployed to — read them
from the environment rather than assuming any of them. The endpoint is
OpenAI-compatible and reachable from a runtime, and public
HTTPS is a runtime's only general egress, so a function calls it with plain
`fetch` — there is no platform proxy in the path. The three names are on the
`--allow-env` allowlist only because the platform injected them, so a project
without the binding cannot read them at all:

```ts
function binding(name: string): string {
  try { return Deno.env.get(name) ?? "" } catch { return "" }
}
const BASE = binding("LLM_BASE_URL")
const KEY = binding("LLM_API_KEY")
const MODEL = binding("LLM_MODEL")

// The proxy is shared, so a 5xx from it is usually transient: retry those
// twice with a short backoff. A 4xx is this request's own fault and will fail
// the same way however often it is sent, and a 429 is the rate limiter —
// retrying that sooner is the thing it exists to stop.
async function complete(prompt: string): Promise<Response> {
  const body = JSON.stringify({
    model: MODEL,
    // This is a reasoning model. It thinks before it answers, and the
    // thinking is charged against max_tokens. `/no_think` in the prompt is
    // what actually turns that off; the chat_template_kwargs flag below is
    // sent for good measure but is inert on this proxy. Leave headroom even so.
    messages: [{role: "user", content: `${prompt} /no_think`}],
    chat_template_kwargs: {enable_thinking: false},
    max_tokens: 1024,
  })
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {authorization: `Bearer ${KEY}`, "content-type": "application/json"},
      body,
    })
    if (response.status < 500 || attempt === 2) return response
    await response.body?.cancel()
    await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt))
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (!KEY) return Response.json({error: "no LLM binding"}, {status: 503})
    const {prompt} = await request.json()
    const upstream = await complete(prompt)
    if (upstream.status === 429) {
      return Response.json(
        {error: "rate limited", retryAfter: upstream.headers.get("retry-after")},
        {status: 429},
      )
    }
    if (!upstream.ok) return Response.json({error: "upstream failed"}, {status: 502})
    const body = await upstream.json()
    const choice = body.choices[0]
    // An empty answer with finish_reason "length" means the budget went on
    // reasoning. Treat it as a failure rather than returning a blank string.
    const text = (choice.message.content ?? "").trim()
    if (!text) {
      return Response.json(
        {error: "the model returned no content", finishReason: choice.finish_reason},
        {status: 502},
      )
    }
    return Response.json({text})
  },
}
```

The guarded read matters: without the binding, `Deno.env.get("LLM_API_KEY")`
throws rather than returning undefined, and at module scope that kills the
isolate before it serves anything.

**`LLM_MODEL` is a reasoning model, and its reasoning is charged against
`max_tokens`.** With `max_tokens: 512` — which this sample used to show — a
short prompt returns `HTTP 200`, `finish_reason: "length"`, 1799 characters of
`reasoning_content`, and **an empty `content`**. Nothing errors. An app that
reads `choices[0].message.content` and returns it looks entirely healthy while
serving blank answers, which is exactly what happened to the first author who
followed this page.

Put **`/no_think`** in the prompt to suppress the reasoning; that is the switch
that works. `chat_template_kwargs: {enable_thinking: false}` reads like the
fix and is not: measured against vllm-0.26.0, one prompt produced byte-identical
reasoning with the flag false, true, and absent — 3423 characters of it, eating
a whole 1024-token budget — while `/no_think` cut the same prompt to 2
characters and 28 tokens. Sending the flag anyway is harmless, so the sample
above does both.

Keep `max_tokens` at 1024 or more regardless, and treat an empty `content` as a
failure rather than a result. Whether a given prompt reasons at all depends on
its wording, so a version that works on the prompts you tried can still return
blanks on the ones your users type.

The retry is defensive rather than a fix for a known fault. One project's first
two completions, sent seconds after it was created, returned `HTTP 500`, and
the same requests a few minutes later returned `200`. That was seen once and
never reproduced; load on the shared proxy explains it at least as well as
anything about a new key, so do not read it as a rule that keys need warming
up. Two retries spanning about a second cost nothing while the proxy is
healthy, and are the difference between a working app and an unexplained 502
when it hiccups. Do not extend them to `429`: that limit is per minute, so
retrying into it only spends the next minute's budget as well.

The key grants `LLM_MODEL` and nothing else. Any other model name — including
the embedding and image models the same proxy serves — is refused with `403`,
so send `LLM_MODEL` through rather than hardcoding a string. Limits are 60
requests and 200 000 tokens per minute per project, enforced by the proxy;
exceeding either returns `429` with `Retry-After` (observed as 60 seconds).
Reported by `get_project` as `quota.llmRequestsPerMinute` and
`quota.llmTokensPerMinute`.

The key is a real credential on a shared proxy. It belongs to one project,
lives for 90 days, and is revoked when the project's deletion is requested —
not at purge — so restoring a project mints a new one. Never return it to a
visitor, log it, or write it into source.

Bindings:

- `DATABASE_URL`
- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_REGION`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `RITSDEV_PROJECT_ID`

### Asking the model for JSON

`LLM_MODEL` corrupts the *scaffolding* around its JSON, and only once a reply
contains more than one object. Two malformations have been seen in production,
both at `temperature: 0` and both reproducible:

- the opening quote of a key is doubled past the first object — `{""date": ...`
- the brace closing the last object is duplicated — `..."note":""}}]}`

The objects themselves come out intact every time; it is the wrapper and the
separators that break. So a one-object reply parses and a many-object reply
does not, which makes a plain `JSON.parse` look *intermittent* — it fails on
exactly the longer, more realistic inputs your users type, and sails through
everything you tried by hand.

Do not repair the quirks one at a time. That was tried here: a targeted rewrite
for the doubled quote was written, tested against a real captured reply,
deployed, and the very next real request failed on the duplicated brace
instead. Parse the objects individually instead, and the shape of the damage
stops mattering:

```ts
/** The doubled key quote, anchored on a following `key":` so a real empty
 *  string value — `"note": ""` — is never touched. */
function repairJSON(text: string): string {
  return text.replace(/([{,])\s*""([A-Za-z_][A-Za-z0-9_]*)"\s*:/g, '$1"$2":')
}

/**
 * Every balanced, flat `{...}` in the text, parsed on its own.
 *
 * String state is tracked so a brace inside a value is not read as structure,
 * and objects containing another object are skipped: that keeps the records
 * and drops the `{"entries": [...]}` wrapper they arrived in.
 */
function salvageObjects(text: string): unknown[] {
  const found: unknown[] = []
  const stack: Array<{start: number; hasChild: boolean}> = []
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (escaped) { escaped = false; continue }
    if (char === "\\" && inString) { escaped = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (inString) continue

    if (char === "{") {
      if (stack.length > 0) stack[stack.length - 1].hasChild = true
      stack.push({start: index, hasChild: false})
    } else if (char === "}" && stack.length > 0) {
      const frame = stack.pop()!
      if (frame.hasChild) continue
      const candidate = text.slice(frame.start, index + 1)
      for (const attempt of [candidate, repairJSON(candidate)]) {
        try { found.push(JSON.parse(attempt)); break } catch { /* try the repair */ }
      }
    }
  }
  return found
}

/** The records the model meant to send, however badly it wrapped them. */
export function readModelJSON(content: string): unknown[] {
  // Written as [`]{3} so the fence characters cannot close this code block.
  const text = content.replace(/^\s*[`]{3}(?:json)?/i, "").replace(/[`]{3}\s*$/, "").trim()
  for (const attempt of [text, repairJSON(text)]) {
    try {
      const whole = JSON.parse(attempt)
      if (Array.isArray(whole)) return whole
      const entries = (whole as {entries?: unknown})?.entries
      if (Array.isArray(entries)) return entries
    } catch { /* fall through to salvage */ }
  }
  return salvageObjects(text)
}
```

Validate every object you get back — with Zod, or by hand — and treat a reply
that yields nothing as a failure rather than as an empty result. Asked for
`{"entries": [...]}` the model also answers with a bare array often enough to
be worth accepting, which is why `readModelJSON` returns a list either way.

## Migrations

Put SQL files under the configured migration directory. Files run in lexical
order, once, with one transaction per file. Applied filenames and checksums are
stored in `_ritsdev_migrations`; changing an applied file fails deployment.
Each file has statement/lock/resource limits, and the complete migration set
has a ten-minute deadline.

Discovery is not recursive and the extension is case-sensitive: only `*.sql`
directly inside the configured directory is applied. A directory with no
matching file fails the build rather than applying nothing.

The runtime database role holds `USAGE` on schema `public` but not `CREATE`, so
`CREATE TABLE` from application code fails with `permission denied for schema
public`. This is deliberate: migrations are the only DDL path, which keeps
schema changes versioned, checksummed, and reversible with the deployment. A
deployment whose declared migrations cannot be applied — because PostgreSQL is
disabled, or provisioning has not finished — now fails instead of activating
over a database that has none of its tables.

Use expand/contract migrations so the current and previous application
versions can both operate while production changes.

## Testing a deployed version

App hostnames resolve only on the private network, so a remote client cannot
fetch them. Two tools reach in:

- `render_version` returns a screenshot plus the page console and errors. A
  console entry may carry a `note` field. Those are messages the render path
  provokes itself — they name an internal hostname and ask for header changes
  you do not control — kept in full and explained rather than dropped. The one
  the browser reports as an error is retyped `note`; a warning keeps its type.
  Anything still typed `error` is yours.
- `probe_version` makes one HTTP request and returns the status, headers, and
  body. You give it a path, not a URL; the host is always the version you name.

Both wake the runtime before they run, so a cold start shows up as latency
rather than a timeout.
