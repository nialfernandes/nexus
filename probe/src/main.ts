import { Modal, Notice, Platform, Plugin, apiVersion } from "obsidian";
import type { App } from "obsidian";
import { runProbe } from "./probe";
import type { HostInfo, ProbeReport, ProgressEvent, StepRef } from "./probe";
import { formatReport } from "./report";

const COMMAND_ID = "run-probe";
const COMMAND_NAME = "Run the probe";
const RIBBON_ICON = "shield-check";
const RIBBON_TITLE = "Nexus probe: run the checks";

/** What is kept between runs, so a run the app cut short can still be reported. */
interface SavedRun {
  report: ProbeReport;
  /** The check that was running when this was saved; null when the run finished. */
  current: StepRef | null;
}

function hostInfo(): HostInfo {
  return {
    obsidianVersion: apiVersion,
    platform: {
      isDesktop: Platform.isDesktop,
      isMobile: Platform.isMobile,
      isDesktopApp: Platform.isDesktopApp,
      isMobileApp: Platform.isMobileApp,
      isIosApp: Platform.isIosApp,
      isAndroidApp: Platform.isAndroidApp,
      isPhone: Platform.isPhone,
      isTablet: Platform.isTablet,
      isMacOS: Platform.isMacOS,
      isWin: Platform.isWin,
      isLinux: Platform.isLinux,
      isSafari: Platform.isSafari,
    },
  };
}

export default class NexusProbePlugin extends Plugin {
  /** The probe function, so the tests can run the built bundle without Obsidian. */
  static runProbe = runProbe;

  async onload(): Promise<void> {
    this.addRibbonIcon(RIBBON_ICON, RIBBON_TITLE, () => this.openProbe());
    this.addCommand({ id: COMMAND_ID, name: COMMAND_NAME, callback: () => this.openProbe() });
  }

  private openProbe(): void {
    new ProbeModal(this.app, this).open();
  }

  async loadSavedRun(): Promise<SavedRun | null> {
    const data = (await this.loadData()) as { run?: SavedRun } | null;
    return data?.run ?? null;
  }

  async saveRun(run: SavedRun): Promise<void> {
    await this.saveData({ run });
  }
}

class ProbeModal extends Modal {
  private label = "";
  private latest: ProbeReport | null = null;
  private stoppedDuring: StepRef | null = null;
  private labelInput: HTMLInputElement | null = null;
  private status: HTMLElement | null = null;
  private output: HTMLElement | null = null;
  private copyButton: HTMLButtonElement | null = null;
  private runButton: HTMLButtonElement | null = null;

  constructor(app: App, private readonly plugin: NexusProbePlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Nexus probe" });

    this.status = contentEl.createEl("p", { text: "Starting..." });

    const labelRow = contentEl.createDiv();
    labelRow.createEl("label", { text: "Note for this run: " });
    this.labelInput = labelRow.createEl("input", {
      type: "text",
      placeholder: "for example: iPhone, Lockdown Mode on",
    });
    this.labelInput.addEventListener("input", () => {
      this.label = this.labelInput?.value ?? "";
      this.render();
    });

    this.copyButton = contentEl.createEl("button", { text: "Copy results" });
    this.copyButton.addEventListener("click", () => void this.copy());

    this.output = contentEl.createEl("pre");
    this.output.style.whiteSpace = "pre-wrap";
    this.output.style.userSelect = "text";
    this.output.style.fontSize = "0.75em";

    this.runButton = contentEl.createEl("button", { text: "Run the probe again" });
    this.runButton.style.display = "none";
    this.runButton.addEventListener("click", () => {
      this.stoppedDuring = null;
      void this.run();
    });

    // A run the app was stopped in the middle of is a result too: show it and
    // wait, because starting a new run would overwrite what was saved.
    const saved = await this.plugin.loadSavedRun();
    if (saved?.current) {
      this.latest = saved.report;
      this.stoppedDuring = saved.current;
      this.setStatus(
        `The last run did not finish: the app stopped during "${saved.current.title}". ` +
          "That is a result. Copy it and send it back, then run the probe again.",
      );
      this.runButton.style.display = "";
      this.render();
      return;
    }
    await this.run();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    if (this.runButton) this.runButton.style.display = "none";
    this.setStatus("Running. The screen can freeze for a minute or more on a slow phone: leave it.");
    try {
      const report = await runProbe({
        host: hostInfo(),
        onProgress: (event) => this.onProgress(event),
      });
      this.latest = report;
      this.setStatus("Finished. Copy the results and send them back.");
    } catch (error) {
      this.setStatus(`The probe itself broke: ${String(error)}`);
    }
    this.render();
  }

  private async onProgress(event: ProgressEvent): Promise<void> {
    this.latest = event.report;
    if (event.current) this.setStatus(`Running: ${event.current.title}`);
    this.render();
    await this.plugin.saveRun({ report: event.report, current: event.current });
  }

  private setStatus(text: string): void {
    this.status?.setText(text);
  }

  private text(): string {
    if (!this.latest) return "";
    return formatReport(this.latest, { label: this.label, stoppedDuring: this.stoppedDuring });
  }

  private render(): void {
    this.output?.setText(this.text());
  }

  private async copy(): Promise<void> {
    const text = this.text();
    try {
      await navigator.clipboard.writeText(text);
      new Notice("Results copied.");
    } catch {
      // No clipboard permission: select the text so it can be copied by hand.
      if (this.output) {
        const range = document.createRange();
        range.selectNodeContents(this.output);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      new Notice("Could not copy by itself: the results are selected, copy them by hand.");
    }
  }
}
