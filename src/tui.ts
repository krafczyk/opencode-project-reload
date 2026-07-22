import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { reloadProject, type ReloadController } from "./reload"
import { isSupportedOpenCodeVersion } from "./version"

function refuse(api: TuiPluginApi, message: string) {
  try {
    api.ui.toast({
      variant: "error",
      title: "Project reload",
      message,
    })
  } catch {
    // The host can tear down its UI while a queued command is starting.
  }
}

export function createTuiPlugin(controller: ReloadController = reloadProject): TuiPluginModule & { id: string } {
  const tui: TuiPlugin = async (api) => {
    api.keymap.registerLayer({
      commands: [
        {
          name: "project.reload",
          title: "Reload project",
          category: "Project",
          namespace: "palette",
          slashName: "reload-project",
          async run() {
            if (!isSupportedOpenCodeVersion(api.app.version)) {
              refuse(api, "Project reload requires OpenCode 1.18.3 or 1.18.4.")
              return
            }
            if (!api.state.ready) {
              refuse(api, "Project state is not ready. Try again after synchronization completes.")
              return
            }

            const route = api.route.current
            const sessionID = route.name === "session" ? route.params?.sessionID : undefined
            if (typeof sessionID !== "string" || !sessionID) {
              refuse(api, "Select an ordinary session before reloading its project.")
              return
            }

            const selected = api.state.session.get(sessionID)
            if (!selected || selected.id !== sessionID || !selected.directory) {
              refuse(api, "The selected session is unavailable.")
              return
            }
            if (selected.workspaceID !== undefined) {
              refuse(api, "Project reload is unavailable for workspace sessions.")
              return
            }

            await controller({
              api,
              target: {
                sessionID: selected.id,
                directory: selected.directory,
              },
            })
          },
        },
      ],
    })
  }

  return {
    id: "opencode-project-reload",
    tui,
  }
}

export default createTuiPlugin()
