# Trying it out

Running the platform locally, from published images, without building anything.

This is for seeing how it works. It is not a deployment guide — see
[deploying-your-own.md](deploying-your-own.md) for that, and expect to care
about DNS, certificates and backups there.

## What you need

Docker with Compose v2, and about 3 GB of memory free. Nothing else: the three
images this repository builds are published to GHCR, and everything else in the
stack was already a public image.

## Point at the published images

```sh
cp deploy/.env.example deploy/.env
```

Add these to `deploy/.env`, substituting the version you want:

```sh
PLATFORM_IMAGE=ghcr.io/uetuluk/create-public/platform:latest
CADDY_IMAGE=ghcr.io/uetuluk/create-public/caddy:latest
RENDER_IMAGE=ghcr.io/uetuluk/create-public/render:latest
# The executor spawns the renderer by name at runtime, so this one is read by
# the code rather than by compose, and has to agree with RENDER_IMAGE above.
PLAYWRIGHT_IMAGE=ghcr.io/uetuluk/create-public/render:latest
```

Prefer a real version tag over `latest` for anything you intend to keep.

## Fill in the values that have no default

The stack refuses to start until these are set, because each is a value whose
wrong answer would be silent rather than loud. For a local trial they can be
anything sensible:

```sh
GATEWAY_DOMAIN=sites.localhost
ANALYTICS_TIMEZONE=UTC
AUTH_ALLOWED_EMAIL_DOMAINS=example.test
ACME_EMAIL=you@example.test
LAN_BIND_IP=127.0.0.1
DATA_HOST_ROOT=/absolute/path/to/a/data/directory
```

Generate the secrets rather than inventing them — the platform refuses any
under 32 bytes, and refuses to let the session and encryption secrets be equal:

```sh
for name in POSTGRES_PASSWORD RUSTFS_SECRET_KEY PLATFORM_SESSION_SECRET \
            SECRET_ENCRYPTION_KEY EDGE_PROXY_SECRET; do
  echo "$name=$(openssl rand -hex 32)"
done >> deploy/.env
```

## Start it

```sh
cd deploy
docker compose -f compose.yaml -f compose.local.yaml up -d --no-build
```

`--no-build` is the point: it fails loudly if an image is missing rather than
quietly building one, so you know you are running what was published.

`compose.local.yaml` takes Caddy out of the path — it cannot issue a certificate
without a real domain and a Cloudflare zone — and publishes the control plane on
`127.0.0.1:3000` and the site gateway on `127.0.0.1:3001` instead. Loopback
only, so nothing is offered to the network your machine is on.

Every isolation boundary is unchanged: per-project networks, the executor's
missing egress, the build proxy and the site review all behave as they do in a
real deployment. A trial that switched those off would be showing you something
else.

## What you can do with it

Sign-in needs a Google OAuth client, which is more setup than a trial deserves.
For a look around without one, set:

```sh
AUTH_DEV_BYPASS=1
```

and authenticate with a POST to `/auth/dev` carrying any address at your
`AUTH_ALLOWED_EMAIL_DOMAINS` domain. **This is a development door and must never
be set on anything reachable by other people** — it grants a session to anyone
who names an address.

```sh
curl -X POST http://127.0.0.1:3000/auth/dev \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.test","name":"You"}' -c cookies.txt
```

From there the CLI is the fastest path:

```sh
curl -fsSL http://127.0.0.1:3000/cli -o ritsdev && chmod +x ritsdev
./ritsdev create my-site
./ritsdev deploy my-site ./some-project
```

The downloaded binary already knows which platform served it, because the `/cli`
endpoint stamps its own origin into what it hands you.

A deployed site is addressed by Host header, and a laptop has no wildcard DNS,
so reaching one means saying which:

```sh
curl -H 'Host: my-site.sites.localhost' http://127.0.0.1:3001/
```

## Stopping

```sh
docker compose down            # keeps the data directory
docker compose down -v         # also drops the volumes
```

The data directory named by `DATA_HOST_ROOT` is a bind mount and outlives both;
remove it by hand when you are done.
