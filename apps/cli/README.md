# a2wave CLI

The official command-line client for [a2wave](https://github.com/LilithGames/a2wave), a natural-language-driven Agent building and orchestration platform.

The package installs the `a2wave` command.

## Requirements

- Node.js 22 or later
- An a2wave instance for platform-management commands
- Docker with Compose support when using `a2wave setup`

## Install

```bash
npm install --global a2wave
```

Verify the installation:

```bash
a2wave --version
a2wave --help
```

## Get started

Sign in, configure the instance URL, and check connectivity:

```bash
a2wave login
a2wave config set-url https://a2wave.example.com
a2wave status
```

Then manage resources or invoke an Agent:

```bash
a2wave agents list
a2wave skills list
a2wave chat send my-agent --message "Hello"
```

Use `a2wave <command> --help` for command-specific options.

## Local platform setup

The CLI can create and manage a Docker-based local deployment. A container image reference is required until a public image registry is available:

```bash
a2wave setup --image <a2wave-image-reference>
```

Run `a2wave setup --help` before installation to review directory, port, upgrade, backup, and removal options.

## Documentation and support

- [CLI installation and publishing guide](https://github.com/LilithGames/a2wave/blob/main/docs/agent/cli-install-publish.md)
- [Project documentation](https://github.com/LilithGames/a2wave#readme)
- [Issue tracker](https://github.com/LilithGames/a2wave/issues)
- [Security policy](https://github.com/LilithGames/a2wave/security/policy)

## License

Apache License 2.0. See the `LICENSE` and `NOTICE` files included in this package.
