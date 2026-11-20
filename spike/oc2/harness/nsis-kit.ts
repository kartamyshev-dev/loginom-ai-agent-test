// B0.4b: the kit for `electron-builder --prepackaged` on the Windows stand (installed-windows.ps1 -Action nsis).
//   bun nsis-kit.ts <kit dir>     with OPENCODE_CHANNEL=prod OPENCODE_TARGET=windows-x64 OPENCODE_VERSION set
// The same config as electron-builder.spike.ts, as data: afterPack only verifies the app and already ran with --dir; files
// and extraResources describe the app, which is prepackaged. The NSIS include and icon it names, upstream's patch of
// app-builder-lib's NSIS templates, and the Desktop's package metadata come along.
import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import config from "./electron-builder.spike"

const kit = path.resolve(process.argv[2] ?? "")
const desktop = path.resolve(import.meta.dir, "..", "opencode", "packages", "desktop")
rmSync(kit, { recursive: true, force: true })
for (const dir of ["resources/windows", "resources/icons", "patches"]) mkdirSync(path.join(kit, dir), { recursive: true })
copyFileSync(path.join(desktop, "resources/windows/installer.nsh"), path.join(kit, "resources/windows/installer.nsh"))
copyFileSync(path.join(desktop, "resources/icons/icon.ico"), path.join(kit, "resources/icons/icon.ico"))
copyFileSync(path.join(desktop, "../../patches/app-builder-lib@26.15.7.patch"), path.join(kit, "patches/app-builder-lib@26.15.7.patch"))

const data = JSON.parse(JSON.stringify(config))
const pkg = await Bun.file(path.join(desktop, "package.json")).json()
await Bun.write(
  path.join(kit, "builder.json"),
  JSON.stringify(
    {
      ...data,
      directories: { output: "dist", buildResources: "resources" },
      nsis: { ...data.nsis, include: "resources/windows/installer.nsh" },
      electronVersion: pkg.devDependencies.electron,
      files: undefined,
      extraResources: undefined,
    },
    null,
    2,
  ),
)
await Bun.write(
  path.join(kit, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: data.extraMetadata.version,
      private: true,
      license: pkg.license,
      homepage: pkg.homepage,
      author: pkg.author,
      devDependencies: { "electron-builder": pkg.devDependencies["electron-builder"] },
      patchedDependencies: { "app-builder-lib@26.15.7": "patches/app-builder-lib@26.15.7.patch" },
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ kit, productName: data.productName, appId: data.appId, version: data.extraMetadata.version, publish: data.publish }))
