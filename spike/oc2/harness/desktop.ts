// B0.1: the real Desktop (Electron) window of the sandbox under Xvfb. The window starts its own service from the sandbox
// CLI source with the built-in product plugin (LOGINOM_SPIKE_BUILTIN) and the demo plugin from config (server tools and
// the `./gui-experimental` page). The run drives the window over the DevTools protocol and records the service's SSE.
//   bun desktop.ts        → the whole check: screenshots in .run/b0-window/shots, report.json, JSON on stdout
//   bun desktop.ts start  → launch only and keep running (DevTools on 127.0.0.1:47182); `stop` ends it
//   B0_AUTO_PROBE=1       → the page's plugin also calls RPC in its window setup; evidence in .run/b0-window-autoprobe
// Needs the built desktop (`opencode/packages/desktop/out`) and Electron in its node_modules, see README.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { report, SPIKE } from "./env"
import { script, startMock } from "./mock-llm"

const AUTO_PROBE = process.env.B0_AUTO_PROBE === "1"
const RUN = path.join(SPIKE, ".run", AUTO_PROBE ? "b0-window-autoprobe" : "b0-window")
const DESKTOP = path.join(SPIKE, "opencode", "packages", "desktop")
const ROOT = path.join(RUN, "root")
const HOME = path.join(RUN, "home")
const PROJECT = path.join(RUN, "project")
const SHOTS = path.join(RUN, "shots")
const DEMO = path.join(SPIKE, "plugin", "loginom-ui-demo")
const PORT = 47180
const CDP_PORT = PORT + 2
// The CLI from source runs the `local` channel: its registration file under the test root's XDG state dir.
const REGISTRATION = path.join(ROOT, "state", "opencode", "service-local.json")

type Json = Record<string, any>

const command = process.argv[2] ?? "run"
const END = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

if (command === "start") {
  const app = launch()
  console.log(JSON.stringify({ started: true, cdp: CDP_PORT, project: PROJECT }))
  await app.electron.exited
  app.mock.stop(true)
}
if (command === "stop") stop()
if (command === "run") await run()

async function run() {
  const app = launch()
  const results: Json = {}
  const sse = { events: [] as Json[], controller: new AbortController() }
  try {
    const service = await until("service registration", 90_000, () =>
      existsSync(REGISTRATION) ? JSON.parse(readFileSync(REGISTRATION, "utf8")) : undefined,
    )
    const api = apiClient(service)
    void subscribe(service, sse)
    const cdp = await connect()
    const guiStarted = await until("GUI plugin setup in the window", 60_000, () =>
      cdp.eval("window.__loginomSpike?.started"),
    )
    // The draft's composer shows once onboarding has settled.
    await until("first draft", 60_000, () => cdp.eval(`!!document.querySelector("[contenteditable=true]")`))
    await Bun.sleep(1500)
    await cdp.shot("01-first-window")
    // The default layout is Top tabs; the page registry puts its entry into the vertical sidebar only.
    results.navInTopTabs = await cdp.eval(`!!document.querySelector("[data-slot=sidebar-plugin-pages]")`)
    results.warmedBeforeFirstRpc = setups(app.started)
    results.guiSetupMs = guiStarted - app.started

    // S10: the plugin is listed, the sidebar entry shows in Side tabs, and the page renders.
    await cdp.chord(",", "Comma", 188, 2)
    await cdp.clickText("button,a", "Расширения")
    await cdp.clickText("button,[role=tab]", "Плагины")
    await Bun.sleep(800)
    await cdp.shot("02-extensions-plugins")
    await cdp.clickText("button,a", "Предпочтения")
    await cdp.eval(`document.querySelector("[data-component=interface-mode] input[value=side]").click()`)
    await cdp.clickText("button,a", "Назад в приложение")
    results.nav = await until("plugin nav", 10_000, () =>
      cdp.eval(`document.querySelector("[data-slot=sidebar-plugin-pages]")?.innerText`),
    )
    await cdp.shot("03-side-tabs-nav")
    await cdp.eval(`document.querySelector("[data-slot=sidebar-plugin-pages] button").click()`)
    results.page = await until("plugin page", 10_000, () =>
      cdp.eval(`document.querySelector("[data-loginom-page]")?.innerText.split("\\n")[0]`),
    )
    await cdp.shot("04-plugin-page")

    // S7 in the window: the first RPC from the window, then a retry with no session work in between.
    results.setupsBeforeFirstRpc = setups(app.started).length
    await cdp.eval(`document.querySelector("[data-loginom-action=probe]").click()`)
    results.firstRpc = await calls(cdp, 2)
    await Bun.sleep(400)
    await cdp.shot("05-first-rpc")
    await Bun.sleep(1000)
    await cdp.eval(`document.querySelector("[data-loginom-action=probe]").click()`)
    results.retryRpc = (await calls(cdp, 4)).slice(2)
    await Bun.sleep(400)
    await cdp.shot("06-retry-rpc")
    results.setupsAfterRpc = setups(app.started)

    // Point 1: the permission of the demo save tool, answered in the window and over the API.
    const once = [{ tool: "loginom_package_save", input: { name: "ABC-анализ.lgp", folder: "/user" } }, { text: "Пакет «ABC-анализ.lgp» сохранён в /user." }]
    const reject = [{ tool: "loginom_package_save", input: { name: "Продажи.lgp", folder: "/user" } }, { text: "Пакет «Продажи.lgp» сохранён в /user." }]
    // Back from the page to the first-launch draft, the only tab so far.
    await cdp.eval(`document.querySelector("[data-slot=tab-link]").click()`)
    await until("draft composer", 10_000, () => cdp.eval(`!!document.querySelector("[contenteditable=true]")`))
    const windowOnce = await askInWindow(cdp, api, sse, script(once, "Сохрани пакет ABC-анализ в Loginom").replace("\n", " "), "Разрешить один раз", "07-dock-once", "08-once-result")
    await cdp.clickText("button", "Новая сессия")
    await until("new draft composer", 10_000, () => cdp.eval(`!!document.querySelector("[contenteditable=true]")`))
    const windowReject = await askInWindow(cdp, api, sse, script(reject, "Сохрани пакет Продажи в Loginom").replace("\n", " "), "Запретить", "09-dock-reject", "10-reject-result")
    const directory = windowOnce.directory
    const apiOnce = await askOverApi(api, sse, directory, script(once, "Сохрани пакет ABC-анализ в Loginom").replace("\n", " "), "once")
    const apiReject = await askOverApi(api, sse, directory, script(reject, "Сохрани пакет Продажи в Loginom").replace("\n", " "), "reject")
    results.permission = { windowOnce, apiOnce, windowReject, apiReject }
    results.sameAsApi = {
      once: same(windowOnce.outcome, apiOnce.outcome),
      reject: same(windowReject.outcome, apiReject.outcome),
    }

    // An RPC event published in the project folder reaches the plugin's page in the window.
    const session = (await api("POST", "/api/session", PROJECT, { location: { directory: PROJECT } })).data.id
    results.rpcStart = await api("POST", "/api/rpc/loginom.runner/start", PROJECT, { input: { sessionID: session, text: script([{ text: "rpc run" }]) } })
    results.windowRpcEvents = await until("RPC event in the window", 10_000, () =>
      cdp.eval(`window.__loginomSpike.events.length ? window.__loginomSpike.events : undefined`),
    )
    await cdp.eval(`document.querySelector("[data-slot=sidebar-plugin-pages] button").click()`)
    await Bun.sleep(800)
    await cdp.shot("11-page-rpc-event")
    results.memoryMB = memory(app.electron.pid, service.pid)
    cdp.close()

    const cold = results.firstRpc.find((call: Json) => call.what.includes("папка проекта"))
    const warm = results.retryRpc.find((call: Json) => call.what.includes("папка проекта"))
    results.points = {
      "1-permission": windowOnce.dock.includes("loginom.package.save") && results.sameAsApi.once && results.sameAsApi.reject ? "PASS" : "FAIL",
      "2-page-nav": results.nav === "Loginom" && results.page?.startsWith("Loginom") ? "PASS" : "FAIL",
      "3-warm-before-rpc": !cold?.ok && warm?.ok ? "NO: first RPC in a folder the window has not opened is rpc.unavailable; a retry succeeds" : cold?.ok ? "YES" : "FAIL",
    }
    writeFileSync(path.join(RUN, "report.json"), JSON.stringify(results, null, 2))
    const pass = results.points["1-permission"] === "PASS" && results.points["2-page-nav"] === "PASS"
    report("B0.1", pass ? "PASS" : "FAIL", results.points)
  } finally {
    sse.controller.abort()
    stop()
    app.mock.stop(true)
  }
}

function launch() {
  for (const dir of [ROOT, HOME, PROJECT, SHOTS]) rmSync(dir, { recursive: true, force: true })
  for (const dir of [HOME, PROJECT, SHOTS, path.join(ROOT, "config", "opencode")]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(PROJECT, "README.md"), "B0.1 project\n")
  // .run sits inside this checkout, a git worktree: without a repository of their own the home folder (onboarding puts
  // its default project there) and the project would resolve to the main checkout as their project.
  for (const dir of [HOME, PROJECT]) Bun.spawnSync(["git", "init", "-q", dir])
  for (const file of ["llm.jsonl", "plugin.jsonl", "sse.jsonl"]) writeFileSync(path.join(RUN, file), "")
  // OPENCODE_DESKTOP_TEST_ROOT points userData and the XDG dirs of the window and of its service here.
  writeFileSync(
    path.join(ROOT, "config", "opencode", "opencode.json"),
    JSON.stringify(
      {
        model: "spike/spike-model",
        providers: {
          spike: {
            name: "Spike",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${PORT + 1}/v1`, apiKey: "spike" },
            models: { "spike-model": { name: "Spike model", capabilities: { tools: true, input: ["text"], output: ["text"] } } },
          },
        },
        plugins: [{ package: DEMO, options: { project: PROJECT, autoProbe: AUTO_PROBE } }],
        // Saving a package asks the person; without the rule the demo tool runs unasked.
        permissions: [{ action: "loginom.package.save", resource: "*", effect: "ask" }],
      },
      null,
      2,
    ),
  )
  const mock = startMock(PORT + 1, path.join(RUN, "llm.jsonl"))
  const started = Date.now()
  const electron = Bun.spawn(
    [
      // setsid: the wrapper, Xvfb and every Electron process share one process group that `stop` ends.
      "setsid", "xvfb-run", "-a", "-s", "-screen 0 1440x900x24",
      path.join(DESKTOP, "node_modules", "electron", "dist", "electron"),
      DESKTOP, "--no-sandbox", `--remote-debugging-port=${CDP_PORT}`,
    ],
    {
      cwd: HOME,
      env: {
        PATH: process.env.PATH ?? "",
        HOME,
        LANG: "ru_RU.UTF-8",
        OPENCODE_CHANNEL: "local",
        OPENCODE_VERSION: "2.3.0-b0-window",
        // Unpackaged: the service runs `bun run src/index.ts serve --service` from the sandbox CLI.
        OPENCODE_DESKTOP_CLI_DEV: path.join(SPIKE, "opencode", "packages", "cli"),
        OPENCODE_DESKTOP_SERVER_CHANNEL: "local",
        OPENCODE_DESKTOP_TEST_ROOT: ROOT,
        OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(CDP_PORT),
        OPENCODE_DESKTOP_DISABLE_PROTOCOL_REGISTRATION: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        LOGINOM_SPIKE_BUILTIN: "1",
        LOGINOM_SPIKE_LOG: path.join(RUN, "plugin.jsonl"),
        LOGINOM_SPIKE_STATE: path.join(RUN, "state-loginom"),
      },
      stdout: Bun.file(path.join(RUN, "electron.log")),
      stderr: Bun.file(path.join(RUN, "electron.err")),
    },
  )
  writeFileSync(path.join(RUN, "ready.json"), JSON.stringify({ pid: electron.pid, mock: process.pid, cdp: CDP_PORT }))
  return { electron, mock, started }
}

function stop() {
  const ready = existsSync(path.join(RUN, "ready.json")) ? JSON.parse(readFileSync(path.join(RUN, "ready.json"), "utf8")) : {}
  const service = existsSync(REGISTRATION) ? JSON.parse(readFileSync(REGISTRATION, "utf8")) : {}
  // The service is detached from the window (its own session), so it is stopped by the pid it registered.
  for (const pid of [ready.pid && -ready.pid, service.pid, command === "stop" ? ready.mock : undefined].filter(Boolean)) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
}

// Plugin setups of the product plugin, by location, in ms since launch: which folders were activated.
function setups(started: number) {
  return lines(path.join(RUN, "plugin.jsonl"))
    .filter((entry) => entry.event === "setup")
    .map((entry) => ({ ms: entry.t - started, location: path.relative(RUN, entry.location) }))
}

async function calls(cdp: Awaited<ReturnType<typeof connect>>, count: number) {
  const list: Json[] = await until(`${count} RPC results`, 10_000, () =>
    cdp.eval(`window.__loginomSpike.calls.length >= ${count} ? window.__loginomSpike.calls : undefined`),
  )
  return list.map((call) => ({ what: call.what, ok: call.ok, ...(call.ok ? {} : { error: call.error.type }) }))
}

async function askInWindow(
  cdp: Awaited<ReturnType<typeof connect>>,
  api: ReturnType<typeof apiClient>,
  sse: { events: Json[] },
  prompt: string,
  button: string,
  dockShot: string,
  resultShot: string,
) {
  const from = sse.events.length
  await cdp.eval(`document.querySelector("[contenteditable=true]").focus()`)
  await cdp.send("Input.insertText", { text: prompt })
  await Bun.sleep(300)
  await cdp.key("Enter", 13)
  const asked = await until("permission.asked", 30_000, () => sse.events.slice(from).find((event) => event.type === "permission.asked"))
  await until("permission dock", 10_000, () => cdp.eval(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === ${JSON.stringify(button)})`))
  // The browser-extension offer covers the dock's right edge.
  await cdp.eval(`(() => {
    const text = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === "Control your browser")
    let node = text
    while (node && !node.querySelector?.("button[aria-label='Закрыть']")) node = node.parentElement
    node?.querySelector("button[aria-label='Закрыть']")?.click()
  })()`)
  await Bun.sleep(500)
  const dock = await cdp.eval(`(() => {
    let node = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === "Требуется разрешение")
    while (node && !node.querySelector?.("button")) node = node.parentElement
    return node?.innerText ?? ""
  })()`)
  await cdp.shot(dockShot)
  await cdp.clickText("button", button)
  const sessionID = asked.data.sessionID
  await ended(sse, sessionID)
  await Bun.sleep(1000)
  await cdp.shot(resultShot)
  return { sessionID, dock, directory: (await api("GET", `/api/session/${sessionID}`, PROJECT)).data.location.directory, outcome: await outcome(api, sse, sessionID) }
}

async function askOverApi(api: ReturnType<typeof apiClient>, sse: { events: Json[] }, directory: string, prompt: string, decision: string) {
  const sessionID = (await api("POST", "/api/session", directory, { location: { directory } })).data.id
  await api("POST", `/api/session/${sessionID}/prompt`, directory, { text: prompt })
  const asked = await until("permission.asked over API", 30_000, () =>
    sse.events.find((event) => event.type === "permission.asked" && event.data.sessionID === sessionID),
  )
  await api("POST", `/api/session/${sessionID}/permission/${asked.data.id}/reply`, directory, { decision })
  await ended(sse, sessionID)
  return { sessionID, outcome: await outcome(api, sse, sessionID) }
}

function ended(sse: { events: Json[] }, sessionID: string) {
  return until("end of execution", 30_000, () => sse.events.find((event) => END.has(event.type) && event.data.sessionID === sessionID))
}

// What a person and the model end up with: the request, the reply, the tool's result and the end of the turn.
async function outcome(api: ReturnType<typeof apiClient>, sse: { events: Json[] }, sessionID: string) {
  const own = sse.events.filter((event) => event.data?.sessionID === sessionID)
  const asked = own.find((event) => event.type === "permission.asked")!.data
  const tool = own.find((event) => event.type === "session.tool.success" || event.type === "session.tool.failed")!
  const end = own.find((event) => END.has(event.type))!
  const messages: Json[] = (await api("GET", `/api/session/${sessionID}/message`, PROJECT)).data
  const parts = messages.filter((message) => message.type === "assistant").flatMap((message) => message.content)
  return {
    asked: { action: asked.action, resources: asked.resources, title: asked.metadata?.title },
    reply: own.find((event) => event.type === "permission.replied")?.data.reply,
    tool: tool.type === "session.tool.success" ? { status: "completed", text: tool.data.content?.[0]?.text } : { status: "error", error: tool.data.error?.message },
    toolPart: parts.find((part) => part.type === "tool")?.state?.status,
    text: parts.filter((part) => part.type === "text").map((part) => part.text).join(" "),
    end: end.type + (end.data.reason ? `:${end.data.reason}` : ""),
  }
}

// The window's own SSE consumer is the app; this one records the same stream for the report.
async function subscribe(service: Json, sse: { events: Json[]; controller: AbortController }) {
  const response = await fetch(`${service.url}/api/event`, { headers: auth(service), signal: sse.controller.signal })
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

function auth(service: Json) {
  return { authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}` }
}

function apiClient(service: Json) {
  return async (method: string, route: string, directory: string, body?: unknown) => {
    const response = await fetch(service.url + route, {
      method,
      headers: { ...auth(service), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return text ? JSON.parse(text) : { status: response.status }
  }
}

async function connect() {
  const target = await until("DevTools page target", 60_000, async () => {
    const list: Json[] = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json(), () => [])
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
    new Promise<Json>((resolve) => {
      const id = ++counter.id
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
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
    shot: async (name: string) => {
      const response = await send("Page.captureScreenshot", { format: "png" })
      writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(response.result.data, "base64"))
    },
    clickText: async (selector: string, text: string) => {
      await until(`«${text}»`, 10_000, () =>
        evaluate(`(() => {
          const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))
          element?.click()
          return !!element
        })()`),
      )
      await Bun.sleep(600)
    },
    key: async (key: string, code: number) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, text: key === "Enter" ? "\r" : undefined })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code })
    },
    chord: async (key: string, code: string, keyCode: number, modifiers: number) => {
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers })
      await Bun.sleep(1000)
    },
  }
}

// RSS of the window's session (Xvfb, Electron main, renderer, GPU, utility) and of the detached service's session.
function memory(window: number, service: number) {
  const rss = (sid: number) =>
    Bun.spawnSync(["ps", "-o", "rss=", "--sid", String(sid)]).stdout.toString().split("\n").map(Number).filter(Boolean).reduce((a, b) => a + b, 0)
  return { window: Math.round(rss(window) / 1024), service: Math.round(rss(service) / 1024) }
}

function same(a: Json, b: Json) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function lines(file: string) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json)
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
