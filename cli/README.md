# `ritsdev` CLI

CLI for projects hosted by a [create-ritsdev](https://github.com/uetuluk/create-public)
platform. It is not tied to one installation: download it from your platform's
`/cli` endpoint and it points back at that platform, or pass `--server` /
`RITSDEV_SERVER` to say which one you mean.

```sh
curl -fsSL https://<your platform>/cli -o ritsdev && chmod +x ritsdev
./ritsdev login

# or from npm, naming the platform yourself
npx @uetuluk/create-cli --server https://<your platform> login
npx @uetuluk/create-cli create my-site --access owner
npx @uetuluk/create-cli deploy my-site .
```

Authentication uses a scoped personal token created in your platform's
dashboard. The token is stored with owner-only permissions under
`~/.config/ritsdev/credentials.json`.

Commands:

- `login`, `logout`, `whoami`
- `create`, `list`, `status`, `access`, `delete`, `restore`
- `secrets`
- `push`, `deploy`, `versions`, `deploy-version`
- `logs`, `render`

`deploy` creates a gzip tar archive while excluding `.git`, `node_modules`,
`.env*`, and `.DS_Store`, uploads it, waits for the immutable build version,
and waits for production activation.

Use `ritsdev secrets <slug> NAME=value` to set a write-only runtime secret and
`ritsdev secrets <slug> NAME-` to delete one.
