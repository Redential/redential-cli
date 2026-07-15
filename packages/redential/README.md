# redential

This is the official bare-name alias for
[`@redential/cli`](https://www.npmjs.com/package/@redential/cli), published
by the Redential org so `npx redential scan` works without typing the scope.

The real package, source code, and provenance all live at
[`@redential/cli`](https://www.npmjs.com/package/@redential/cli) and
[github.com/Redential/redential-cli](https://github.com/Redential/redential-cli)
— this package is just a launcher that depends on it and forwards every
command.

```bash
npx redential scan
```

Same trust model as the canonical package: local-only detection, zero
network calls in `scan`, nothing uploaded without your explicit
confirmation. See the full
[trust model](https://github.com/Redential/redential-cli#trust-model).
