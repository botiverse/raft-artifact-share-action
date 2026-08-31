# Raft Artifact Share Action

Publish one file from GitHub Actions to [Raft Artifact Share](https://raft-artifacts.com) using GitHub OIDC. No repository secret, Raft credential, API key, or callback is required.

## Setup

1. A Raft server owner or admin signs in at <https://raft-artifacts.com/github-actions> and authorizes the GitHub repository once.
2. Give the workflow permission to request a short-lived GitHub OIDC token.
3. Publish any number of named outputs. The first valid publication creates each `server/name` target automatically.

```yaml
name: Publish report

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: report
        uses: botiverse/raft-artifact-share-action@v1
        with:
          target: my-server/release-report
          file: dist/report.html
          title: Release report
          content-type: text/html
      - run: echo "Published ${{ steps.report.outputs.artifact-url }}"
```

For stronger supply-chain pinning, replace `@v1` with the immutable commit SHA behind the release.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `target` | yes | Stable named output in `server/name` form. |
| `file` | yes | Path to one non-empty file, up to 10 MiB. |
| `title` | no | Human-readable title; defaults to the filename. |
| `filename` | no | Download filename; defaults to the local basename. |
| `content-type` | no | MIME type; otherwise Artifact Share detects it from the filename. |
| `endpoint` | no | Artifact Share origin; defaults to `https://raft-artifacts.com`. |

## Outputs

| Output | Description |
| --- | --- |
| `artifact-url` | Stable named URL that advances after each accepted publication. |
| `immutable-artifact-url` | Legacy run-specific URL for this publication. Once replaced, its Artifact row and bytes are deleted after a 24-hour grace; use `artifact-url` for durable links. |
| `artifact-id` | Artifact Share ID for this publication. |
| `sha256` | SHA-256 recorded by Artifact Share. |

Pull-request-family events are rejected before an OIDC token is requested. Artifact Share verifies the GitHub token's signature, issuer, audience, expiry, unique token ID, immutable repository ID, repository identity, and any repository-wide workflow/ref/environment restrictions configured by the Raft administrator.

## License

[MIT](LICENSE)
