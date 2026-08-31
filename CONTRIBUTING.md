# Contributing

## Running the tests

```sh
cd deploy/platform
npm ci
npm run check   # tsc, no emit
npm test        # node --test; no database or network required
```

The suite runs without Postgres, without Docker, and without egress. If
something you add needs any of those to pass, that is worth reconsidering before
it is worth mocking.

## Two guards worth knowing about before they fail on you

**`deployment-neutral.test.ts`** asserts that nothing tracked names one
particular installation — a domain, an institution, a city, a personal account,
a real LAN address. This project is deployed by people other than its author,
and every one of those names has at some point been compiled into something
another installation would then have served. The failure they cause is never an
error; the platform runs and simply answers about the wrong host.

If it fails, the fix is a configuration value or a placeholder, not an addition
to the exemption list.

**`compose-env.test.ts`** asserts that every environment variable the platform
reads is enumerated in `deploy/compose.yaml`. A name this file does not list is
undefined inside the container: the code takes its fallback branch and nothing
reports it. This has happened here more than once. **Adding a `process.env` read
means adding it to `compose.yaml` in the same change.**

## Configuration

A new variable needs three things: a compose entry, a `deploy/.env.example`
entry, and a decision about its default.

Prefer no default when a wrong-but-plausible value would be silent. Several
variables here are deliberately required — `GATEWAY_DOMAIN`,
`ANALYTICS_TIMEZONE`, `AUTH_ALLOWED_EMAIL_DOMAINS` — because the alternative is
an installation that starts happily and quietly does the wrong thing. Refusing
to start is a better outcome than that, and the comments beside each say why.

## Commits

Say what changed and why the previous state was wrong. The reasoning is the part
that cannot be recovered from the diff later.

## Licence

The platform is AGPL-3.0-only; `cli/` is MIT. By contributing you agree your
contribution is licensed under the terms covering the directory it touches.
