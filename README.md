# Hivemind GitLab Bot

Monitor GitLab merge requests from Hivemind: collect updates in a selected channel,
or discover ready-to-review MRs and maintain one private channel for each.

This repository is `hivemind-gitlab-bot`. The package, executable and persistent
definition ID remain `hivemind-gitlab`; the repository name does not change existing
profile identities or event IDs.

GitLab is an **external bot** with its own repository, package and release cycle.
Hivemind supplies the generic bot protocol and Bots UI; it does not contain or build
this implementation. This package owns GitLab readers, discovery, polling and tests.

The bot combines **Publish + Tools**. It reads GitLab using authenticated glab GET
requests and publishes idempotent observations in invited Hivemind channels.
It does not need Receive or a language model and cannot write comments, approve,
merge, push or rebase on GitLab.

## Requirements

- Node.js 22.13 or later and npm.
- A Hivemind build with the composable Bots API (`hivemind bots`, `bot_tools` and
  `call_bot_tool`). This is a new, breaking integration; older Plugin APIs are not
  supported. The accompanying core change must be installed before using this bot.
- A local `glab` executable authenticated to the intended GitLab host, with access
  to the repositories you want to observe. The bot only issues GET requests.
- A Hivemind project and brain. Create the project explicitly; setup does not
  assume a default project exists.

## Quick start

Clone and build this repository independently of Hivemind:

```sh
git clone https://github.com/mariorossano/hivemind-gitlab-bot.git
cd hivemind-gitlab-bot
npm ci
npm run build
```

Register its trusted local manifest in the intended Hivemind home. Replace both
absolute paths with your installation paths:

```sh
hivemind bots add /absolute/hivemind-gitlab-bot/hivemind-bot.json --home /absolute/hive
```

Registration does not start a monitor. Open **Bots → Add bot → GitLab** (refresh
if needed) in your project. Configure the hostname (without `https://`) and the
absolute glab executable path, such as `/opt/homebrew/bin/glab`,
enable the service and create/connect its identity. No monitor starts during setup.
The bot token is passed privately to its profile, not returned in a model prompt.

For one MR, create/select its destination channel and invite the bot and brain.
Then give the brain an explicitly scoped instruction, for example:

> Monitor https://gitlab.example.com/group/repo/-/merge_requests/42 in this channel.
> Report future updates here; do not start a review or publish anything on GitLab.

For repository discovery, choose a summary channel and ask:

> Monitor https://gitlab.example.com/group/repo for MRs with the exact label
> "ready for review". List existing matches here and create a channel for each
> newly matching MR. Collect updates only; reviews require my instruction.

Inviting the bot alone does not select a repository or MR. A follow/watch rule
binds the source to its destination. One bot can publish to multiple channels;
Hivemind checks its project, capability and channel membership on every delivery.

Brains use `bot_tools` and `call_bot_tool`; see [BOT-TOOLS.md](BOT-TOOLS.md).
Available functions are status, start, stop, follow, unfollow, watch, stop_watch and
resume_watch. Follow/watch require a stopped monitor and never auto-start it.
Human can also check/start/stop the monitor from Manage bot.

Start confirms readiness with the owned daemon over IPC (up to 20 seconds), rather
than inferring success from a busy lock. Failed starts clean up their child, Stop
during bootstrap remains effective, and an abandoned startup cannot begin polling
later. There are no automatic retries or restarts.

The manifest is `hivemind-bot.json`; the generic contract is documented in Hivemind's
`BOTS.md` and `BOT-PACKAGES.md`. Executable operations are `configure --home PROFILE` (JSON settings on
stdin), and `invoke --home PROFILE` (JSON tool call on stdin); both return bounded
JSON on stdout. See [BOT-TOOLS.md](BOT-TOOLS.md) for this bot's functions.
Declarative settings contain no credentials. GitLab credentials remain in glab;
the bot's Hivemind token, subscriptions, fingerprints, locks, outbox and monitor
log stay in its private profile, outside source control. Local Hivemind Human
session capabilities remain in memory and are not exposed to brains.

## Monitoring

Exact-URL follow and repository watch are separate scopes. Watch discovers matching
MRs in one explicitly selected repository and maintains one private channel per MR.
Existing compatible manual routes are reused without replacing reviewer directives
or room contracts. Ambiguous routes block reconciliation rather than create duplicates.
No review or GitLab publication is automatically authorized.

A complete snapshot commits fingerprints and queued observations transactionally.
Pending events survive restart; stable IDs deduplicate lost acknowledgments.
Edits/reversions become new events; missing items are not inferred to be deletions.
Status is local and reports failures; successful configuration is not successful
delivery. The native reader does not fetch repositories, diffs, binaries or attachments.

Health events distinguish pending/unknown checks from healthy results and validate
pipeline SHA against the current head. See [REPOSITORY-WATCH.md](REPOSITORY-WATCH.md)
for filters, event coverage, reconciliation and source lifecycle.

Channel archive pauses its source links and retains queues. Explicit source resume
is distinct from reopening only the room. Unfollow disables one subscription and
cancels its undelivered observations; stop requests process termination. Neither is
undone by a room resume. Already in-flight requests cannot be recalled.

## Operator tools and migration

The executable is bin/hivemind-gitlab.mjs. In a source checkout it uses tsx;
this package's own `npm run build` produces dist/cli.js for distribution. Installed
packages run compiled JavaScript without tsx or a Hivemind source checkout.
It retains local diagnostic
and recovery commands. The direct CLI examples in REPOSITORY-WATCH.md are operator
tools, not the brain-facing interface and not permission-denial recovery shortcuts.

A retained profile can be explicitly bound, after registering this external
manifest, with `hivemind bots bind hivemind-gitlab
--project PROJECT_SLUG --config-home /private/profile --home /hive`. Stop monitors
and back up the hive/profile before migration. Reuse the existing bot identity;
never reconnect a profile to another identity or erase its outbox to repair state.
There is no separate Plugin abstraction: the implementation is `GitLabBot`.
The bot manifest, project profile binding and diagnostic status use the stable
`definitionId: "hivemind-gitlab"`. Event IDs and profile fingerprints keep that same
stable value; pending observations are not renumbered or discarded.
The old extension manifests, settings routes, registries and profile binding key
are not supported. Before rollout, explicitly migrate retained
`hivemind-project.json` bindings to `definitionId` offline after taking a backup;
do not remove the binding or reinitialize the profile to bypass validation.

Settings updates reject incompatible retained identities. Reconnecting rotates the
Hivemind bot token and requires explicit Human confirmation; other clients using
the previous token lose access. Disabling/removing a service does not stop its
process, erase private state or revoke credentials. Status must verify shutdown.

## Tests

Run `npm run check` in this repository. Fixtures use invented providers,
temporary databases and local processes; they do not contact real GitLab or models.
To include full local Hivemind HTTP/daemon integration, set HIVEMIND_TEST_SOURCE to
the absolute Hivemind checkout path for that command. It never reads the live profile.
For example: `HIVEMIND_TEST_SOURCE=/absolute/hivemind npm test`. Without that opt-in,
the cross-repository integration tests are skipped; ordinary bot tests do
not require the core checkout. Hivemind runs its own core/UI tests independently.

`npm pack` builds a standalone tarball. Verify it with
`npm run test:package -- /absolute/hivemind-gitlab.tgz` or pass an independently built
Hivemind tarball as a second argument to verify registration with the packaged core.
The smoke test installs into a temporary directory and starts/stops only an empty
synthetic monitor profile; it never uses live Hivemind/GitLab configuration.

## Troubleshooting

- **GitLab is absent from Add bot:** register the manifest in the same Hivemind
  home as the running server, then refresh. The core does not bundle this bot.
- **Configured, but no events:** check capability grants, bot membership, source
  rules, `monitorRunning`, lifecycle and delivery errors. Setup alone never starts
  polling, and inviting the bot alone never creates a subscription.
- **No channels for existing MRs:** the default discovery mode is an initial
  summary. Choose `initial: follow` when existing matches should get channels too.
- **Access denied or a conflicting retained profile:** stop and inspect the
  reported error. Do not delete the outbox, recreate identities or bypass native
  permissions to force progress.

Provider reads are periodic, not webhooks. The default interval is five minutes;
transient changes between scans can be missed. See
[REPOSITORY-WATCH.md](REPOSITORY-WATCH.md) for exact event coverage and limits.
