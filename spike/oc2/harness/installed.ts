// B0.4: an installed build of the sandbox (U1, U3, U5 and the Desktop side of U5), from installation to removal.
//   bun installed.ts linux <opencode-desktop-linux-x86_64.AppImage>
//   bun installed.ts windows <opencode-desktop-win-x64.exe>      (on the stand, through installed-windows.ps1)
//   B0_U5_DESKTOP=0 → the Desktop without its U5 seam (only the CLI has one): does the window find its service?
// Steps, recorded in .run/b0-installed/<os>/run[-u5-cli-only]/report.json:
//  1. install without root or admin: the AppImage extracts itself into install/ (this machine has no libfuse2);
//     NSIS /S /currentuser /D=install
//  2. launch with its own userData and XDG dirs (OPENCODE_DESKTOP_TEST_ROOT) and home. Onboarding is marked done, so no
//     project lands in the real Documents; "Новая сессия" opens a draft in that home
//  3. the service registers its own file and port (U5), not service.json
//  4. one chat turn typed into the window, on the scripted model
//  5. window.close() over DevTools, as the close button does; the app must exit by itself with code 0
//  6. is the service alive at +2 s, +30 s, +120 s; a second launch adopts it or starts another; close again
//  7. uninstall while the service still runs; is it alive afterwards
//  8. `service stop` from the staged CLI: time, registration file, plugin dispose
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { report, SPIKE } from "./env"
import { script, startMock } from "./mock-llm"

type Json = Record<string, any>

const OS = process.argv[2]
if (OS !== "linux" && OS !== "windows") throw new Error("usage: bun installed.ts linux|windows <artifact>")
const ARTIFACT = path.resolve(process.argv[3] ?? "")
const BASELINE = process.env.B0_U5_DESKTOP === "0"
const RUN = path.join(SPIKE, ".run", "b0-installed", OS, BASELINE ? "run-u5-cli-only" : "run")
const INSTALL = path.join(RUN, "install")
const ROOT = path.join(RUN, "root")
const HOME = path.join(RUN, "home")
const SHOTS = path.join(RUN, "shots")
const MOCK_PORT = 47191
// DevTools of each launch. The service inherits the first window's listening socket and keeps the port after the app
// exits (see `inherited`), so the second launch takes another one.
const CDP_PORT = { first: 47192, second: 47193 }
const IDENTITY = "loginom-ai-agent-desktop"
const STATE = path.join(ROOT, "state", "opencode")
const REGISTRATION = path.join(STATE, `service-${IDENTITY}.json`)
// U5's port for this identity, as S5 (Linux) and B0.2 (Windows) measured it; below 0x8000, so Windows keeps it.
const U5_PORT = 31643
const EXE = OS === "linux" ? path.join(INSTALL, "squashfs-root", "AppRun") : path.join(INSTALL, "OpenCode.exe")
const END = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

const results: Json = { os: OS, artifact: { file: path.basename(ARTIFACT), bytes: statSync(ARTIFACT).size }, baseline: BASELINE }
const mock = startMock(MOCK_PORT, path.join(RUN, "llm.jsonl"))
const launched: { app?: ReturnType<typeof launch> } = {}
let service: Json | undefined
try {
  prepare()
  results.install = install()
  launched.app = launch("first")
  if (BASELINE) await baseline(launched.app)
  if (!BASELINE) await lifecycle()
} catch (error) {
  results.error = String(error instanceof Error ? (error.stack ?? error.message) : error)
} finally {
  results.cleanup = cleanup()
  mock.stop(true)
  writeFileSync(path.join(RUN, "report.json"), JSON.stringify(results, null, 2))
  report(BASELINE ? "B0.4 U5 CLI only" : "B0.4", verdict(), results.points ?? results.error ?? results)
}

async function lifecycle() {
  const app = launched.app!
  service = await registered(app.started)
  results.service = { ...describe(service), registeredMs: service.registeredMs }
  results.u5 = {
    files: readdirSync(STATE).filter((name) => name.startsWith("service")),
    defaultFile: existsSync(path.join(STATE, "service.json")),
    port: Number(new URL(service.url).port),
    expectedPort: U5_PORT,
  }
  results.serviceImage = image(service.pid)
  const sse = { events: [] as Json[], controller: new AbortController() }
  void subscribe(service, sse)
  const cdp = await connect(CDP_PORT.first)
  results.chat = await chat(cdp, sse)
  results.memoryMB = memory(app, service.pid)
  sse.controller.abort()
  results.close = await close(cdp, app, "02-before-close")
  results.inherited = inherited(service.pid)
  results.afterClose = []
  for (const [label, wait] of [["+2s", 2_000], ["+30s", 28_000], ["+120s", 90_000]] as const) {
    await Bun.sleep(wait)
    results.afterClose.push({ at: label, ...(await probe(service)) })
  }

  // A second launch while the first service still runs: the window adopts it or replaces it.
  const firstLog = logRun()
  launched.app = launch("second")
  const again = launched.app
  results.secondLaunch = await adoption(again.started, firstLog)
  const cdp2 = await connect(CDP_PORT.second)
  await until("second window", 60_000, () => cdp2.eval(`document.body.innerText.length > 0`))
  await cdp2.shot("03-second-launch")
  results.secondLaunch.close = await close(cdp2, again, undefined)
  service = JSON.parse(readFileSync(REGISTRATION, "utf8"))
  results.secondLaunch.afterClose = await probe(service!)

  results.uninstall = await uninstall()
  results.afterUninstall = await probe(service!)
  results.serviceStop = await serviceStop(service!)
  results.points = points()
}

// The CLI registers under its identity while the Desktop, without its seam, waits for service.json.
async function baseline(app: ReturnType<typeof launch>) {
  const started = app.started
  const registration = await until("CLI registration", 90_000, () => (existsSync(REGISTRATION) ? JSON.parse(readFileSync(REGISTRATION, "utf8")) : undefined))
  results.service = describe(registration)
  service = registration
  await Bun.sleep(130_000 - (Date.now() - started))
  results.u5 = { files: readdirSync(STATE).filter((name) => name.startsWith("service")), defaultFile: existsSync(path.join(STATE, "service.json")) }
  results.serviceProcesses = processes("opencode-cli").length
  results.mainLog = mainLog().filter((line) => /background service|Timed out|failed to start|ensure/i.test(line)).slice(-12)
  const cdp = await connect(CDP_PORT.first)
  results.windowText = await cdp.eval(`document.body.innerText.slice(0, 400)`)
  await cdp.shot("01-u5-cli-only")
  results.close = await close(cdp, app, undefined)
  results.afterClose = await probe(registration)
  results.points = {
    "u5-desktop-needed": !results.u5.defaultFile && results.mainLog.some((line: string) => /Timed out|failed/i.test(line))
      ? "YES: the window waits for service.json, the service sits in service-<identity>.json"
      : "UNCLEAR",
  }
}

function prepare() {
  rmSync(RUN, { recursive: true, force: true })
  for (const dir of [INSTALL, HOME, SHOTS, path.join(ROOT, "config", "opencode"), path.join(ROOT, "desktop", "opencode"), path.join(RUN, "tmp")])
    mkdirSync(dir, { recursive: true })
  // .run sits inside a git checkout on Linux: the home folder gets its own repository, or the draft resolves to the
  // checkout. The stand has no git and no checkout.
  if (OS === "linux") Bun.spawnSync(["git", "init", "-q", HOME])
  for (const file of ["llm.jsonl", "plugin.jsonl", "sse.jsonl"]) writeFileSync(path.join(RUN, file), "")
  // userData/opencode marks onboarding done (hasExistingAppState), so the first launch creates no default project in
  // the real Documents folder, which USERPROFILE does not move on Windows.
  writeFileSync(
    path.join(ROOT, "config", "opencode", "opencode.json"),
    JSON.stringify(
      {
        model: "spike/spike-model",
        providers: {
          spike: {
            name: "Spike",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "spike" },
            models: { "spike-model": { name: "Spike model", capabilities: { tools: true, input: ["text"], output: ["text"] } } },
          },
        },
      },
      null,
      2,
    ),
  )
}

function install() {
  const started = Date.now()
  if (OS === "linux") {
    const appimage = path.join(INSTALL, path.basename(ARTIFACT))
    cpSync(ARTIFACT, appimage)
    // No libfuse2 on this machine, so the AppImage cannot mount itself: it extracts into its install folder instead.
    const extract = Bun.spawnSync([appimage, "--appimage-extract"], { cwd: INSTALL, stdout: "ignore", stderr: "pipe" })
    rmSync(appimage)
    return { method: "AppImage --appimage-extract", exitCode: extract.exitCode, ms: Date.now() - started, exe: existsSync(EXE), bytes: size(INSTALL) }
  }
  const nsis = Bun.spawnSync([ARTIFACT, "/S", "/currentuser", `/D=${INSTALL}`], { env: windowsEnv(), stdout: "ignore", stderr: "ignore" })
  return {
    method: "NSIS /S /currentuser /D=",
    exitCode: nsis.exitCode,
    ms: Date.now() - started,
    exe: existsSync(EXE),
    bytes: size(INSTALL),
    entries: uninstallEntries(),
    shortcuts: shortcuts(),
  }
}

function launch(round: "first" | "second") {
  const env: Record<string, string> = {
    HOME,
    OPENCODE_DESKTOP_TEST_ROOT: ROOT,
    OPENCODE_DESKTOP_DISABLE_PROTOCOL_REGISTRATION: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    LOGINOM_SPIKE_BUILTIN: "1",
    LOGINOM_SPIKE_U3: "1",
    LOGINOM_SPIKE_U5_IDENTITY: IDENTITY,
    LOGINOM_SPIKE_LOG: path.join(RUN, "plugin.jsonl"),
    LOGINOM_SPIKE_STATE: path.join(RUN, "state-loginom"),
    ...(BASELINE ? { LOGINOM_SPIKE_U5_DESKTOP: "0" } : {}),
  }
  const started = Date.now()
  const log = Bun.file(path.join(RUN, `app-${round}.log`))
  const child =
    OS === "linux"
      ? Bun.spawn(
          // setsid -w: Xvfb and every Electron process share one process group that cleanup can end; the exit code is the app's.
          ["setsid", "-w", "xvfb-run", "-a", "-s", "-screen 0 1440x900x24", EXE, "--no-sandbox", `--remote-debugging-port=${CDP_PORT[round]}`],
          { cwd: HOME, env: { PATH: process.env.PATH ?? "", LANG: "ru_RU.UTF-8", ...env }, stdout: log, stderr: log },
        )
      : Bun.spawn([EXE, `--remote-debugging-port=${CDP_PORT[round]}`], { cwd: HOME, env: { ...windowsEnv(), ...env }, stdout: log, stderr: log })
  return { child, started, round }
}

// On Windows the service's home follows USERPROFILE, and TEMP keeps installer and Chromium temp files in the run folder.
function windowsEnv() {
  return { ...process.env, USERPROFILE: HOME, TEMP: path.join(RUN, "tmp"), TMP: path.join(RUN, "tmp") } as Record<string, string>
}

async function registered(started: number) {
  const info = await until("service registration", 120_000, async () => {
    if (!existsSync(REGISTRATION)) return undefined
    const registration = JSON.parse(readFileSync(REGISTRATION, "utf8"))
    const answer = await api(registration, "GET", "/api/info").catch(() => undefined)
    return answer?.pid === registration.pid ? { ...registration, registeredMs: Date.now() - started } : undefined
  })
  return info
}

async function chat(cdp: Awaited<ReturnType<typeof connect>>, sse: { events: Json[] }) {
  await until("home or draft", 60_000, () => cdp.eval(`!!document.querySelector("button[aria-label='Новая сессия'], [contenteditable=true]")`))
  await cdp.shot("00-first-window")
  results.firstWindow = await cdp.eval(`document.body.innerText.slice(0, 300)`)
  await cdp.eval(`document.querySelector("button[aria-label='Новая сессия']")?.click()`)
  await until("draft composer", 30_000, () => cdp.eval(`!!document.querySelector("[contenteditable=true]")`))
  await Bun.sleep(1000)
  const reply = "Установленная сборка ответила."
  const from = sse.events.length
  const sent = Date.now()
  await cdp.eval(`document.querySelector("[contenteditable=true]").focus()`)
  await cdp.send("Input.insertText", { text: script([{ text: reply }], "B0.4: один ход").replace("\n", " ") })
  await Bun.sleep(300)
  await cdp.key("Enter", 13)
  const end = await until("end of the turn", 60_000, () => sse.events.slice(from).find((event) => END.has(event.type)))
  const shown = await until("reply in the window", 15_000, () => cdp.eval(`document.body.innerText.includes(${JSON.stringify(reply)})`)).catch(() => false)
  await Bun.sleep(500)
  await cdp.shot("01-chat-turn")
  const sessionID = end.data.sessionID
  const session = await api(service!, "GET", `/api/session/${sessionID}`)
  const llm = lines(path.join(RUN, "llm.jsonl")).filter((entry) => entry.sessionID === sessionID)
  const plugin = lines(path.join(RUN, "plugin.jsonl"))
  return {
    sessionID,
    end: end.type,
    ms: end.t - sent,
    shownInWindow: shown,
    directory: session.data?.location?.directory,
    modelRequests: llm.length,
    // The built-in product plugin (U1) is compiled into the bundled CLI and saw the turn.
    productPlugin: {
      setups: plugin.filter((entry) => entry.event === "setup").map((entry) => path.relative(RUN, entry.location)),
      contextHooks: plugin.filter((entry) => entry.event === "context" && entry.sessionID === sessionID).length,
      events: plugin.filter((entry) => entry.event === "event" && entry.sessionID === sessionID).map((entry) => entry.type),
    },
  }
}

async function close(cdp: Awaited<ReturnType<typeof connect>>, app: ReturnType<typeof launch>, shot: string | undefined) {
  if (shot) await cdp.shot(shot)
  const started = Date.now()
  // window.close() from the page closes the BrowserWindow like its close button; the last window closing quits the app
  // on Linux and Windows. The page's DevTools socket goes away with it.
  await cdp.eval(`setTimeout(() => window.close(), 50), true`).catch(() => undefined)
  cdp.close()
  const exitCode = await Promise.race([app.child.exited, Bun.sleep(60_000).then(() => "timeout" as const)])
  const leftovers = appProcesses()
  return { exitCode, ms: Date.now() - started, appProcessesAfter: leftovers.length, quitLog: mainLog().filter((line) => /quit|shutdown|stopp/i.test(line)).slice(-6) }
}

async function adoption(started: number, firstLog: string | undefined) {
  const ready = await until("second launch connected", 120_000, () => {
    if (logRun() === firstLog) return undefined
    const lines = mainLog()
    const index = lines.findLastIndex((line) => line.includes("v2 CLI background service ready"))
    if (index === -1) return undefined
    return lines.slice(index, index + 8).join(" ")
  })
  const registration = JSON.parse(readFileSync(REGISTRATION, "utf8"))
  return {
    connectedMs: Date.now() - started,
    probed: /probed: true/.test(ready),
    samePid: registration.pid === service!.pid,
    serviceProcesses: processes("opencode-cli").length,
    log: ready.replace(/\s+/g, " ").slice(0, 300),
  }
}

async function uninstall() {
  const started = Date.now()
  if (OS === "linux") {
    rmSync(INSTALL, { recursive: true, force: true })
    return { method: "rm -rf install", ms: Date.now() - started, installGone: !existsSync(INSTALL) }
  }
  const uninstaller = readdirSync(INSTALL).find((name) => /^Uninstall .*\.exe$/.test(name))
  if (!uninstaller) throw new Error("uninstaller missing")
  const run = Bun.spawnSync([path.join(INSTALL, uninstaller), "/S", "/currentuser"], { env: windowsEnv(), stdout: "ignore", stderr: "ignore" })
  // The NSIS uninstaller copies itself to TEMP and returns at once; the copy removes the files.
  await until("install folder removed", 120_000, () => !existsSync(EXE)).catch(() => false)
  await Bun.sleep(2000)
  return {
    method: "NSIS uninstaller /S /currentuser",
    exitCode: run.exitCode,
    ms: Date.now() - started,
    installGone: !existsSync(EXE),
    left: existsSync(INSTALL) ? readdirSync(INSTALL) : [],
    entries: uninstallEntries(),
    shortcuts: shortcuts(),
  }
}

// `opencode service stop` from the staged CLI: what a product could run, or call through the client, on quit.
async function serviceStop(registration: Json) {
  const cli = path.join(ROOT, "desktop", "cli", `${registration.version}-x64`, OS === "windows" ? "opencode-cli.exe" : "opencode-cli")
  if (!(await probe(registration)).alive) return { skipped: "service already stopped" }
  const started = Date.now()
  const env = {
    ...(OS === "windows" ? windowsEnv() : { PATH: process.env.PATH ?? "" }),
    HOME,
    XDG_DATA_HOME: path.join(ROOT, "data"),
    XDG_CONFIG_HOME: path.join(ROOT, "config"),
    XDG_CACHE_HOME: path.join(ROOT, "cache"),
    XDG_STATE_HOME: path.join(ROOT, "state"),
    LOGINOM_SPIKE_U5_IDENTITY: IDENTITY,
  }
  const run = Bun.spawnSync([cli, "service", "stop"], { cwd: HOME, env, stdout: "pipe", stderr: "pipe" })
  const ms = Date.now() - started
  await Bun.sleep(1000)
  return {
    exitCode: run.exitCode,
    ms,
    output: (run.stdout.toString() + run.stderr.toString()).trim().slice(-300),
    after: await probe(registration),
    dispose: lines(path.join(RUN, "plugin.jsonl")).some((entry) => entry.event === "dispose" && entry.pid === registration.pid),
  }
}

async function probe(registration: Json) {
  const info = await api(registration, "GET", "/api/info").catch(() => undefined)
  return {
    alive: alive(registration.pid),
    answers: info?.pid === registration.pid,
    registration: existsSync(REGISTRATION),
    image: alive(registration.pid) ? image(registration.pid) : undefined,
  }
}

function points() {
  const ok = (value: boolean) => (value ? "PASS" : "FAIL")
  const close = results.close
  return {
    install: ok(results.install.exitCode === 0 && results.install.exe),
    "service-started": ok(!!results.service && results.serviceImage?.startsWith(ROOT)),
    "u5-own-file-and-port": ok(results.u5.files.join() === `service-${IDENTITY}.json` && !results.u5.defaultFile && results.u5.port === U5_PORT),
    chat: ok(results.chat.end === "session.execution.succeeded" && results.chat.shownInWindow && results.chat.modelRequests > 0),
    "normal-close": ok(close.exitCode === 0 && close.appProcessesAfter === 0),
    uninstall: ok(results.uninstall.installGone && (OS === "linux" || (results.uninstall.exitCode === 0 && results.uninstall.entries.length === 0))),
    "service-after-close": results.afterClose.every((sample: Json) => sample.alive && sample.answers) ? "ALIVE" : "STOPPED",
    "service-after-uninstall": results.afterUninstall.alive ? "ALIVE" : "STOPPED",
    "second-launch": results.secondLaunch.samePid ? "ADOPTED" : "NEW",
  }
}

function verdict() {
  if (results.error || !results.points) return "FAIL"
  return Object.values(results.points).includes("FAIL") ? "FAIL" : "PASS"
}

// Whatever is left after the run: the app by its process group or install path, the service by its registered pid.
function cleanup() {
  const left: Json = { app: appProcesses().length, service: service && alive(service.pid) ? service.pid : undefined }
  if (launched.app && launched.app.child.exitCode === null) kill(launched.app.child.pid, true)
  appProcesses().forEach((pid) => kill(pid, false))
  if (service && alive(service.pid)) kill(service.pid, false)
  if (OS === "windows" && existsSync(EXE)) {
    const uninstaller = readdirSync(INSTALL).find((name) => /^Uninstall .*\.exe$/.test(name))
    if (uninstaller) Bun.spawnSync([path.join(INSTALL, uninstaller), "/S", "/currentuser"], { env: windowsEnv() })
  }
  return left
}

function kill(pid: number, group: boolean) {
  if (OS === "windows") return Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" })
  try {
    process.kill(group ? -pid : pid, "SIGKILL")
  } catch {}
}

// What the service still holds of the closed app: it is spawned by the Electron main process and inherits every
// descriptor or handle not marked close-on-exec or non-inheritable.
function inherited(pid: number) {
  if (OS === "windows")
    return {
      listening: powershell(`Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort }`)
        .split(/\s+/)
        .filter(Boolean)
        .map(Number),
    }
  const fds = readdirSync(`/proc/${pid}/fd`).map((fd) => Bun.spawnSync(["readlink", `/proc/${pid}/fd/${fd}`]).stdout.toString().trim())
  const listening = Bun.spawnSync(["ss", "-ltnpH"]).stdout.toString().split("\n").filter((line) => line.includes(`pid=${pid},`))
  return {
    listening: listening.map((line) => Number(line.split(/\s+/)[3].split(":").at(-1))),
    descriptors: fds.length,
    installFiles: fds.filter((target) => target.startsWith(INSTALL)).map((target) => path.relative(INSTALL, target)),
    sessionFiles: fds.filter((target) => target.startsWith(path.join(ROOT, "session"))).length,
    deleted: fds.filter((target) => target.endsWith("(deleted)")).length,
  }
}

function describe(registration: Json) {
  return { url: registration.url, pid: registration.pid, version: registration.version, password: "<redacted>" }
}

function alive(pid: number) {
  if (OS === "windows") return powershell(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`) === "True"
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function image(pid: number) {
  if (OS === "windows") return powershell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`)
  return Bun.spawnSync(["readlink", `/proc/${pid}/exe`]).stdout.toString().trim()
}

// Processes whose executable lives in the install folder (on Linux also Xvfb of this run's process group).
function appProcesses() {
  if (OS === "windows")
    return powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${INSTALL}\\*' } | ForEach-Object { $_.ProcessId }`)
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .filter((pid) => Bun.spawnSync(["readlink", `/proc/${pid}/exe`]).stdout.toString().startsWith(INSTALL))
    .map(Number)
}

function processes(name: string) {
  if (OS === "windows")
    return powershell(`Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${ROOT}\\*' } | ForEach-Object { $_.Id }`)
      .split(/\s+/)
      .filter(Boolean)
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .filter((pid) => Bun.spawnSync(["readlink", `/proc/${pid}/exe`]).stdout.toString().trim().endsWith(`/${name}`))
}

function uninstallEntries() {
  return powershell(
    `Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.InstallLocation -like '${INSTALL}*' -or $_.UninstallString -like '*${INSTALL}*' } | ForEach-Object { $_.DisplayName + ' ' + $_.DisplayVersion }`,
  )
    .split(/\r?\n/)
    .filter(Boolean)
}

function shortcuts() {
  return powershell(
    `@([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue } | Where-Object { (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath -like '${INSTALL}*' } | ForEach-Object { $_.FullName }`,
  )
    .split(/\r?\n/)
    .filter(Boolean)
}

function powershell(command: string) {
  return Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", command], { stdout: "pipe", stderr: "ignore" })
    .stdout.toString()
    .trim()
}

// Each launch logs into its own userData/logs/<timestamp>/.
function logRun() {
  const logs = path.join(ROOT, "desktop", "logs")
  return existsSync(logs) ? readdirSync(logs).sort().at(-1) : undefined
}

function mainLog() {
  const latest = logRun()
  const file = latest && path.join(ROOT, "desktop", "logs", latest, "main.log")
  return file && existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : []
}

function memory(app: ReturnType<typeof launch>, servicePid: number) {
  if (OS === "windows") {
    const mb = (filter: string) => Number(powershell(`[math]::Round((Get-CimInstance Win32_Process | Where-Object { ${filter} } | Measure-Object WorkingSetSize -Sum).Sum / 1MB)`))
    return { window: mb(`$_.ExecutablePath -like '${INSTALL}\\*'`), service: mb(`$_.ProcessId -eq ${servicePid}`) }
  }
  const rss = (sid: number) =>
    Bun.spawnSync(["ps", "-o", "rss=", "--sid", String(sid)]).stdout.toString().split("\n").map(Number).filter(Boolean).reduce((a, b) => a + b, 0)
  return { window: Math.round(rss(app.child.pid) / 1024), service: Math.round(rss(servicePid) / 1024) }
}

function size(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return sum + size(file)
    return entry.isFile() ? sum + statSync(file).size : sum
  }, 0)
}

function lines(file: string) {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json)
}

function api(registration: Json, method: string, route: string) {
  return fetch(registration.url + route, {
    method,
    headers: { ...auth(registration), "x-opencode-directory": encodeURIComponent(HOME) },
    signal: AbortSignal.timeout(3000),
  }).then((response) => response.json() as Promise<Json>)
}

function auth(registration: Json) {
  return { authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}` }
}

// The window's own SSE consumer is the app; this one records the same stream for the report.
async function subscribe(registration: Json, sse: { events: Json[]; controller: AbortController }) {
  const response = await fetch(`${registration.url}/api/event`, { headers: auth(registration), signal: sse.controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let rest = ""
  for (;;) {
    const chunk = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (chunk.done) return
    const text = rest + decoder.decode(chunk.value, { stream: true })
    const all = text.split("\n")
    rest = all.pop() ?? ""
    for (const line of all.filter((item) => item.startsWith("data:"))) {
      const event = { t: Date.now(), ...JSON.parse(line.slice(5)) }
      sse.events.push(event)
      if (!/\.delta$|^session\.(text|tool\.input)\./.test(event.type)) appendFileSync(path.join(RUN, "sse.jsonl"), JSON.stringify(event) + "\n")
    }
  }
}

async function connect(port: number) {
  const target = await until("DevTools page target", 90_000, async () => {
    const list: Json[] = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json(), () => [])
    return list.find((item) => item.type === "page" && item.url.startsWith("oc://renderer"))
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const pending = new Map<number, (message: Json) => void>()
  socket.onmessage = (message) => {
    const data = JSON.parse(String(message.data))
    pending.get(data.id)?.(data)
    pending.delete(data.id)
  }
  const counter = { id: 0 }
  const send = (method: string, params: Json = {}) =>
    new Promise<Json>((resolve, reject) => {
      const id = ++counter.id
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => reject(new Error(`${method} timed out`)), 20_000)
    })
  const evaluate = async (expression: string) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (response.result?.exceptionDetails) throw new Error(`${expression}: ${response.result.exceptionDetails.exception?.description}`)
    return response.result?.result?.value
  }
  return {
    send,
    eval: evaluate,
    close: () => socket.close(),
    // A window that is never shown (Windows session 0) may not produce frames: the screenshot is best effort.
    shot: async (name: string) => {
      const response = await send("Page.captureScreenshot", { format: "png" }).catch((error) => ({ error: String(error) }))
      if (response.result?.data) return writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(response.result.data, "base64"))
      results.shotErrors = [...(results.shotErrors ?? []), `${name}: ${JSON.stringify(response.error ?? response).slice(0, 200)}`]
    },
    key: async (key: string, code: number) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, text: key === "Enter" ? "\r" : undefined })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code })
    },
  }
}

async function until<T>(what: string, timeout: number, probe: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await Promise.resolve().then(probe).catch(() => undefined)
    if (value) return value
    await Bun.sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}
