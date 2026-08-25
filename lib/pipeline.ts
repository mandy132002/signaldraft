import { resolveAndAnalyze, llmModelName, writeDraft } from "./draft";
import { buildClarifyRequest } from "./clarify";
import { loadCompanyWebsiteContext, mergeWorkplaceContext } from "./company-site";
import { upsertRun } from "./db";
import { loadLinkedInContext } from "./linkedin";
import { retrieveDraftMemory } from "./draft-memory-db";
import { researchProspect } from "./research";
import type { ProspectInput, RunRecord, StageEvent, StageStatus } from "./types";

export type PipelineListener = (run: RunRecord) => void;

function now() {
  return new Date().toISOString();
}

function newId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stages(): StageEvent[] {
  const labels = [
    ["intake", "Intake prospect"],
    ["company", "Company + LinkedIn / website"],
    ["news", "Public news & funding"],
    ["hiring", "Person + company signals"],
    ["rank", "Soft-rank candidates"],
    ["resolve", "Groq entity match"],
    ["analyze", "Groq analysis"],
    ["draft", "Draft outreach email"],
    ["review", "SDR review (not sent)"],
  ] as const;
  return labels.map(([id, label]) => ({
    id,
    label,
    detail: "Waiting",
    status: "pending",
    at: now(),
  }));
}

function setStage(run: RunRecord, id: string, status: StageStatus, detail: string) {
  const stamp = now();
  run.stages = run.stages.map((s) => {
    if (s.id !== id) return s;
    if (status === "running") {
      return { ...s, status, detail, at: stamp, startedAt: stamp, durationMs: undefined };
    }
    let durationMs = s.durationMs;
    if ((status === "done" || status === "error" || status === "paused") && s.startedAt) {
      durationMs = Math.max(0, Date.parse(stamp) - Date.parse(s.startedAt));
    } else if ((status === "done" || status === "error" || status === "paused") && !s.startedAt) {
      durationMs = s.status === "running" && s.at ? Math.max(0, Date.parse(stamp) - Date.parse(s.at)) : 0;
    }
    return { ...s, status, detail, at: stamp, durationMs };
  });
  run.updatedAt = stamp;
}

export async function executeRun(
  prospect: ProspectInput,
  onUpdate: PipelineListener,
  userId: string,
  opts?: { bulkJobId?: string; existing?: RunRecord; skipClarify?: boolean }
): Promise<RunRecord> {
  const resuming = Boolean(opts?.existing);
  const run: RunRecord = opts?.existing
    ? {
        ...opts.existing,
        userId,
        bulkJobId: opts.bulkJobId ?? opts.existing.bulkJobId,
        prospect,
        status: "running",
        error: undefined,
        updatedAt: now(),
      }
    : {
        id: newId(),
        userId,
        bulkJobId: opts?.bulkJobId,
        createdAt: now(),
        updatedAt: now(),
        status: "running",
        prospect,
        stages: stages(),
        signals: [],
      };
  await upsertRun(run);
  onUpdate(run);

  try {
    if (!resuming) {
      setStage(run, "intake", "running", `${prospect.fullName} · ${prospect.title} · ${prospect.company}`);
      onUpdate(run);
      await sleep(200);
    }
    if (!prospect.fullName.trim() || !prospect.company.trim()) {
      throw new Error("Prospect name and company are required.");
    }
    setStage(
      run,
      "intake",
      "done",
      `Researching ${prospect.fullName} at ${prospect.company}${
        prospect.linkedinUrl || prospect.companyWebsite
          ? ` (+ ${[prospect.linkedinUrl && "LinkedIn", prospect.companyWebsite && "website"].filter(Boolean).join(" + ")})`
          : ""
      }. Soft name recall; LLM confirms entity.`
    );
    onUpdate(run);

    setStage(run, "company", "running", `Wikipedia + LinkedIn / company website for "${prospect.company}".`);
    onUpdate(run);

    const [linkedIn, companySite] = await Promise.all([
      loadLinkedInContext(prospect),
      loadCompanyWebsiteContext(prospect),
    ]);

    const skipClarify = Boolean(opts?.skipClarify) || (run.clarify?.round ?? 0) >= 1;
    const clarify = skipClarify
      ? null
      : buildClarifyRequest(prospect, linkedIn, companySite, run.clarify?.round ?? 0);

    if (clarify) {
      run.clarify = clarify;
      run.status = "needs_input";
      setStage(run, "company", "paused", clarify.reason);
      run.updatedAt = now();
      await upsertRun(run);
      onUpdate(run);
      return run;
    }

    setStage(run, "news", "running", `News search (quoted + soft tokens).`);
    setStage(run, "hiring", "running", `Person / workplace signals.`);
    onUpdate(run);

    const { signals: softRanked, notes, kept, dropped, linkedIn: liUsed, companySite: siteUsed } =
      await researchProspect(prospect, { linkedIn, companySite });
    const workplace = mergeWorkplaceContext(liUsed, siteUsed);

    const wiki = softRanked.find((s) => s.kind === "company");
    setStage(
      run,
      "company",
      "done",
      [
        wiki ? wiki.title : "No Wikipedia / site page.",
        liUsed ? `LinkedIn: ${liUsed.vanity || liUsed.url}` : "No LinkedIn.",
        siteUsed ? `Site: ${siteUsed.host}` : "No company website.",
      ].join(" · ")
    );
    setStage(
      run,
      "news",
      "done",
      `${softRanked.filter((s) => ["funding", "news", "product", "leadership"].includes(s.kind)).length} soft candidates.`
    );
    setStage(
      run,
      "hiring",
      "done",
      `${softRanked.filter((s) => s.matchTier === "person" || s.kind === "hiring").length} person/hiring-ish items.`
    );
    onUpdate(run);

    setStage(run, "rank", "running", "Score candidates (exact / soft / suspect) — not final.");
    onUpdate(run);
    await sleep(100);
    setStage(
      run,
      "rank",
      "done",
      `${kept} candidates for LLM entity check (${dropped} too weak). ${notes.filter((n) => n.startsWith("LinkedIn") || n.startsWith("Company website")).join(" ") || ""}`
    );
    onUpdate(run);

    setStage(
      run,
      "resolve",
      "running",
      `Groq (${llmModelName()}) deciding which names match ${prospect.company} / ${prospect.fullName}.`
    );
    onUpdate(run);

    const memory = await retrieveDraftMemory(userId, prospect).catch(() => ({
      approved: [],
      collisions: [],
      rejectedHooks: [],
      tones: [],
    }));

    const { signals, hook, analysis, llm, entityNote } = await resolveAndAnalyze(
      prospect,
      softRanked,
      workplace,
      memory
    );
    run.signals = signals.filter((s) => s.eligible || s.kind === "company" || s.matchTier === "suspect");
    run.chosenSignal = hook;
    run.entityNote = entityNote;
    run.analysis = analysis ?? undefined;

    const confirmed = signals.filter((s) => s.eligible && s.kind !== "company").length;
    setStage(
      run,
      "resolve",
      "done",
      hook
        ? `Confirmed ${confirmed}. Hook: ${hook.title} · ${entityNote}`
        : `Confirmed ${confirmed}. ${entityNote}`
    );
    onUpdate(run);

    setStage(
      run,
      "analyze",
      "running",
      hook
        ? `Sentiment + business impact via ${llmModelName()}…`
        : "Skipped — no confirmed hook."
    );
    onUpdate(run);

    if (!hook) {
      setStage(run, "analyze", "done", "No confirmed entity match to analyze.");
    } else if (!llm) {
      setStage(run, "analyze", "done", "Groq unavailable — heuristic draft only.");
    } else if (!analysis) {
      setStage(run, "analyze", "done", "Analysis empty — drafting with fallback.");
    } else {
      setStage(
        run,
        "analyze",
        "done",
        `${analysis.sentiment} · ${analysis.businessImpact.slice(0, 120)}${analysis.businessImpact.length > 120 ? "…" : ""}`
      );
    }
    onUpdate(run);

    setStage(
      run,
      "draft",
      "running",
      llm ? `Drafting with ${llmModelName()}…` : "Writing draft (heuristic)."
    );
    onUpdate(run);
    run.draft = await writeDraft(prospect, signals, analysis, workplace, memory);
    if (run.draft.hold) {
      setStage(run, "draft", "done", `HOLD — no confirmed hook · ${run.draft.holdReason || "do not send"}`);
      setStage(
        run,
        "review",
        "done",
        "No sendable email. Store the hold or add LinkedIn / company website and run again."
      );
    } else if (run.draft.sensitiveHook) {
      setStage(run, "draft", "done", `Ready for careful review · sensitive hook · ${run.draft.confidence}`);
      setStage(run, "review", "done", "Sensitive public event. Do not congratulate. Nothing is auto-sent.");
    } else {
      setStage(run, "draft", "done", `Ready for review · ${run.draft.confidence} · ${run.draft.model}`);
      setStage(run, "review", "done", "Draft held. Edit if needed, then approve — nothing is auto-sent.");
    }
    run.status = "needs_review";
    run.updatedAt = now();
    await upsertRun(run);
    onUpdate(run);
    return run;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    run.error = message;
    run.status = "failed";
    run.stages = run.stages.map((s) =>
      s.status === "running" || s.status === "paused"
        ? { ...s, status: "error" as const, detail: message, at: now() }
        : s
    );
    run.updatedAt = now();
    await upsertRun(run);
    onUpdate(run);
    return run;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}