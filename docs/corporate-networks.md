# Corporate networks

`login` and `submit` are the only commands that talk to the network.
`scan` never does, including behind a proxy.

If device-flow login fails at connect, you are usually missing one of
three things: the proxy env vars, the corporate CA, or both. The CLI
will name the failure class (`connection refused`, `could not verify TLS
certificate`, `proxy required`) without echoing headers, bodies, or
Node's error text — those can contain tokens.

## Proxy env vars

Node's built-in `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY`. This CLI
attaches undici's `EnvHttpProxyAgent` only when one of these is set:

- `HTTP_PROXY` / `http_proxy`
- `HTTPS_PROXY` / `https_proxy`

`NO_PROXY` / `no_proxy` do **not** attach the agent. They are read by
the agent after it exists: hosts that must bypass the proxy, typically
`localhost` and your internal git host.

Example:

```bash
export HTTPS_PROXY=http://proxy.corp.example:8080
export NO_PROXY=localhost,127.0.0.1,.corp.example
npx redential login
```

Leave the HTTP(S)_PROXY vars unset on a direct network — the client
then uses the same dispatcher-less `fetch` as a machine with no proxy.

A `407` HTTP response, or a CONNECT tunnel that is not 200 (undici
surfaces that as `UND_ERR_ABORTED`), prints `proxy required`. That
usually means the env var is missing, the URL is wrong, or the proxy
wants authentication the CLI does not prompt for — set the vars your
IT docs specify; do not paste a password into an issue. TLS through
the proxy failing (`UND_ERR_PRX_TLS`) uses the certificate message
below, not this one.

## Corporate CA (`NODE_EXTRA_CA_CERTS`)

TLS-intercepting proxies re-sign HTTPS with a company CA. Node does not
use the OS trust store the way a browser does. Point it at the PEM your
IT already installed:

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-root.pem
npx redential login
```

The path is an example. Use whatever file your IT documents. Without it,
login fails with `could not verify TLS certificate (corporate proxy? see
docs/corporate-networks.md)` — not a Redential outage.

## `submit`'s visibility probe vs a captive proxy

Before upload, `submit` may HEAD the git remote — **only** for remotes
that look like github.com / gitlab.com / bitbucket.org, never an
arbitrary self-hosted URL, never with your credentials. A confirmed
`2xx`/`3xx` blocks submit (the repo answered as publicly reachable).
Anything else, including a network error, is fail-open.

A captive corporate proxy that answers **200 for every host** will make
that probe look like "public." The CLI will refuse to submit and tell
you to connect the GitHub App instead. If the repo is actually private,
the check was wrong — that is the proxy lying, not a leak: the probe is
unauthenticated HEAD, and nothing from your bundle has been sent yet.
Workarounds: add the git host to `NO_PROXY` so the probe reaches the
real origin, or report the false block if you are on a known-public
host that is in fact private.

`headRequest` stays fail-open (`null` on error). A proxy that **times
out** or **refuses** the probe does not block submit; you get scan's
existing public-host warning and may proceed.
