# OMO fork of T3 Code

This fork carries a small stack of patches so T3 Code can drive OMO (the `omo` pi provider). It is server-only and meant to be a drop-in for the upstream server of the same version.

## Branch

- `omo` is the only branch that matters: the latest upstream stable tag plus the patch stack. It is the fork's default branch.
- The fork's `main` is never written.
- CI (`fork-release.yml`, added later) rebases `omo` onto each new upstream stable tag and publishes a release. Do not rebase by hand unless CI reports a conflict.

## Patch stack rules

- One commit per patch, titled `fork(P<n>): ...`. Other commits are `fork(docs): ...` and `fork(ci): ...`.
- Tests go in the package's existing test files.
- Logic goes in new files; hook into `adapter.ts` with one-line changes only.
- Never bump the upstream version string. The fork reports the same version as its base tag.
- No DB migrations, no persisted-shape changes, no `packages/contracts` change, no new `PiSettings` field. Upstream desktop, web and mobile clients must keep working unchanged.

## Upstream workflows

Upstream workflows are disabled with `gh workflow disable` and never edited. The only workflow that runs here is the fork's own `fork-release.yml`.

## Rollback

Run `scripts/t3-fork-rollback` in `~/.config/opencode` (added later). It stops the fork service and returns T3 to its stock local server. To also restore saved T3 data, pass `--restore ~/.t3/userdata.bak.<stamp>`.
