# Release management

The repository uses `cargo-release` 1.1.2 to manage version bumps, commits, tags and pushes; CI generates GitHub release notes. Rust workspace crates share one version, and a release updates both the root `package.json` and `apps/web/package.json` to the same version. The CI checks these versions on every build and checks that a pushed `vX.Y.Z` tag matches the workspace version.

## Version policy

A version bump in the working tree is not a published release; publication requires a committed version, its matching tag and successful image/release workflows. Existing tags are never moved to repair a failed release; fixes receive a new patch version. Before `1.0.0`, use patch releases for fixes and minor releases for features or breaking changes. Treat `1.0.0` as a deliberate stability milestone; after it, breaking changes require a major version bump.

## Preview and release

Run `just release-install` to install the pinned cargo-release 1.1.2. Start from a clean, up-to-date `main` checkout and preview the intended bump:

```sh
just release-check
just release-plan patch
```

Replace `patch` with `minor` or `major` as appropriate. `release-plan` runs `cargo release --workspace <level>` in dry-run mode and shows the changes without publishing them.

When the preview is correct, run:

```sh
just release patch
```

The release recipe runs `just check` and then `cargo release --workspace patch --execute`. Substitute the selected level. Cargo-release asks for confirmation by default; review the version changes before accepting. On acceptance it updates versions, creates the release commit and `vX.Y.Z` tag, and pushes them to `origin` on `main`. Do not use `--no-confirm` for the normal release flow.

## Published artifacts

Pushing `main` or a `v*` tag starts the image workflow after the required checks pass. The GHCR image is `ghcr.io/fuzzycloud/office-office`; the workflow uses the repository-provided `GITHUB_TOKEN` with `packages: write`, so no package token secret is required. It publishes an `edge` tag for `main`, a `sha-<full-commit>` tag, and a semantic version tag for a release. A stable release also receives `latest`; a prerelease version does not. The workflow creates a GitHub Release with generated notes after the version-tag image push succeeds.

The image workflow builds and publishes an image only. It does not deploy a server or receive runtime office credentials. See [hosting](hosting.md) for pulling and running the image.

## Exact versions and prereleases

Use `just release-plan 0.2.0-rc.1` to preview an exact prerelease and `just release 0.2.0-rc.1` to cut it. The frontend versions stay aligned for prereleases too. Version tags must match all manifests and Cargo.lock; CI rejects a mismatched tag. No local crates.io publication runs, and the server manifest also sets `publish = false`.

Cargo-release still looks up registry metadata even with publishing disabled, so release commands need registry connectivity as well as GitHub access. If branch protection requires pull requests, prepare the aligned version bump through a PR and tag the merged version rather than running another bump. A second patch bump would skip the intended version.
