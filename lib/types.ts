export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "needs_input"
  | "needs_review"
  | "approved"
  | "rejected";

export type StageStatus = "pending" | "running" | "paused" | "done" | "error";

export type ClarifyField = "linkedinUrl" | "companyWebsite" | "company" | "notes";

export type ClarifyQuestion = {
  id: string;
  field: ClarifyField;
  prompt: string;
  placeholder?: string;
  suggestions?: string[];
};

export type ClarifyRequest = {
  reason: string;
  questions: ClarifyQuestion[];
  askedAt: string;
  round: number;
  answeredAt?: string;
};

export type SignalKind =
  | "news"
  | "hiring"
  | "funding"
  | "product"
  | "leadership"
  | "company";

export type Signal = {
  id: string;
  kind: SignalKind;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt?: string;
  relevance: number;
  why: string;
  eligible?: boolean;
  /** How the name matched before LLM entity check */
  matchTier?: "exact" | "soft" | "person" | "suspect" | "context";
  /** Layoff / lawsuit / death / similar — never congratulate */
  sensitive?: boolean;
};

export type StageEvent = {
  id: string;
  label: string;
  detail: string;
  status: StageStatus;
  at: string;
  /** When this stage entered running (ISO) */
  startedAt?: string;
  /** Final elapsed ms when stage finished */
  durationMs?: number;
};

export type ProspectInput = {
  fullName: string;
  title: string;
  company: string;
  linkedinUrl?: string;
  /** Public company homepage — used to scrape context and disambiguate same-name orgs */
  companyWebsite?: string;
  notes?: string;
  senderName?: string;
  senderCompany?: string;
  senderOffer?: string;
};

/** Per-user SDR identity — name, company, and what you sell. Reused on Live and Bulk. */
export type CompanyContext = {
  senderName: string;
  senderCompany: string;
  senderOffer: string;
};

export type OutreachDraft = {
  subject: string;
  body: string;
  hook: string;
  confidence: "high" | "medium" | "low";
  /** Why Groq (or the heuristic) assigned this confidence */
  confidenceWhy?: string;
  usedSignalIds: string[];
  model: string;
  /** True when there is no confirmed person+company hook — not a sendable email */
  hold?: boolean;
  holdReason?: string;
  /** Chosen hook is a sensitive public event */
  sensitiveHook?: boolean;
};

export type HookAnalysis = {
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  sentimentWhy: string;
  businessImpact: string;
  outreachAngle: string;
  toneGuidance: string;
  riskFlags: string[];
};

export type RunRecord = {
  id: string;
  /** Owner from Google / Auth.js session */
  userId: string;
  /** Optional link to a bulk CSV job */
  bulkJobId?: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  prospect: ProspectInput;
  stages: StageEvent[];
  signals: Signal[];
  chosenSignal?: Signal;
  analysis?: HookAnalysis;
  entityNote?: string;
  draft?: OutreachDraft;
  error?: string;
  reviewNote?: string;
  /** Set when the pipeline pauses to ask the SDR to disambiguate the workplace. */
  clarify?: ClarifyRequest;
  /** Last AI refine instruction — stored into review memory when you approve. */
  lastRefinePrompt?: string;
};

export type BulkItemStatus = "pending" | "running" | "needs_input" | "done" | "failed" | "skipped";

export type BulkJobStatus = "queued" | "running" | "completed" | "cancelled";

export type BulkItem = {
  index: number;
  prospect: ProspectInput;
  status: BulkItemStatus;
  runId?: string;
  error?: string;
  updatedAt: string;
  /** When research started for this row */
  startedAt?: string;
  /** Elapsed ms for this row when finished */
  durationMs?: number;
};

export type BulkJob = {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  /** When the first prospect started processing */
  startedAt?: string;
  /** When the first CSV pass finished (done / failed / skipped / needs_input). Workplace checks are later. */
  completedAt?: string;
  status: BulkJobStatus;
  fileName: string;
  defaults: {
    senderName: string;
    senderCompany: string;
    senderOffer: string;
  };
  items: BulkItem[];
};
