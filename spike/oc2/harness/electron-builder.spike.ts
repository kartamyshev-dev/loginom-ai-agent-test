// B0.4: the sandbox's own electron-builder config, changed only where an installed spike build must differ:
// - the update feed points at a closed loopback port, so the installed app never checks or downloads OpenCode releases;
// - one target per OS (AppImage on Linux; NSIS on Windows, or the unpacked app for `--dir`), output under .run;
// - B0_ELECTRON_DIST reuses the Electron that `bun run install-electron` unpacked, instead of downloading it again;
//   otherwise the download lands in electron_config_cache.
// Loaded by electron-builder (jiti) with OPENCODE_CHANNEL, OPENCODE_TARGET and OPENCODE_VERSION set by build-installed.sh.
import type { Configuration } from "electron-builder"
import { getConfig } from "../opencode/packages/desktop/electron-builder.config"

const base = getConfig()

export default {
  ...base,
  directories: { ...base.directories, output: process.env.B0_DIST },
  ...(process.env.B0_ELECTRON_DIST ? { electronDist: process.env.B0_ELECTRON_DIST } : {}),
  // electron-builder downloads Electron into the user's cache unless the config names one; electron_config_cache alone
  // does not reach it.
  ...(process.env.electron_config_cache ? { electronDownload: { cache: process.env.electron_config_cache } } : {}),
  publish: { provider: "generic", url: "http://127.0.0.1:9/b0-no-updates/", channel: "latest" },
  linux: { ...base.linux, target: ["AppImage"] },
  win: { ...base.win, target: ["nsis"] },
} satisfies Configuration
