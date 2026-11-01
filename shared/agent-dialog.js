// Start an agent on a work item in a fresh git worktree, and the Prompts dialog behind the
// cog. Part of herdr-ranch-prs and herdr-ranch-issues: each opens itself as one of these dialogs with
// props.dialog "agent" or "prompts". The source is shared/agent-dialog.js.
//
// "agent" props: { mod, kind: "issue" | "pr", repo, on, key, title, icon, vars, branches, tabs }
//   repo:     a folder inside the repository (the main checkout is found from it)
//   on:       the machine (a space's `machine`), null for this computer
//   key, title, icon: what the header shows (icon: a kind from links.js, e.g. "bug", "pr")
//   vars:     the placeholders the prompt templates read (prompts.js PLACEHOLDERS)
//   branches: { mode: branch }, the new branch per mode, editable here
//   tabs:     { mode: name }, the new space's first tab per mode
// "prompts" props: { mod, kind, space }

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { run, props, closeOverlay, theme, exec, knownAgents, notify, spaces, home as localHome, window as appWindow } from "herdr";
const platform = () => { try { return appWindow().platform; } catch { return "macos"; } };
import { fs, icon, kindColor, avatar, spaceRepo } from "./links.js";
import { MODES, ABOUT, PLACEHOLDERS, DEFAULTS, fill, clean, repoPrompts, trustPrompts, userPrompts, saveUserPrompts, template, mainCheckout } from "./prompts.js";

const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const LAST = "agent:last";
const lastAgent = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
const keepAgent = (name) => { try { localStorage.setItem(LAST, name); } catch { /* best effort */ } };

// The home folder on the space's machine: this computer's from Herdr (Windows too), a remote one's
// from its shell. null when it can't be read (create() then refuses rather than guess a path).
async function homeOf(on) {
  if (!on) return localHome() || null;
  const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
  const h = r?.code === 0 ? r.stdout.trim() : "";
  return h.startsWith("/") ? h : null;
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout).trim() };
}

// Shared look for both dialogs.
function parts(t) {
  const label = (text) => div().text_size(fs.tiny).text_color(t.muted).child(text);
  const hint = (text, color) => div().text_size(fs.tiny).text_color(color ?? t.dim).child(text);
  const button = (id, text, kind, enabled, onClick) => h_flex().id(id).flex_none().gap(6).items_center().px(12).py(5).rounded(6).text_size(fs.meta)
    .when(kind === "primary", (e) => e.bg(enabled ? t.ansi2 : t.raised).text_color(enabled ? t.background : t.dim).font_semibold())
    .when(kind === "link", (e) => e.px(2).text_color(t.accent))
    .when(!kind, (e) => e.border_1().border_color(t.border).bg(t.background))
    .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
    .child(text);
  const seg = (id, options, current, pick) => h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().text_size(fs.meta)
    .children(options.map(([value, text], n) => div().id(`${id}-${value}`).px(10).py(3).cursor_pointer().when(n > 0, (e) => e.border_l_1().border_color(t.border))
      .when(current === value, (e) => e.bg(t.selected).font_semibold()).hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(value, cx)).child(text)));
  const chip = (id, text, on, onClick) => div().id(id).px(9).py(1).rounded_full().text_size(fs.tiny).cursor_pointer()
    .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.accent : t.muted).when(on, (e) => e.bg(t.accent + "14"))
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(text);
  const header = (title, sub) => v_flex().flex_none().gap(3).px(16).pt(14).pb(12).border_b_1().border_color(t.border)
    .child(div().font_semibold().text_size(fs.title + 1).child(title)).child(sub);
  const footer = (children) => h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t_1().border_color(t.border).bg(t.surface).children(children);
  return { label, hint, button, seg, chip, header, footer };
}
// Model and effort per agent (Program.key), with the flags each CLI takes. Others take their
// model from their own settings. The last choice per agent is kept in local storage.
const OPTIONS = {
  claude: { models: ["fable", "opus", "sonnet", "haiku"], efforts: ["low", "medium", "high", "xhigh", "max"],
    args: (m, e) => [...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : [])] },
  codex: { models: null, placeholder: "e.g. gpt-5-codex", efforts: ["low", "medium", "high"],
    args: (m, e) => [...(m ? ["-m", m] : []), ...(e ? ["-c", `model_reasoning_effort=${e}`] : [])] },
  opencode: { models: null, placeholder: "provider/model, e.g. anthropic/claude-sonnet-4", efforts: null,
    args: (m) => (m ? ["-m", m] : []) },
};
const optionsKey = (a) => `agent-opts:${a?.key ?? a?.name}`;
const lastOptions = (a) => { try { return JSON.parse(localStorage.getItem(optionsKey(a)) ?? "null") ?? {}; } catch { return {}; } };
const keepOptions = (a, o) => { try { localStorage.setItem(optionsKey(a), JSON.stringify(o)); } catch { /* best effort */ } };
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;

const SOURCE = { repo: "the repository's .herdr/prompts.md", yours: "your prompt (cog, Prompts…)", default: "the default prompt" };

export class AgentDialog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.kind = p.kind ?? "issue";
    // "Fix failing checks" only when a check fails.
    this.modes = MODES[this.kind].filter(([id]) => id !== "checks" || (p.vars?.failing && p.vars.failing !== "none"));
    this.mode = this.modes[0][0];
    this.agents = []; this.agent = null; this.busy = false; this.error = "";
    this.repoTemplates = {}; this.mine = userPrompts(p.mod);
    this.editing = false; this.edited = false; this.stay = false;
    this.branchState = null; this.main = null; this.base = ""; this.home = "";
    this.setBranch = p.branches?.[this.mode] ?? ""; this.typed = false;
    this.branch = InputState.new({ placeholder: "Branch", value: this.setBranch });
    // An unedited prompt follows the branch ({branch} in it).
    // Typing (anything not set by the dialog itself) is the person's: never rewritten under them.
    this.branch.on("change", (_e, cx) => {
      if (this.branch.value() !== this.setBranch) { this.typed = true; this.renamed = null; }
      if (!this.edited) this.fillPrompt();
      this.checkBranch(cx);
    });
    this.prompt = TextareaState.new({ placeholder: "Prompt", value: "", rows: 12 });
    this.prompt.on("change", (_e, cx) => { if (this.quiet === this.prompt.value()) return; this.edited = true; cx.notify(); });
    this.model = null; this.effort = null;
    this.modelText = InputState.new({ placeholder: "Model (empty: the agent's own setting)" });
    this.handle = cx.focus_handle();
    this.fillPrompt();
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: p.on ?? null });
        const ready = this.agents.filter((a) => a.installed);
        this.agent = ready.find((a) => a.name === lastAgent()) ?? ready[0] ?? null;
        this.loadOptions();
        if (!this.agent) this.error = "No installed agent found (programs.json `run` entries).";
      } catch (e) { this.error = `Cannot list agents: ${e}`; }
      cx.notify();
      try {
        this.main = await mainCheckout(p.repo, p.on ?? null);
        if (this.main) {
          this.repoTemplates = await repoPrompts(this.main, p.on ?? null);
          if (!this.edited) this.fillPrompt();
          this.base = (await git(this.main, ["rev-parse", "--abbrev-ref", "HEAD"], p.on ?? null)).out;
          this.home = (await homeOf(p.on ?? null)) ?? "";
        }
      } catch (e) { this.error ||= `Cannot read the repository: ${e?.message ?? e}`; }
      this.checkBranch(cx);
      cx.notify();
    });
  }

  // Esc, Cancel and Start close it here; the list gets the keyboard back. Not a Herdr hook (a child
  // view never gets one): a click beside the dialog goes through the root view's close().
  close() { closeOverlay(props().overlay); const m = props()?.mod; if (m) run(`${m}.focus`); }

  loadOptions() {
    const o = lastOptions(this.agent);
    const opts = OPTIONS[this.agent?.key];
    this.model = opts?.models?.includes(o.model) ? o.model : null;
    this.effort = opts?.efforts?.includes(o.effort) ? o.effort : null;
    this.modelText.set_value(OPTIONS[this.agent?.key]?.models ? "" : o.model ?? "");
  }

  // The chosen model and effort, as this agent's flags.
  extraArgs() {
    const o = OPTIONS[this.agent?.key];
    if (!o) return [];
    const model = o.models ? this.model : this.modelText.value().trim() || null;
    if (model && !SAFE.test(model)) throw new Error("A model name has letters, digits and . _ : / @ - only.");
    keepOptions(this.agent, { model, effort: this.effort });
    return o.args(model, o.efforts ? this.effort : null);
  }

  // The prompt of the chosen mode from its template; an edited prompt is replaced only by Reset or another mode.
  fillPrompt() {
    const [tpl, from] = template(this.mode, this.repoTemplates, this.mine);
    this.source = from;
    const text = fill(tpl, { ...(props()?.vars ?? {}), branch: this.branch.value().trim() });
    this.quiet = text; this.prompt.set_value(text); this.edited = false;
    // A repository's prompt is shown whole, not folded, so nothing in it goes unseen.
    if (from === "repo") this.editing = true;
  }

  // A mode brings its own branch and prompt, unless the person changed them: those stay
  // (Reset brings the mode's prompt back).
  pickMode(mode, cx) {
    this.mode = mode;
    const b = props()?.branches?.[mode];
    if (b && !this.typed) { this.renamed = null; this.setBranch = b; this.branch.set_value(b); }
    if (!this.edited) this.fillPrompt();
    this.checkBranch(cx); cx.notify();
  }

  checkBranch(cx) {
    const branch = this.branch.value().trim(), on = props()?.on ?? null;
    if (!this.main || !branch) { this.branchState = null; cx.notify(); return; }
    const n = this.branchSeq = (this.branchSeq ?? 0) + 1;
    cx.spawn(async (cx) => {
      await cx.sleep(250);
      if (n !== this.branchSeq) return;
      if (!(await git(this.main, ["check-ref-format", "--branch", branch], on)).ok) { if (n === this.branchSeq) { this.branchState = "invalid"; cx.notify(); } return; }
      const exists = (await git(this.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], on)).ok;
      const remote = !exists && (await git(this.main, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], on)).ok;
      if (n !== this.branchSeq) return;
      // Checked out in another worktree (a second start on the same item): git can't use it
      // again, so the next free name is picked: branch-2, branch-3, …
      const used = exists ? (await git(this.main, ["worktree", "list", "--porcelain"], on)).out.split("\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice(18)) : [];
      if (used.includes(branch)) {
        // Typed by the person: say so instead of changing their text.
        if (this.typed) { this.branchState = "busy"; cx.notify(); return; }
        let k = 2, next;
        do { next = `${branch.replace(/-\d+$/, "")}-${k++}`; } while (k < 50 && (used.includes(next) || (await git(this.main, ["show-ref", "--verify", "--quiet", `refs/heads/${next}`], on)).ok));
        if (n !== this.branchSeq) return;
        this.renamed = branch; this.setBranch = next; this.branch.set_value(next); cx.notify(); return;
      }
      this.branchState = exists ? "exists" : remote ? "remote" : "new"; cx.notify();
    });
  }

  start(cx) {
    if (this.busy || !this.agent) return;
    this.busy = true; this.error = "";
    cx.spawn(async (cx) => {
      try { await this.create(); this.close(); }
      catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      cx.notify();
    });
    cx.notify();
  }

  async create() {
    const p = props(), on = p.on ?? null, branch = this.branch.value().trim();
    const prompt = clean(this.prompt.value()).trim();
    if (!branch) throw new Error("Type a branch name.");
    if (!prompt) throw new Error("Type a prompt.");
    const extra = this.extraArgs();
    const main = this.main ?? await mainCheckout(p.repo, on);
    if (!main) throw new Error("Not a git repository.");
    const name = main.split("/").pop();
    const home = this.home || await homeOf(on);
    if (!home) throw new Error("Cannot find the home folder on that machine.");
    // Checked here, not only through branchState: ⌘↵ inside checkBranch's 250 ms wait, or before
    // the repository loaded, would otherwise skip these.
    if (!(await git(main, ["check-ref-format", "--branch", branch], on)).ok) throw new Error(`"${branch}" isn't a valid branch name.`);
    // Same place as Herdr's own worktree mod, so its sidebar nests the space under the repo.
    const path = `${home}/.herdr/worktrees/${name}/${slug(branch)}`;
    const exists = (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], on)).ok;
    const remote = !exists && (await git(main, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], on)).ok;
    if (exists) {
      const used = (await git(main, ["worktree", "list", "--porcelain"], on)).out.split("\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice(18));
      if (used.includes(branch)) throw new Error(`${branch} is checked out in another worktree: pick another name.`);
    }
    // An existing branch is reused; one only on origin starts from there, tracking it.
    const add = exists ? ["worktree", "add", path, branch] : remote ? ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`] : ["worktree", "add", "-b", branch, path, "HEAD"];
    const r = await git(main, add, on);
    if (!r.ok) throw new Error(r.err || "git worktree add failed.");
    const copied = await this.copyIncludes(main, path, on);
    const before = spaces().find((s) => s.active)?.id;
    keepAgent(this.agent.name);
    run("space.new", { name: cut(p.tabs?.[this.mode] ?? p.title ?? branch, 40), folder: path, machine: on, tab: p.tabs?.[this.mode] ?? p.title, argv: [...this.agent.run, ...extra], task: prompt });
    if (this.stay && before) run("space.select", { id: before });
    notify({ title: `Started ${this.agent.name}`, body: `${p.tabs?.[this.mode] ?? branch}${copied ? ` · ${copied} file${copied > 1 ? "s" : ""} from .worktreeinclude` : ""}`, level: "success", timeout: 4000 });
  }

  // `.worktreeinclude` in the main checkout lists gitignored files a worktree needs to run
  // (.env, config/local.json, globs too; the same format as the Worktree include mod). The ones
  // that exist are copied into the new worktree; nothing there is overwritten. Returns how many.
  async copyIncludes(main, path, on) {
    // -z: names come NUL-separated and unquoted, so spaces, newlines and non-ASCII names survive.
    // exec, not git(): git() trims, which would cut a leading space off the first name.
    const list = await exec("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-from=.worktreeinclude"], { cwd: main, on }).catch(() => null);
    if (list?.code !== 0 || !list.stdout) return 0;
    let n = 0;
    for (const file of list.stdout.split("\0").filter(Boolean).slice(0, 200)) {
      if (file.includes("..")) continue;
      const r = await (on || platform() !== "windows"
        ? exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && [ ! -e "$2" ] && cp -p "$1" "$2"', "sh", `${main}/${file}`, `${path}/${file}`], { on })
        : exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `$s='${`${main}/${file}`.replace(/'/g, "''")}'; $d='${`${path}/${file}`.replace(/'/g, "''")}'; if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $d) | Out-Null; Copy-Item -LiteralPath $s -Destination $d }`])).catch(() => null);
      if (r?.code === 0) n++;
    }
    return n;
  }

  render(cx) {
    const t = theme(), p = props() ?? {}, ui = parts(t);
    // Started for one space's item: a space switch closes it.
    const sp = spaces().find((x) => x.active)?.id ?? null;
    if (this.openSpace === undefined) this.openSpace = sp;
    else if (sp !== this.openSpace && !this.busy) { try { cx.timer.after(0, () => this.close()); } catch { /* next change */ } }
    const branch = this.branch.value().trim();
    const modes = this.modes;
    const verb = this.kind === "pr" ? (this.mode === "review" ? "Start review" : "Start agent") : "Start agent";
    const agentCard = (a) => {
      const on = this.agent === a, ok = a.installed;
      return h_flex().id(`agent-${a.name}`).gap(8).items_center().px(10).py(7).rounded(8).min_w(150)
        .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.accent + "10"))
        .when(!ok, (e) => e.opacity(0.5))
        .when(ok, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.agent = a; this.loadOptions(); cx.notify(); }))
        .child(avatar(a.name, t, 24))
        .child(v_flex().child(div().text_size(fs.meta).child(a.name))
          .child(div().text_size(fs.tiny).text_color(t.dim).child(!ok ? "not installed" : a.name === lastAgent() ? "last used" : "installed")));
    };
    const preview = this.prompt.value().split("\n").slice(0, 5).join("\n");
    const path = this.main ? `${this.home ? "~" : ""}/.herdr/worktrees/${this.main.split("/").pop()}/${slug(branch || "…")}` : "";
    return v_flex().id("dispatch").size_full().text_size(fs.body).text_color(t.foreground).bg(t.background).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.start(cx); cx.stop_propagation(); }
      })
      .child(ui.header(this.kind === "pr" && this.mode === "review" ? "Review with agent" : "Start agent", h_flex().gap(6).items_center().min_w(0).text_size(fs.meta)
        .when(Boolean(p.icon), (e) => e.child(icon(p.icon, kindColor(p.icon, t), 14)))
        .when(Boolean(p.key), (e) => e.child(div().flex_none().text_color(t.dim).child(p.key)))
        .child(div().min_w(0).truncate().font_semibold().child(p.title ?? ""))))
      .child(v_flex().id("dispatch-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(12)
        .child(v_flex().gap(4).child(ui.label("Agent"))
          .child(h_flex().gap(8).flex_wrap().children(this.agents.filter((a) => a.installed).map(agentCard)))
          .when(this.agents.some((a) => !a.installed), (e) => e.child(ui.hint(`${this.agents.filter((a) => !a.installed).length} more known agents aren't installed on this machine.`))))
        .when(Boolean(this.agent), (e) => {
          const o = OPTIONS[this.agent.key];
          if (!o) return e.child(ui.hint(`${this.agent.name} takes its model from its own settings.`));
          return e.child(h_flex().gap(16).flex_wrap().items_start()
            .child(v_flex().gap(4).child(ui.label("Model"))
              .child(o.models ? h_flex().gap(6).flex_wrap().child(ui.chip("model-default", "Default", !this.model, (cx) => { this.model = null; cx.notify(); }))
                  .children(o.models.map((m) => ui.chip(`model-${m}`, m, this.model === m, (cx) => { this.model = m; cx.notify(); })))
                : div().w(300).px(8).py(4).rounded(6).border_1().border_color(t.input).text_size(fs.meta).child(Input.new(this.modelText))))
            .when(Boolean(o.efforts), (e) => e.child(v_flex().gap(4).child(ui.label("Effort"))
              .child(h_flex().gap(6).flex_wrap().child(ui.chip("effort-default", "Default", !this.effort, (cx) => { this.effort = null; cx.notify(); }))
                .children(o.efforts.map((x) => ui.chip(`effort-${x}`, x, this.effort === x, (cx) => { this.effort = x; cx.notify(); })))))));
        })
        .child(v_flex().gap(4).child(ui.label("Mode"))
          .child(h_flex().child(ui.seg("mode", modes, this.mode, (m, cx) => this.pickMode(m, cx))))
          .child(ui.hint(ABOUT[this.mode])))
        .child(v_flex().gap(4)
          .child(ui.label("Branch"))
          .child(h_flex().gap(8).items_center().px(8).py(5).rounded(6).border_1().border_color(t.input)
            .child(div().flex_1().min_w(0).font_family("Menlo").text_size(fs.meta).child(Input.new(this.branch)))
            .when(Boolean(this.branchState), (e) => e.child(div().flex_none().text_size(fs.tiny).text_color(this.branchState === "busy" || this.branchState === "invalid" ? t.ansi1 : this.branchState === "new" ? t.dim : t.ansi3)
              .child({ exists: "exists: reuses it", remote: "on origin: starts from it", busy: "in use by another worktree", invalid: "not a valid branch name" }[this.branchState] ?? (this.renamed ? `new (${this.renamed} is in use)` : "new")))))
          .when(Boolean(this.main), (e) => e.child(ui.hint(`from ${this.base || "HEAD"} (the main checkout) · worktree ${path}`))))
        .when(Boolean(p.fork), (e) => e.child(h_flex().gap(8).items_center().px(10).py(7).rounded(6).bg(t.ansi3 + "1a").text_size(fs.meta).text_color(t.foreground)
          .child(icon("alert", t.ansi3, 13))
          .child(div().flex_1().min_w(0).child("This pull request comes from a fork: the agent builds and runs its code on this machine, with your environment. Only for authors you trust."))))
        .when(Boolean(this.repoTemplates?.templates?.[this.mode] && !this.repoTemplates.trusted), (e) => e.child(h_flex().gap(8).items_center().px(10).py(7).rounded(6).bg(t.surface).text_size(fs.meta).text_color(t.muted)
          .child(div().flex_1().min_w(0).child("This repository has its own prompts (.herdr/prompts.md). They're used only after you've read them."))
          .child(ui.button("trust-prompts", "Show and use them", "link", true, (cx) => { trustPrompts(this.repoTemplates); this.repoTemplates.trusted = true; this.fillPrompt(); cx.notify(); }))))
        .child(v_flex().gap(4)
          .child(h_flex().gap(8).items_center().child(div().flex_1().child(ui.label("Prompt")))
            .child(ui.hint(this.edited ? `edited (was ${SOURCE[this.source]})` : `from ${SOURCE[this.source]}`))
            .when(this.edited, (e) => e.child(ui.button("reset", "Reset", "link", true, (cx) => { this.fillPrompt(); cx.notify(); })))
            .child(ui.button("edit", this.editing ? "Done" : "Edit", "link", true, (cx) => { this.editing = !this.editing; if (this.editing) this.prompt.focus(); cx.notify(); })))
          .child(this.editing ? div().h(240).px(8).py(5).rounded(6).border_1().border_color(t.accent).child(Textarea.new(this.prompt))
            : div().id("prompt-preview").px(10).py(8).rounded(6).border_1().border_color(t.border).bg(t.surface).text_size(fs.meta).text_color(t.muted)
              .cursor_pointer().on_click((_e, cx) => { this.editing = true; this.prompt.focus(); cx.notify(); })
              .child(div().max_h(96).overflow_hidden().child(preview))))
        .child(v_flex().gap(3).text_size(fs.tiny).text_color(t.muted)
          .child(`① Creates the worktree and branch ${branch || "…"}${this.branchState === "exists" ? " (the branch exists, so it is reused)" : ` from ${this.base || "HEAD"}`}; nothing is pushed.`)
          .child(`② Opens a new space "${p.tabs?.[this.mode] ?? p.title ?? ""}" and starts ${this.agent?.name ?? "the agent"} with this prompt.`)
          .child(h_flex().id("stay").gap(6).items_center().cursor_pointer().on_click((_e, cx) => { this.stay = !this.stay; cx.notify(); })
            .child(div().size(14).rounded(3).border_1().border_color(this.stay ? t.border : t.accent).when(!this.stay, (e) => e.bg(t.accent)).flex().items_center().justify_center()
              .when(!this.stay, (e) => e.child(icon("check", t.background, 10))))
            .child("Switch to the new space")))
        .when(Boolean(this.error), (e) => e.child(div().text_size(fs.meta).text_color(t.ansi1).child(this.error))))
      .child(ui.footer([
        div().flex_1().child(ui.hint("Esc cancels")),
        ui.button("cancel", "Cancel", null, true, () => this.close()),
        ui.button("start", this.busy ? "Starting…" : `${verb}  ⌘↵`, "primary", !this.busy && Boolean(this.agent) && this.branchState !== "invalid" && this.branchState !== "busy", (cx) => this.start(cx)),
      ]));
  }
}

// Cog → Prompts…: the person's template per mode, with placeholders and Reset.
export class PromptsDialog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.kind = p.kind ?? "issue"; this.mod = p.mod;
    this.mine = { ...userPrompts(p.mod) };
    this.mode = MODES[this.kind][0][0];
    this.text = TextareaState.new({ value: this.mine[this.mode] ?? DEFAULTS[this.mode], rows: 11 });
    this.repo = null; this.repoTemplates = {};
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const space = spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.active);
      const repo = await spaceRepo(space).catch(() => null);
      this.repo = repo;
      if (repo?.main) this.repoTemplates = await repoPrompts(repo.main, repo.on ?? null);
      cx.notify();
    });
  }

  // Esc, Cancel and Save close it here (not a Herdr hook: see AgentDialog.close).
  close() { closeOverlay(props().overlay); const m = props()?.mod; if (m) run(`${m}.focus`); }

  // Keeps what is typed for the mode on screen before switching.
  keep() {
    const v = this.text.value().trim();
    if (v && v !== DEFAULTS[this.mode].trim()) this.mine[this.mode] = v; else delete this.mine[this.mode];
  }

  pick(mode, cx) { this.keep(); this.mode = mode; this.text.set_value(this.mine[mode] ?? DEFAULTS[mode]); cx.notify(); }

  save() { this.keep(); saveUserPrompts(this.mod, this.mine); this.close(); }

  render(cx) {
    const t = theme(), ui = parts(t);
    const fromRepo = Boolean(this.repoTemplates?.trusted && this.repoTemplates.templates?.[this.mode]);
    const customized = Boolean(this.mine[this.mode]) || this.text.value().trim() !== DEFAULTS[this.mode].trim();
    return v_flex().id("prompts").size_full().text_size(fs.body).text_color(t.foreground).bg(t.background).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.save(); cx.stop_propagation(); }
      })
      .child(ui.header("Prompts", div().text_size(fs.meta).text_color(t.muted).child(`What Start agent sends, per mode. Placeholders fill in the ${this.kind === "pr" ? "pull request" : "issue"}.`)))
      .child(v_flex().id("prompts-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(10)
        .child(h_flex().gap(8).items_center().child(ui.seg("pmode", MODES[this.kind], this.mode, (m, cx) => this.pick(m, cx))).child(div().flex_1())
          .child(ui.chip("state", customized ? "yours" : "default", customized, () => {})))
        .child(ui.hint(ABOUT[this.mode]))
        .child(div().min_h(220).px(8).py(5).rounded(6).border_1().border_color(t.input).font_family("Menlo").text_size(fs.meta).overflow_hidden().child(Textarea.new(this.text)))
        .child(v_flex().gap(4).child(ui.label("Placeholders (click to insert)"))
          .child(h_flex().gap(6).flex_wrap().children(PLACEHOLDERS[this.kind].map((k) => ui.chip(`ph-${k}`, `{${k}}`, false, (cx) => { this.text.replace(`{${k}}`); this.text.focus(); cx.notify(); })))))
        .child(h_flex().gap(8).items_center().px(10).py(7).rounded(6).bg(t.surface).text_size(fs.meta).text_color(t.muted)
          .child(div().size(8).rounded_full().bg(fromRepo ? t.ansi3 : t.accent))
          .child(div().flex_1().min_w(0).child(!this.repo ? "No repository for this space: yours is used everywhere."
            : fromRepo ? `This repository's .herdr/prompts.md has its own "${MODES[this.kind].find(([id]) => id === this.mode)[1]}": it wins there.`
            : `This repository has no .herdr/prompts.md section for this mode, so this prompt is used. A "## ${MODES[this.kind].find(([id]) => id === this.mode)[1]}" section there would win once you approve it.`))))
      .child(ui.footer([
        ui.button("reset", "Reset to default", null, true, (cx) => { this.text.set_value(DEFAULTS[this.mode]); delete this.mine[this.mode]; cx.notify(); }),
        div().flex_1(),
        ui.button("cancel", "Cancel", null, true, () => this.close()),
        ui.button("save", "Save  ⌘↵", "primary", true, () => this.save()),
      ]));
  }
}
