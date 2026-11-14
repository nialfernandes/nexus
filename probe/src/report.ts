import type { CheckResult, CheckStatus, ProbeReport, StepRef } from "./probe";

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  skipped: "SKIP",
};

export interface ReportOptions {
  /** A note the person types, such as "iPhone, Lockdown Mode on". */
  label?: string;
  /** Set when the app stopped in the middle of this check. */
  stoppedDuring?: StepRef | null;
}

/** The platform flags that are true, as one line. */
function platformLine(platform: Record<string, boolean>): string {
  const on = Object.entries(platform)
    .filter(([, value]) => value)
    .map(([name]) => name);
  return on.length > 0 ? on.join(", ") : "(none reported)";
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

/** Counts of passed, failed and skipped checks. */
export function summarise(checks: readonly CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, skipped: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

/** The report as plain text, to show on screen and to copy and send back. */
export function formatReport(report: ProbeReport, options: ReportOptions = {}): string {
  const env = report.environment;
  const counts = summarise(report.checks);
  const lines: string[] = [];
  lines.push(`Nexus probe ${report.probeVersion}`);
  if (options.label && options.label.trim() !== "") lines.push(`Note: ${options.label.trim()}`);
  lines.push(`Started: ${report.startedAt}`);
  lines.push("");
  lines.push("Where it ran");
  lines.push(`  Obsidian: ${env.obsidianVersion ?? "unknown"}`);
  lines.push(`  Platform: ${platformLine(env.platform)}`);
  lines.push(`  User agent: ${env.userAgent}`);
  lines.push(`  Secure context: ${env.isSecureContext ?? "unknown"}`);
  lines.push(`  CPU cores: ${env.hardwareConcurrency ?? "unknown"}`);
  lines.push(`  Device memory (GiB, if reported): ${env.deviceMemoryGiB ?? "not reported"}`);
  lines.push("");
  lines.push("Checks");
  for (const check of report.checks) {
    const time = check.status === "skipped" ? "" : formatMs(check.ms);
    lines.push(`  ${STATUS_LABEL[check.status]}  ${time.padStart(12)}  ${check.title}`);
    lines.push(`        ${check.detail}`);
  }
  if (options.stoppedDuring) {
    lines.push(`  STOP  The app stopped during: ${options.stoppedDuring.title}`);
  }
  lines.push("");
  lines.push(
    `Result: ${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped; ` +
      `${formatMs(report.totalMs)} in all`,
  );
  return lines.join("\n");
}
