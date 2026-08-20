import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env } from "../config.js";
import type { LlmAnalysis, Proposal } from "../types.js";

const AnalysisSchema = z.object({
  analyses: z.array(
    z.object({
      proposalId: z.string(),
      rationale: z.string().describe("2-3 sentences: why the mechanical screen surfaced this, in plain language"),
      flags: z.array(
        z.object({
          flag: z.string(),
          severity: z.enum(["info", "warning", "veto"]),
          source: z.string().describe("what the flag is based on"),
        }),
      ),
      veto: z.boolean().describe("true only for a hazard the mechanical screen cannot see"),
    }),
  ),
  marketNote: z.string().describe("1-2 sentence 'what's driving today' framing for the brief header"),
});

const SYSTEM = `You are the analyst layer of a personal, shadow-mode options screening system.
The mechanical screener and risk engine have already selected and sized these cash-secured put candidates.
Your role is strictly limited (system design constraint, not a suggestion):
- Write a short plain-language rationale for each proposal based ONLY on the screen data provided.
- Flag hazards the mechanical screen cannot see (news-driven catalysts, structural notes about the underlying). Only use knowledge you are confident in; never invent news. If you know nothing noteworthy, return no flags.
- veto=true is reserved for concrete hazards, not general market caution.
You never originate trades, adjust sizes, or predict direction. Your vetoes are logged and scored; unhelpful vetoes get this layer demoted.`;

export async function analyzeProposals(
  proposals: Proposal[],
): Promise<{ byId: Map<string, LlmAnalysis>; marketNote: string } | null> {
  if (!env.anthropicApiKey || proposals.length === 0) return null;
  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  const payload = proposals.map((p) => ({
    proposalId: p.id,
    underlying: p.underlying,
    sector: p.sector,
    contract: p.occSymbol,
    strike: p.strike,
    expiry: p.expiry,
    dte: p.dte,
    delta: p.delta,
    premiumAtMid: p.premiumAtMid,
    collateral: p.collateral,
    annualizedRoc: p.rocAnnualizedAtBid,
    ivRank: p.ivRank,
    screenNotes: p.screenNotes,
    riskChecks: p.checks.map((c) => `${c.name}: ${c.pass ? "pass" : "FAIL"} (${c.detail})`),
  }));

  try {
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Today's shadow-mode CSP proposals from the mechanical screen:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      output_config: { format: zodOutputFormat(AnalysisSchema) },
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) return null;
    const byId = new Map<string, LlmAnalysis>();
    for (const a of response.parsed_output.analyses) {
      byId.set(a.proposalId, { rationale: a.rationale, flags: a.flags, veto: a.veto });
    }
    return { byId, marketNote: response.parsed_output.marketNote };
  } catch (err) {
    // The analyst is optional by design - the mechanical brief must never
    // fail because the LLM layer did. Callers journal the degradation.
    console.error("LLM analyst unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}
