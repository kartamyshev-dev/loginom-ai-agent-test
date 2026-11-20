// B0.1 (S10, S7 in the Desktop window): the GUI half of the demo plugin. It adds a page with a sidebar entry and calls
// the product plugin's RPC from the window: without a location (the server's default), in the project folder from
// `ctx.options.project` and in the folder of every open session. It calls on the page's button, and at window start
// only with `autoProbe`, so a run without it shows what the window warms by itself. Plain DOM, no JSX: not built.
// Main evaluates this file too, with placeholders for window modules and no `window`, so window work stays in setup.
const { Plugin, Page } = require("@opencode/plugin/gui")

const runner = {
  id: "loginom.runner",
  methods: { kvProbe: { input: { type: "object" }, output: { type: "object" } } },
  events: { stage: { schema: { type: "object" } } },
}

module.exports = {
  default: Plugin.define({
    setup(ctx) {
      const state = { started: Date.now(), calls: [], events: [] }
      // The harness reads the same record over the DevTools protocol.
      window.__loginomSpike = state
      const views = new Set()

      const draw = () => {
        for (const view of views) {
          view.textContent = ""
          const line = (text, style) => {
            const row = document.createElement("div")
            row.textContent = text
            if (style) row.setAttribute("style", style)
            view.append(row)
          }
          line("Loginom · страница GUI-плагина (B0.1, S10)", "font-weight:600;font-size:16px;margin-bottom:8px")
          line(`Плагин: ${ctx.id}. Папка проекта: ${ctx.options.project ?? "—"}`)
          line("Вызовы RPC loginom.runner.kvProbe из окна:", "margin-top:8px;font-weight:600")
          for (const call of state.calls)
            line(
              `+${call.t - state.started} мс · ${call.what} · ${call.ok ? "ok" : `${call.error.type ?? "error"}: ${call.error.message}`}`,
              call.ok ? "color:#1a7f37" : "color:#cf222e",
            )
          line(`События rpc.loginom.runner.stage в окне: ${state.events.length}`, "margin-top:8px;font-weight:600")
          for (const event of state.events) line(`+${event.t - state.started} мс · ${JSON.stringify(event.data)}`)
          const button = document.createElement("button")
          button.type = "button"
          button.textContent = "Повторить RPC"
          button.dataset.loginomAction = "probe"
          button.setAttribute("style", "margin-top:12px;padding:4px 10px;border:1px solid currentColor;border-radius:6px")
          button.onclick = () => void probeAll("кнопка")
          view.append(button)
        }
      }

      const probe = async (what, location) => {
        const t = Date.now()
        const result = await ctx.client
          .rpc(runner)
          .kvProbe({}, location ? { location } : undefined)
          .then(
            (output) => ({ ok: true, output }),
            (error) => ({ ok: false, error: { type: error?.type, message: error?.message ?? String(error) } }),
          )
        state.calls.push({ t, what, ...result })
        draw()
      }

      const probeAll = (when) => {
        const sessions = new Map(
          ctx.sessions
            .list()
            .filter((session) => session.location)
            .map((session) => [session.location.directory, session.location]),
        )
        return Promise.all([
          probe(`${when}, без location`),
          ctx.options.project ? probe(`${when}, папка проекта из options`, { directory: ctx.options.project }) : undefined,
          ...[...sessions.values()].map((location) => probe(`${when}, папка открытой сессии ${location.directory}`, location)),
        ])
      }

      ctx.client
        .rpc(runner)
        .events.on("stage", (event) => {
          state.events.push({ t: Date.now(), data: event.data })
          draw()
        }, { signal: ctx.signal })

      if (ctx.options.autoProbe) void probeAll("старт окна")

      ctx.add(Page, {
        id: "home",
        title: "Loginom",
        nav: { order: 0 },
        render() {
          const view = document.createElement("div")
          view.dataset.loginomPage = "home"
          view.setAttribute("style", "padding:24px;display:grid;gap:4px;font-size:13px")
          // Views of earlier visits are off the page by now.
          for (const old of views) if (!old.isConnected) views.delete(old)
          views.add(view)
          draw()
          return view
        },
      })
    },
  }),
}
