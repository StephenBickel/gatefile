import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { approvePlan } from "./planner";
import { buildInspectReport, formatInspectSummary } from "./inspect";
import { scoreRisk } from "./risk";
import { CommandOperation, FileOperation, PlanFile } from "./types";

// ── ANSI helpers ──────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const INVERSE = `${ESC}7m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const BG_RED = `${ESC}41m`;
const BG_GREEN = `${ESC}42m`;
const BG_YELLOW = `${ESC}43m`;

const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

function riskColor(level: string): string {
  if (level === "high") return RED;
  if (level === "medium") return YELLOW;
  return GREEN;
}

function riskBadge(level: string): string {
  const bg = level === "high" ? BG_RED : level === "medium" ? BG_YELLOW : BG_GREEN;
  return `${bg}${BOLD} ${level.toUpperCase()} ${RESET}`;
}

// ── Diff rendering ───────────────────────────────────────────────────

function renderDiffLines(before: string | undefined, after: string | undefined): string[] {
  const lines: string[] = [];

  if (!before && after) {
    // create — show all lines as additions
    for (const line of after.split("\n")) {
      lines.push(`${GREEN}+ ${line}${RESET}`);
    }
    return lines;
  }

  if (before && !after) {
    // delete — show all lines as removals
    for (const line of before.split("\n")) {
      lines.push(`${RED}- ${line}${RESET}`);
    }
    return lines;
  }

  if (before && after) {
    const oldLines = before.split("\n");
    const newLines = after.split("\n");

    // Simple line-by-line diff (not a proper LCS, but clear enough for review)
    const max = Math.max(oldLines.length, newLines.length);
    let i = 0;
    let j = 0;

    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        lines.push(`${DIM}  ${oldLines[i]}${RESET}`);
        i++;
        j++;
      } else {
        // Show removed lines from old
        while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
          lines.push(`${RED}- ${oldLines[i]}${RESET}`);
          i++;
          if (lines.length > max + 20) break; // guard against runaway
        }
        // Show added lines from new
        while (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
          lines.push(`${GREEN}+ ${newLines[j]}${RESET}`);
          j++;
          if (lines.length > max + 20) break;
        }
      }
    }
  }

  return lines;
}

// ── Section types for navigation ─────────────────────────────────────

interface FileSection {
  kind: "file";
  op: FileOperation;
  lines: string[];
}

interface CommandSection {
  kind: "command";
  op: CommandOperation;
  lines: string[];
}

type Section = FileSection | CommandSection;

function buildSections(plan: PlanFile): Section[] {
  const sections: Section[] = [];

  for (const op of plan.operations) {
    if (op.type === "file") {
      const fop = op as FileOperation;
      const actionLabel = fop.action === "create" ? `${GREEN}CREATE${RESET}` :
        fop.action === "delete" ? `${RED}DELETE${RESET}` :
        `${YELLOW}UPDATE${RESET}`;

      const header = `${BOLD}${CYAN}── File: ${fop.path} ${RESET}${actionLabel}`;
      const diff = renderDiffLines(fop.before, fop.after);
      sections.push({ kind: "file", op: fop, lines: [header, ...diff] });
    }

    if (op.type === "command") {
      const cop = op as CommandOperation;
      const opRisk = scoreRisk([cop]);
      const header = `${BOLD}${CYAN}── Command: ${RESET}${WHITE}${cop.command}${RESET}`;
      const details = [
        header,
        `   Risk: ${riskColor(opRisk.level)}${opRisk.level}${RESET} (score: ${opRisk.score})`,
        `   Timeout: ${cop.timeoutMs ?? "default (10s)"}`,
        `   Allow failure: ${cop.allowFailure ? "yes" : "no"}`,
        ...(cop.cwd ? [`   CWD: ${cop.cwd}`] : []),
        ...(opRisk.reasons.length > 0 ? opRisk.reasons.map((r) => `   ${DIM}${r}${RESET}`) : [])
      ];
      sections.push({ kind: "command", op: cop, lines: details });
    }
  }

  return sections;
}

// ── TUI State ────────────────────────────────────────────────────────

interface TUIState {
  plan: PlanFile;
  planPath: string;
  sections: Section[];
  allLines: string[];         // flattened renderable lines
  sectionOffsets: number[];   // line index where each section starts
  scrollY: number;
  viewportHeight: number;
  showHelp: boolean;
  currentSection: number;
  fileCount: number;
  commandCount: number;
}

function buildAllLines(state: TUIState): void {
  state.allLines = [];
  state.sectionOffsets = [];

  for (const section of state.sections) {
    state.sectionOffsets.push(state.allLines.length);
    state.allLines.push(...section.lines);
    state.allLines.push(""); // spacing between sections
  }
}

function currentSectionFromScroll(state: TUIState): number {
  for (let i = state.sectionOffsets.length - 1; i >= 0; i--) {
    if (state.scrollY >= state.sectionOffsets[i]) return i;
  }
  return 0;
}

function sectionLabel(state: TUIState): string {
  const idx = state.currentSection;
  const section = state.sections[idx];
  if (!section) return "";

  if (section.kind === "file") {
    const fileIdx = state.sections.slice(0, idx + 1).filter((s) => s.kind === "file").length;
    return `File ${fileIdx}/${state.fileCount}`;
  }
  const cmdIdx = state.sections.slice(0, idx + 1).filter((s) => s.kind === "command").length;
  return `Command ${cmdIdx}/${state.commandCount}`;
}

// ── Rendering ────────────────────────────────────────────────────────

function renderHeader(state: TUIState): string[] {
  const { plan } = state;
  const risk = riskBadge(plan.risk.level);
  const pos = sectionLabel(state);
  const approval = plan.approval.status === "approved"
    ? `${GREEN}APPROVED${RESET}`
    : `${YELLOW}${plan.approval.status.toUpperCase()}${RESET}`;

  return [
    `${INVERSE}${BOLD} gatefile review ${RESET}  ${pos}`,
    `${BOLD}Plan:${RESET} ${plan.id}  ${risk}  ${BOLD}Approval:${RESET} ${approval}`,
    `${BOLD}Summary:${RESET} ${plan.summary}`,
    `${DIM}Created: ${plan.createdAt}  Source: ${plan.source}${RESET}`,
    `${DIM}─────────────────────────────────────────────────────────────────${RESET}`
  ];
}

function renderFooter(state: TUIState): string[] {
  const { plan } = state;
  const fileOps = plan.operations.filter((o) => o.type === "file").length;
  const cmdOps = plan.operations.filter((o) => o.type === "command").length;
  const risk = `${riskColor(plan.risk.level)}${plan.risk.level}${RESET}`;

  return [
    `${DIM}─────────────────────────────────────────────────────────────────${RESET}`,
    `${fileOps} file change(s), ${cmdOps} command(s)  Overall risk: ${risk} (score: ${plan.risk.score})`,
    `${DIM}j/k:scroll  f:next file  c:next cmd  a:approve  r:reject  q:quit  ?:help${RESET}`
  ];
}

function renderHelp(): string[] {
  return [
    "",
    `${BOLD}${CYAN}  Keyboard Shortcuts${RESET}`,
    "",
    `  ${BOLD}j${RESET} / ${BOLD}↓${RESET}     Scroll down`,
    `  ${BOLD}k${RESET} / ${BOLD}↑${RESET}     Scroll up`,
    `  ${BOLD}f${RESET}         Jump to next file change`,
    `  ${BOLD}c${RESET}         Jump to next command`,
    `  ${BOLD}a${RESET}         Approve the plan`,
    `  ${BOLD}r${RESET}         Reject (exit non-zero)`,
    `  ${BOLD}q${RESET} / ${BOLD}ESC${RESET}   Quit without decision`,
    `  ${BOLD}?${RESET}         Toggle this help`,
    "",
    `  ${DIM}Press any key to dismiss${RESET}`,
    ""
  ];
}

function render(state: TUIState): void {
  const { stdout } = process;
  state.viewportHeight = (stdout.rows || 24) - 10; // reserve for header + footer

  const header = renderHeader(state);
  const footer = renderFooter(state);

  let body: string[];
  if (state.showHelp) {
    body = renderHelp();
  } else {
    const end = Math.min(state.scrollY + state.viewportHeight, state.allLines.length);
    body = state.allLines.slice(state.scrollY, end);
    // Pad if body is shorter than viewport
    while (body.length < state.viewportHeight) body.push("");
  }

  stdout.write(CLEAR_SCREEN);
  for (const line of header) stdout.write(line + "\n");
  for (const line of body) stdout.write(line + "\n");
  for (const line of footer) stdout.write(line + "\n");
}

// ── Navigation helpers ───────────────────────────────────────────────

function scrollDown(state: TUIState, amount = 1): void {
  const maxScroll = Math.max(0, state.allLines.length - state.viewportHeight);
  state.scrollY = Math.min(state.scrollY + amount, maxScroll);
  state.currentSection = currentSectionFromScroll(state);
}

function scrollUp(state: TUIState, amount = 1): void {
  state.scrollY = Math.max(0, state.scrollY - amount);
  state.currentSection = currentSectionFromScroll(state);
}

function jumpToNextOfKind(state: TUIState, kind: "file" | "command"): void {
  for (let i = state.currentSection + 1; i < state.sections.length; i++) {
    if (state.sections[i].kind === kind) {
      state.scrollY = state.sectionOffsets[i];
      state.currentSection = i;
      return;
    }
  }
  // Wrap around
  for (let i = 0; i <= state.currentSection; i++) {
    if (state.sections[i].kind === kind) {
      state.scrollY = state.sectionOffsets[i];
      state.currentSection = i;
      return;
    }
  }
}

// ── Main entry point ─────────────────────────────────────────────────

export async function reviewPlan(planPath: string): Promise<void> {
  const fullPath = resolve(planPath);
  const plan: PlanFile = JSON.parse(readFileSync(fullPath, "utf-8"));

  // Non-TTY fallback: print inspect output and exit
  if (!process.stdin.isTTY) {
    const report = buildInspectReport(plan);
    console.log(formatInspectSummary(plan, report));
    return;
  }

  const sections = buildSections(plan);

  if (sections.length === 0) {
    console.log("Plan has no operations to review.");
    return;
  }

  const state: TUIState = {
    plan,
    planPath: fullPath,
    sections,
    allLines: [],
    sectionOffsets: [],
    scrollY: 0,
    viewportHeight: 20,
    showHelp: false,
    currentSection: 0,
    fileCount: sections.filter((s) => s.kind === "file").length,
    commandCount: sections.filter((s) => s.kind === "command").length
  };

  buildAllLines(state);

  const { stdin, stdout } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf-8");
  stdout.write(HIDE_CURSOR);

  render(state);

  return new Promise<void>((resolvePromise, rejectPromise) => {
    function cleanup(): void {
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(SHOW_CURSOR);
      stdout.write(CLEAR_SCREEN);
    }

    function onResize(): void {
      render(state);
    }

    stdout.on("resize", onResize);

    stdin.on("data", (data: string) => {
      // Handle help dismissal
      if (state.showHelp) {
        state.showHelp = false;
        render(state);
        return;
      }

      // ESC sequences for arrow keys
      if (data === "\x1b[A" || data === "k") {
        scrollUp(state);
        render(state);
        return;
      }
      if (data === "\x1b[B" || data === "j") {
        scrollDown(state);
        render(state);
        return;
      }

      // Page up/down with shift or larger scroll
      if (data === "K") {
        scrollUp(state, state.viewportHeight);
        render(state);
        return;
      }
      if (data === "J") {
        scrollDown(state, state.viewportHeight);
        render(state);
        return;
      }

      if (data === "f") {
        jumpToNextOfKind(state, "file");
        render(state);
        return;
      }
      if (data === "c") {
        jumpToNextOfKind(state, "command");
        render(state);
        return;
      }

      if (data === "?") {
        state.showHelp = true;
        render(state);
        return;
      }

      // Approve
      if (data === "a") {
        cleanup();
        stdout.removeListener("resize", onResize);
        try {
          const approved = approvePlan(state.plan, process.env.USER ?? "reviewer");
          writeFileSync(state.planPath, JSON.stringify(approved, null, 2) + "\n", "utf-8");
          const hash = approved.approval.approvedPlanHash;
          console.log(`${GREEN}${BOLD}Plan approved.${RESET}`);
          console.log(`Approved by: ${approved.approval.approvedBy}`);
          console.log(`Approval hash: ${hash}`);
          console.log(`Written to: ${state.planPath}`);
          resolvePromise();
        } catch (err) {
          console.error(`Approval failed: ${(err as Error).message}`);
          rejectPromise(err);
        }
        return;
      }

      // Reject
      if (data === "r") {
        cleanup();
        stdout.removeListener("resize", onResize);
        console.log(`${RED}${BOLD}Plan rejected.${RESET}`);
        process.exitCode = 1;
        resolvePromise();
        return;
      }

      // Quit (q or ESC)
      if (data === "q" || data === "\x1b" || data === "\x03") {
        cleanup();
        stdout.removeListener("resize", onResize);
        resolvePromise();
        return;
      }
    });
  });
}
