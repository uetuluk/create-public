# Security

## Reporting

Report suspected vulnerabilities privately through
[GitHub's private advisory form](https://github.com/uetuluk/create-public/security/advisories/new)
rather than a public issue. Please include what you did, what happened, and what
you expected instead.

This is a small project without a funded response team. Expect an
acknowledgement within a week, and please allow reasonable time for a fix before
disclosing.

## What this platform assumes

Anyone deploying this should know which properties it is relying on, because
several are enforced by DNS and network layout rather than by code:

- **The wildcard is not routable from the internet.** `*.<your domain>` resolves
  publicly to a private address, and the Cloudflare Tunnel publishes the apex
  only. Adding the wildcard to the tunnel exposes every hosted project. The
  `network` and `showcase` access tiers assume this and check `NETWORK_CIDRS` on
  top of it, not instead of it.
- **Tenant code is hostile by default.** Runtimes get per-project Docker
  networks, no host workspace, and egress only through the build proxy. The
  executor holds the Docker socket and deliberately has no egress at all.
- **Site review is a floor, not a filter.** The static signals run without a
  model and cannot be argued out of a verdict by the page under review.
  Configured impersonation terms are added to the built-in list and can never
  replace it, so misconfiguration weakens local coverage but cannot switch
  review off.
- **An installation open to sign-ups is a different threat model.** Project
  creation, builds and LLM key minting are not rate-limited. If you set
  `AUTH_ALLOW_ANY_GOOGLE_DOMAIN=1`, put a rate limit in front of the control
  plane and consider `MAX_ACCESS_MODE=owner`.

## Secrets

`deploy/.env` and anything matching `deploy/.env*` are ignored by git, with
`.env.example` the single reviewed exception. Session, encryption and edge-proxy
secrets must be independent of one another; the platform refuses to start if the
first two are equal, and refuses secrets under 32 bytes.
