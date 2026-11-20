// S11: an administrator journal kept by the product plugin through its hooks alone (`tool` execute.before/after and
// `session` model.request/http.request/http.response) records every agent action and every model request. Paths:
// a direct tool call, CodeMode `execute` with nested calls, a `subagent` child, a `schedule_create` wake, and model
// requests reconciled per Session against the scripted model's own log. Probes beyond the five paths: a scheduled
// code check, a scheduled shell check and stateless `POST /api/experimental/generate/text`.
import { existsSync } from "node:fs"
import path from "node:path"
import { lines, makeEnv, report, SPIKE } from "./env"
import { script } from "./mock-llm"

const journalFile = path.join(SPIKE, ".run", "s11", "journal.jsonl")
const env = await makeEnv("s11", {
  port: 47300,
  plugins: [],
  extraEnv: { LOGINOM_SPIKE_BUILTIN: "1", LOGINOM_SPIKE_U3: "1", OPENCODE_FLAGS: "schedules", LOGINOM_SPIKE_JOURNAL: journalFile },
})
const journal = () => (existsSync(journalFile) ? lines(journalFile) : [])
const entries = (sessionID: string, kind?: string) => journal().filter((e) => e.sessionID === sessionID && (!kind || e.kind === kind))
const todo = (content: string) => ({ todos: [{ content, status: "pending" }] })
const toolParts = async (sessionID: string) =>
  ((await env.api.messages(sessionID)).body.data as { content?: { type: string; id: string; name: string; state?: { status?: string } }[] }[])
    .flatMap((m) => m.content ?? [])
    .filter((part) => part.type === "tool")
    .map((part) => ({ id: part.id, name: part.name, status: part.state?.status }))
// Every tool part the Session stored has a journal `tool.before` with the same call id; `after` is absent only for
// calls rejected before execution.
const reconcileTools = async (sessionID: string) => {
  const parts = await toolParts(sessionID)
  const before = entries(sessionID, "tool.before")
  return { parts, missing: parts.filter((part) => !before.some((e) => e.callID === part.id)).map((part) => part.id) }
}
const short = (e: Record<string, unknown>) => ({ kind: e.kind, tool: e.tool, callID: e.callID, status: e.status })
async function pendingPermission(sessionID: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const list = (await env.api.permissions(sessionID)).body?.data ?? []
    if (list.length) return list[0]
    await Bun.sleep(100)
  }
  return undefined
}

try {
  const results: Record<string, any> = {}

  // 1. Direct calls in the first Session after start (no warm-up): an allowed core tool and a privileged one the gate rejects.
  const direct = await env.api.createSession()
  await env.api.prompt(direct, script([{ tool: "todowrite", input: todo("direct") }, { tool: "loginom_dock_prepare", input: { intent: "direct" } }, { text: "end" }]))
  await env.api.wait(direct)
  results.direct = { journal: entries(direct).filter((e) => e.kind.startsWith("tool")).map(short), ...(await reconcileTools(direct)) }

  // 2. CodeMode: one allowed core call and one privileged call the gate rejects, each inside its own `execute`.
  const codemode = await env.api.createSession()
  await env.api.prompt(codemode, script([
    { tool: "execute", input: { code: "return await tools.opencode.models({ query: 'spike' })" } },
    { tool: "execute", input: { code: "return await tools.loginom_dock_codemode({ intent: 'codemode' })" } },
    { text: "end" },
  ]))
  await env.api.wait(codemode)
  results.codemode = { journal: entries(codemode).filter((e) => e.kind.startsWith("tool")).map(short), ...(await reconcileTools(codemode)) }

  // 3. Subagent: the parent spawns a child that calls a tool.
  const parent = await env.api.createSession()
  const child = script([{ tool: "todowrite", input: todo("from-child") }, { text: "child end" }])
  await env.api.prompt(parent, script([{ tool: "subagent", input: { agent: "general", description: "spike child", prompt: child } }, { text: "parent end" }]))
  await env.api.wait(parent)
  await Bun.sleep(4000)
  const childID = journal().find((e) => e.kind === "tool.before" && e.input?.todos?.[0]?.content === "from-child")?.sessionID as string | undefined
  if (childID) await env.api.wait(childID)
  results.subagent = {
    parent: { journal: entries(parent).filter((e) => e.kind.startsWith("tool")).map(short), ...(await reconcileTools(parent)) },
    child: childID ? { sessionID: childID, journal: entries(childID).filter((e) => e.kind.startsWith("tool")).map(short), ...(await reconcileTools(childID)) } : null,
  }

  // 4. Schedule: a wake 3 s later calls a tool after the creating turn has ended. Scheduled checks run alongside.
  const scheduled = await env.api.createSession()
  const wake = script([{ tool: "todowrite", input: todo("from-schedule") }, { text: "wake end" }])
  await env.api.prompt(scheduled, script([{ tool: "execute", input: { code: `return await tools.opencode.schedule_create({ when: { in: "3 seconds" }, prompt: ${JSON.stringify(wake)} })` } }, { text: "scheduled" }]))

  // Probe: a code check runs a Code Mode program on its slot with no model step.
  // Both checks use `if` and never pass, so every run after creation is an unattended slot with no wake and no model.
  const codeCheck = await env.api.createSession()
  await env.api.prompt(codeCheck, script([{ tool: "execute", input: { code: `return await tools.opencode.schedule_create({ when: { every: "15 seconds" }, if: { code: "const found = await tools.opencode.models({ query: 'check' }); return false" }, prompt: "never" })` } }, { text: "code check scheduled" }]))
  // Probe: a shell check runs a command on its slot with no model step and no tool call. A shell `if` without
  // `changes` is not seeded at creation, so the marker can only come from a slot run.
  const shellCheck = await env.api.createSession()
  await env.api.prompt(shellCheck, script([{ tool: "execute", input: { code: `return await tools.opencode.schedule_create({ when: { every: "15 seconds" }, if: { run: "touch shell-check-ran && false" }, prompt: "never" })` } }, { text: "shell check scheduled" }]))
  const asked: Record<string, unknown> = {}
  for (const [name, sessionID] of [["codeCheck", codeCheck], ["shellCheck", shellCheck]] as const) {
    const permission = await pendingPermission(sessionID, 50)
    asked[name] = permission ? { action: permission.action, resources: permission.resources } : null
    if (permission) await env.api.reply(sessionID, permission.id, "once")
  }
  for (const sessionID of [scheduled, codeCheck, shellCheck]) await env.api.wait(sessionID)
  const turnsEnded = Date.now()
  const markerBefore = existsSync(path.join(env.project, "shell-check-ran"))
  await Bun.sleep(40000)
  for (const sessionID of [scheduled, codeCheck, shellCheck]) await env.api.wait(sessionID)
  const schedules = async (sessionID: string) =>
    ((await env.api.call("GET", `/api/experimental/schedule?sessionID=${sessionID}`)).body?.data ?? []).map((s: any) => ({ runCount: s.runCount, lastOutcome: s.lastOutcome }))
  results.schedule = { journal: entries(scheduled).filter((e) => e.kind.startsWith("tool")).map(short), ...(await reconcileTools(scheduled)) }
  results.scheduleChecks = {
    asked,
    codeCheck: {
      schedule: await schedules(codeCheck),
      checkRunsJournaled: entries(codeCheck, "tool.after").filter((e) => /_check_\d+_/.test(e.callID)).map((e) => ({ tool: e.tool, callID: e.callID, status: e.status, afterTurn: e.t > turnsEnded })),
      modelRequestsAfterTurn: entries(codeCheck, "model.request").filter((e) => e.t > turnsEnded).length,
    },
    shellCheck: {
      schedule: await schedules(shellCheck),
      markerBeforeSlots: markerBefore,
      markerAfterSlots: existsSync(path.join(env.project, "shell-check-ran")),
      journalAfterTurn: entries(shellCheck).filter((e) => e.t > turnsEnded).map(short),
    },
  }

  // A provider failure: the request is still journaled, with the response status.
  const failed = await env.api.createSession()
  await env.api.prompt(failed, script([{ status: 400 }]))
  await env.api.wait(failed)

  // Probe: stateless generation outside any Session.
  const generate = await env.api.call("POST", "/api/experimental/generate/text", { prompt: "spike generate" })
  results.generate = { status: generate.status, body: generate.body }

  // 5. Every model request the scripted model received, per Session, against the journal.
  await Bun.sleep(1000)
  const mock = env.llm()
  const sessions = [...new Set(mock.map((e) => e.sessionID))]
  results.sessions = { direct, codemode, parent, child: childID, scheduled, codeCheck, shellCheck, failed }
  const label = (sessionID: string | null) => Object.entries(results.sessions).find(([, id]) => id === sessionID)?.[0] ?? "no session"
  results.modelRequests = sessions.map((sessionID) => ({
    path: label(sessionID),
    sessionID,
    mock: mock.filter((e) => e.sessionID === sessionID).length,
    modelRequest: sessionID ? entries(sessionID, "model.request").length : 0,
    httpRequest: sessionID ? entries(sessionID, "http.request").length : 0,
    httpResponse: sessionID ? entries(sessionID, "http.response").length : 0,
    kinds: sessionID ? entries(sessionID, "model.request").map((e) => e.requestKind) : [],
    statuses: sessionID ? entries(sessionID, "http.response").map((e) => e.status) : [],
  }))
  results.journalLines = journal().length

  const r = results
  const has = (list: any[], kind: string, tool: string, status?: string) => list.some((e) => e.kind === kind && e.tool === tool && (!status || e.status === status))
  const sessionRows = r.modelRequests.filter((row: any) => row.sessionID)
  const paths = {
    direct:
      has(r.direct.journal, "tool.after", "todowrite", "completed") &&
      has(r.direct.journal, "tool.denied", "loginom_dock_prepare") &&
      r.direct.missing.length === 0,
    codemode:
      has(r.codemode.journal, "tool.after", "execute", "completed") &&
      has(r.codemode.journal, "tool.after", "opencode_models", "completed") &&
      has(r.codemode.journal, "tool.denied", "loginom_dock_codemode") &&
      r.codemode.missing.length === 0,
    subagent:
      has(r.subagent.parent.journal, "tool.after", "subagent", "completed") &&
      r.subagent.child !== null &&
      has(r.subagent.child.journal, "tool.after", "todowrite", "completed") &&
      r.subagent.child.missing.length === 0,
    schedule:
      has(r.schedule.journal, "tool.after", "opencode_schedule_create", "completed") &&
      entries(scheduled, "tool.before")
        .filter((e) => e.input?.todos?.[0]?.content === "from-schedule")
        .some((wake) => entries(scheduled, "tool.after").some((e) => e.callID === wake.callID && e.status === "completed")) &&
      r.schedule.missing.length === 0,
    modelRequests:
      sessionRows.length >= 8 &&
      sessionRows.every((row: any) => row.mock === row.modelRequest && row.mock === row.httpRequest && row.mock === row.httpResponse) &&
      sessionRows.some((row: any) => row.kinds.includes("title")) &&
      sessionRows.some((row: any) => row.statuses.includes(400)),
  }
  // Probes beyond the five paths. A probe that did not run measured nothing, so it fails the check instead of passing.
  const shell = r.scheduleChecks.shellCheck
  const probes = {
    // Stateless generation reached the scripted model; the journal covers it only if every model request is journaled.
    generate: {
      ran: r.generate.status === 200 && r.modelRequests.some((row: any) => row.sessionID === null && row.mock > 0),
      journaled: journal().filter((e) => e.kind === "model.request").length === mock.length,
    },
    // The shell check ran on its own slot after the creating turn; the journal covers it only with an entry after that turn.
    shellCheck: { ran: !shell.markerBeforeSlots && shell.markerAfterSlots, journaled: shell.journalAfterTurn.length > 0 },
    // The schedule itself reports a slot check; the journal covers it with a check-run tool call after the turn.
    codeCheck: {
      ran: r.scheduleChecks.codeCheck.schedule.some((s: any) => s.lastOutcome === "checked"),
      journaled: r.scheduleChecks.codeCheck.checkRunsJournaled.some((e: any) => e.afterTurn),
    },
  }
  results.paths = paths
  results.probes = probes
  const allPaths = Object.values(paths).every(Boolean)
  const allRan = Object.values(probes).every((probe) => probe.ran)
  const allJournaled = Object.values(probes).every((probe) => probe.journaled)
  report("S11", !allPaths || !allRan ? "FAIL" : allJournaled ? "PASS" : "PARTIAL", results)
} finally {
  env.stop()
}
