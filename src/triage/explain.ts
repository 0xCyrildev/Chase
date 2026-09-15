import { TriagedFinding, NextAction } from "./types.js";

const SINGLE_SYSTEM_PROMPT = `You are a triage assistant for Chase, a dynamic analysis tool for Sui Move transactions. Chase produces deterministic violations; your job is to explain them to an analyst, not to judge them.

Rules:

1. Every violation is a SIGNAL, not a verdict. Never write "this is an exploit." Write "this matches the pattern of X" or "this is consistent with Y."

2. Always cite the specific limitation from the invariant's documentation. If the invariant is name-based, say so. If it fires on shared-object flows benignly, say so.

3. If the evidence includes a benign-pattern match, lead with that. The analyst's first question is "is this real?"

4. Be brief. Two short paragraphs maximum.

Respond with JSON only. Schema:
{
  "verdict": "one-sentence summary",
  "reasoning": "one paragraph explaining what fired and why it may or may not matter",
  "nextAction": "DISMISS" | "MANUAL_REVIEW" | "ESCALATE" | "REPRODUCE",
  "confidence": "low" | "medium" | "high"
}`;

const BATCH_SYSTEM_PROMPT = `You are a triage assistant for Chase, a dynamic analysis tool for Sui Move transactions. You will receive a JSON array of findings. For each finding, produce a brief explanation.

Rules:

1. Every violation is a SIGNAL, not a verdict. Never write "this is an exploit."

2. Cite the specific limitation from the invariant's documentation when applicable.

3. If a benignMatch is present, lead with that.

4. Be brief. One short paragraph per finding.

5. If tier is P0, nextAction must be ESCALATE unless a benignMatch is present.

Respond with JSON only. Schema:
{
  "explanations": [
    {
      "index": <number, matching the input array>,
      "reasoning": "one paragraph",
      "nextAction": "DISMISS" | "MANUAL_REVIEW" | "ESCALATE" | "REPRODUCE",
      "confidence": "low" | "medium" | "high"
    }
  ]
}`;

interface LlmResponse {
  verdict: string;
  reasoning: string;
  nextAction: NextAction;
  confidence: "low" | "medium" | "high";
}

interface BatchExplanation {
  index: number;
  reasoning: string;
  nextAction: NextAction;
  confidence: "low" | "medium" | "high";
}

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-r1:free";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 3000;

function buildRequest(model: string, system: string, user: string, maxTokens: number, signal: AbortSignal) {
  const apiKey = process.env.DEEPSEEK_API_KEY!;
  const endpoint = process.env.DEEPSEEK_ENDPOINT ?? DEFAULT_ENDPOINT;
  return {
    endpoint,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/0xCyrildev/Chase",
        "X-Title": "Chase Triage",
      },
      signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    } as RequestInit,
  };
}

export async function explain(finding: TriagedFinding): Promise<TriagedFinding> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      ...finding,
      explanation: "(DEEPSEEK_API_KEY not set - explanation skipped)",
      nextAction: fallbackAction(finding.tier),
      confidence: "low",
    };
  }

  const model = process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;
  const userPrompt = JSON.stringify(
    {
      digest: finding.digest,
      network: finding.network,
      txSuccess: finding.txSuccess,
      violation: {
        type: finding.violation.type,
        severity: finding.violation.severity,
        message: finding.violation.message,
        evidence: finding.violation.evidence,
      },
      corroborating: finding.corroborating.map((v) => v.type),
      benignMatch: finding.benignMatch,
      historyCount: finding.historyCount,
      triageScore: finding.score,
      triageTier: finding.tier,
      triageRationale: finding.rationale,
    },
    null,
    2
  );

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const { endpoint, init } = buildRequest(
        model,
        SINGLE_SYSTEM_PROMPT,
        userPrompt,
        512,
        controller.signal
      );

      const res = await fetch(endpoint, init);
      clearTimeout(timer);

      if (res.status === 429 || res.status === 503) {
        lastError = `attempt ${attempt + 1}: ${res.status}`;
        if (attempt < MAX_ATTEMPTS - 1) {
          const delay = BASE_DELAY_MS * (attempt + 1);
          console.error(`[chase-triage] rate limited, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }

      if (!res.ok) {
        const text = await res.text();
        return {
          ...finding,
          explanation: `(LLM error ${res.status}: ${text.slice(0, 200)})`,
          nextAction: fallbackAction(finding.tier),
          confidence: "low",
        };
      }

      const body: any = await res.json();
      const content: string = body?.choices?.[0]?.message?.content ?? "";
      const parsed = parseLlmJson(content);

      if (!parsed) {
        return {
          ...finding,
          explanation: content || "(empty LLM response)",
          nextAction: fallbackAction(finding.tier),
          confidence: "low",
        };
      }

      return {
        ...finding,
        explanation: parsed.reasoning,
        nextAction: parsed.nextAction,
        confidence: parsed.confidence,
      };
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err?.message ?? String(err);
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (attempt + 1)));
        continue;
      }
    }
  }

  return {
    ...finding,
    explanation: `(LLM unavailable after ${MAX_ATTEMPTS} attempts: ${lastError})`,
    nextAction: fallbackAction(finding.tier),
    confidence: "low",
  };
}

export async function explainBatch(findings: TriagedFinding[]): Promise<TriagedFinding[]> {
  if (findings.length === 0) return findings;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return findings.map((f) => ({
      ...f,
      explanation: "(DEEPSEEK_API_KEY not set - explanation skipped)",
      nextAction: fallbackAction(f.tier),
      confidence: "low",
    }));
  }

  const model = process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;

  const payload = findings.map((f, i) => ({
    index: i,
    digest: f.digest,
    violationType: f.violation.type,
    severity: f.violation.severity,
    message: f.violation.message,
    evidence: f.violation.evidence,
    corroborating: f.corroborating.map((v) => v.type),
    benignMatch: f.benignMatch,
    historyCount: f.historyCount,
    triageScore: f.score,
    triageTier: f.tier,
  }));

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const { endpoint, init } = buildRequest(
        model,
        BATCH_SYSTEM_PROMPT,
        JSON.stringify(payload, null, 2),
        2048,
        controller.signal
      );

      const res = await fetch(endpoint, init);
      clearTimeout(timer);

      if (res.status === 429 || res.status === 503) {
        lastError = `attempt ${attempt + 1}: ${res.status}`;
        if (attempt < MAX_ATTEMPTS - 1) {
          const delay = BASE_DELAY_MS * (attempt + 1);
          console.error(`[chase-triage] rate limited, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }

      if (!res.ok) {
        const text = await res.text();
        return findings.map((f) => ({
          ...f,
          explanation: `(LLM error ${res.status}: ${text.slice(0, 200)})`,
          nextAction: fallbackAction(f.tier),
          confidence: "low",
        }));
      }

      const body: any = await res.json();
      const content: string = body?.choices?.[0]?.message?.content ?? "";
      const parsed = parseBatchJson(content);

      if (!parsed) {
        return findings.map((f) => ({
          ...f,
          explanation: content || "(empty LLM response)",
          nextAction: fallbackAction(f.tier),
          confidence: "low",
        }));
      }

      return findings.map((f, i) => {
        const e = parsed.find((p) => p.index === i);
        if (!e) {
          return {
            ...f,
            explanation: "(no explanation returned for this finding)",
            nextAction: fallbackAction(f.tier),
            confidence: "low",
          };
        }
        return {
          ...f,
          explanation: e.reasoning,
          nextAction: e.nextAction,
          confidence: e.confidence,
        };
      });
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err?.message ?? String(err);
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (attempt + 1)));
        continue;
      }
    }
  }

  return findings.map((f) => ({
    ...f,
    explanation: `(LLM unavailable after ${MAX_ATTEMPTS} attempts: ${lastError})`,
    nextAction: fallbackAction(f.tier),
    confidence: "low",
  }));
}

function parseLlmJson(text: string): LlmResponse | null {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const obj = JSON.parse(cleaned);
    if (typeof obj.verdict !== "string") return null;
    return obj as LlmResponse;
  } catch {
    return null;
  }
}

function parseBatchJson(text: string): BatchExplanation[] | null {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const obj = JSON.parse(cleaned);
    if (!Array.isArray(obj?.explanations)) return null;
    return obj.explanations as BatchExplanation[];
  } catch {
    return null;
  }
}

function fallbackAction(tier: string): NextAction {
  switch (tier) {
    case "P0":
      return "ESCALATE";
    case "P1":
    case "P2":
    case "P3":
      return "MANUAL_REVIEW";
    default:
      return "DISMISS";
  }
}
