# opencode-project-reload

`opencode-project-reload` adds a direct `/reload-project` command to the
OpenCode TUI. It recreates only the selected project's server-side instance so
project configuration and discovery can refresh without restarting the shared
server or interrupting other projects.

## Requirements

- OpenCode 1.18.3 or 1.18.4
- A selected ordinary session on the connected server

Managed workspace sessions are intentionally unsupported. An ordinary session
opened through `opencode attach` is supported; paths are verified by the
connected server and are never resolved on the TUI host.

## Install

Install from a reviewed full commit SHA. Do not use a mutable branch or tag.

```sh
REVISION=912b176a38ec7157c3a8e90d88773178848fa8c8
opencode plugin "https://github.com/krafczyk/opencode-project-reload/archive/$REVISION.tar.gz"
```

Run the command from a project to install locally, or add `--global` to install
for all projects:

```sh
opencode plugin --global "https://github.com/krafczyk/opencode-project-reload/archive/$REVISION.tar.gz"
```

Restart an already-running TUI after installation so it loads the new TUI
plugin. The reviewed JavaScript artifact currently has this SHA-256 digest:

```text
d4f281dede96d333e87308c81a443fad13be695f5fde2114c6ef071fb1a7c107  dist/tui.js
```

Verify it in a checked-out revision with:

```sh
sha256sum dist/tui.js
```

## Use

Open a normal session for the project, then either enter `/reload-project` from
slash autocomplete or select **Reload project** from the command palette. The
command runs directly in the TUI and does not create a model turn.

Reload is refused before disposal when:

- no ordinary session is selected, the TUI state is not ready, or the OpenCode
  version is unsupported;
- the selected route, session, server directory, or project instance changes
  during preflight;
- the session belongs to a managed workspace;
- any session work is busy or retrying;
- a permission or question is pending; or
- a preflight request fails, times out, or has an unexpected response.

Refusal messages identify only the blocker category. They do not include
session identifiers, paths, pending request contents, credentials, or raw
server responses.

## Safety Boundary

The plugin checks status, permissions, and questions twice before disposal.
OpenCode 1.18.x has no atomic guarded-dispose operation, so another client can
start work after the final check. This remaining race is explicit and cannot be
eliminated by the plugin.

Once disposal is sent, a lost response or missing lifecycle event leaves the
outcome uncertain. The plugin will not issue another disposal in that TUI
process; restart the TUI before retrying. If disposal is confirmed but the
project and selected session do not become reachable within the recovery bound,
the plugin reports recovery failure without automatically disposing again.

A successful project reload refreshes project-scoped configuration, server
plugin initialization, agents, skills, commands, and instruction discovery.
Persisted sessions and messages remain intact, and the plugin does not navigate
away from the selected session.

Project reload does not reload:

- this TUI plugin or `tui.json`;
- process-global OpenCode configuration;
- already imported server-plugin module code; or
- the shared server process.

Use a TUI restart for TUI/plugin changes and a full server restart for global or
process-cached changes.

## Development

The default suite is deterministic and credential-free. Compatibility tests
download exact OpenCode releases and use only isolated loopback services.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:build
bun run test:compat -- 1.18.3
bun run test:compat -- 1.18.4
```
