# Deploying your own

This platform is one Docker Compose stack. Everything specific to an
installation lives in `deploy/.env`; nothing else needs editing to run your own.

Throughout, `sites.example.org` stands for whatever you set `GATEWAY_DOMAIN` to.

## What you need first

- A Linux host with Docker and Compose v2, and a non-root account to run as.
- **A domain you control, plus the wildcard under it.** Both `sites.example.org`
  and `*.sites.example.org` must resolve. The wildcard points at a *private*
  address — see [Network shape](#network-shape).
- **A Cloudflare account holding that domain's DNS.** This is a hard dependency
  today, not a preference: `deploy/Caddyfile` gets its certificates by DNS-01
  through the `caddy-dns/cloudflare` module, which is the only way to get a
  certificate for a wildcard whose address is unreachable from the internet.
  Using another DNS provider means swapping that module in
  `deploy/caddy/Dockerfile` and the `dns` directive in the Caddyfile.
- A Google OAuth client, for sign-in.
- Optionally, an OpenAI-compatible LLM endpoint. Without one the platform runs
  fine and simply cannot offer the LLM binding, the model-assisted site review,
  or drafted showcase descriptions.

## Network shape

The split is the whole design, and it is worth understanding before you point
DNS anywhere.

- **The apex** (`sites.example.org`) is the control plane: dashboard, OAuth,
  REST, MCP. It is the only thing published to the internet, through a
  Cloudflare Tunnel that connects straight to the platform container.
- **The wildcard** (`*.sites.example.org`) is where deployed projects live. Its
  public DNS record points at `LAN_BIND_IP`, a private address. From inside your
  network it resolves and Caddy answers; from the internet it is simply
  unroutable.

Never add the wildcard to the tunnel. That single record is what keeps every
deployed project inside your network.

## Configure

```sh
cp deploy/.env.example deploy/.env
```

Then work through it. The variables with no default will stop the stack from
starting until you set them, which is deliberate — each one is a value that
cannot be guessed and whose wrong answer is silent rather than loud:

| Variable | Why it has no default |
|---|---|
| `GATEWAY_DOMAIN` | A default would put another installation's name in your links, mail headers, and health probes without erroring. |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Who may sign in. Set `AUTH_ALLOW_ANY_GOOGLE_DOMAIN=1` instead to admit any Google account — an open installation should be a decision, not a fallback. |
| `ANALYTICS_TIMEZONE` | Days are bucketed in this zone. A UTC default would silently re-bucket every day by your offset and make old rows incomparable with new ones. |
| `ACME_EMAIL` | Where Let's Encrypt writes about your certificates. |
| `MAIL_HELO_NAME`, `ALERT_FROM` | Alert mail has to announce a name whose forward and reverse DNS you own, which is rarely the public domain. |

Two more worth setting deliberately:

- `SITE_REVIEW_IMPERSONATION_TERMS` — your organisation's name and whatever it
  calls its accounts. These are *added* to a built-in list of shared brands
  (Google, Microsoft, Outlook, Duo), never substituted for it, so leaving them
  empty costs you local coverage but cannot switch the review off.
- `MAX_ACCESS_MODE` — leave at `showcase` on a private network. Set it to
  `owner` if you open sign-ups to anyone: projects stay visible only to their
  own owner and the gallery empties, while operator accounts keep the full
  ladder so you can still publish examples yourself.

## Start it

```sh
./deploy/scripts/bootstrap.sh
```

If a required variable is missing, Compose refuses to start and names it. That
is the intended behaviour — a stack that starts half-configured is harder to
diagnose than one that does not start.

## Check it

```sh
RITSDEV_URL=https://sites.example.org ./deploy/scripts/conformance.sh
```

Then confirm the network split really holds, which is the one thing a check run
from inside your network cannot tell you:

```sh
RITSDEV_DOMAIN=sites.example.org ./deploy/scripts/gate-offnetwork-wildcard.sh
```

Read that script's header before trusting a result. Establishing "unreachable
from the internet" from a machine on the trusted network is harder than it
looks, and it documents two ways of getting it wrong that both look like
success.

## Day-to-day

[docs/operations.md](operations.md) covers backups, upgrades, quotas, the
operator and superadmin roles, alerting, and what to do when something breaks.
[docs/platform-design.md](platform-design.md) explains why the pieces are
arranged this way.
