import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, env, repoRoot } from "../config.js";
import type { Proposal } from "../types.js";

/**
 * Human-in-the-loop approvals (PLAN.md 2.0 #3): every order requires one.
 * Two channels, both usable from a phone:
 *
 * 1. File-based (works day 1, no new accounts): edit approvals/YYYY-MM-DD.json
 *    in the repo - {"approve": ["<first 8 chars of proposal id>"], "reject": []}
 *    - via the GitHub app or web UI. The midday cycle pulls the latest commit
 *    before reading, so an edit from the phone lands the same day.
 * 2. Telegram (optional): premarket posts proposal cards; replying
 *    "approve <shortid>" / "reject <shortid>" in the configured chat is read
 *    by the midday cycle via getUpdates polling. Messages from any other chat
 *    id are ignored.
 */

export interface ApprovalDecisions {
  approve: Set<string>; // short ids
  reject: Set<string>;
}

export function shortId(proposalId: string): string {
  return proposalId.slice(0, 8);
}

export function readApprovalFile(date: string): ApprovalDecisions {
  const file = path.join(repoRoot, "approvals", `${date}.json`);
  if (!existsSync(file)) return { approve: new Set(), reject: new Set() };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      approve: new Set<string>((parsed.approve ?? []).map(String)),
      reject: new Set<string>((parsed.reject ?? []).map(String)),
    };
  } catch {
    return { approve: new Set(), reject: new Set() };
  }
}

/** Pure decision: is this proposal approvable right now? */
export function approvalStatus(
  p: Proposal,
  decisions: ApprovalDecisions,
  nowIso: string,
): "approved" | "rejected" | "expired" | "pending" {
  const sid = shortId(p.id);
  if (decisions.reject.has(sid)) return "rejected";
  const created = p.createdAt ?? `${p.date}T12:30:00Z`; // legacy proposals: assume premarket run time
  const ageHours = (Date.parse(nowIso) - Date.parse(created)) / 3_600_000;
  if (ageHours > p.ttlHours) return "expired";
  if (decisions.approve.has(sid)) return "approved";
  return "pending";
}

// ---------------------------------------------------------------------------
// Telegram channel (optional)

const tgStateFile = path.join(dataDir, "state", "telegram.json");

function tgConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function tgApi(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

export async function telegramSendProposals(proposals: Proposal[]): Promise<void> {
  if (!tgConfigured() || proposals.length === 0) return;
  for (const p of proposals) {
    const text =
      `0dark30 proposal ${shortId(p.id)}\n` +
      `Sell ${p.underlying} ${p.expiry} $${p.strike} put (${p.dte} DTE, ` +
      `${p.delta === null ? "?" : Math.abs(p.delta).toFixed(2)} delta)\n` +
      `Premium ~$${p.premiumAtMid.toFixed(0)} on $${p.collateral.toFixed(0)} collateral ` +
      `(${(p.rocAnnualizedAtBid * 100).toFixed(1)}%/yr at bid)\n` +
      `Reply: approve ${shortId(p.id)}  |  reject ${shortId(p.id)}\n` +
      `Expires ${p.ttlHours}h after the premarket run.`;
    await tgApi("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text });
  }
}

export async function telegramPollDecisions(): Promise<ApprovalDecisions> {
  const decisions: ApprovalDecisions = { approve: new Set(), reject: new Set() };
  if (!tgConfigured()) return decisions;
  let offset = 0;
  if (existsSync(tgStateFile)) {
    offset = JSON.parse(readFileSync(tgStateFile, "utf8")).offset ?? 0;
  }
  const json = await tgApi("getUpdates", { offset, timeout: 0 });
  if (!json?.ok) return decisions;
  let maxUpdateId = offset - 1;
  for (const u of json.result ?? []) {
    maxUpdateId = Math.max(maxUpdateId, u.update_id);
    const msg = u.message;
    if (!msg || String(msg.chat?.id) !== String(process.env.TELEGRAM_CHAT_ID)) continue;
    const m = String(msg.text ?? "").trim().toLowerCase().match(/^(approve|reject)\s+([a-f0-9]{8})$/);
    if (!m) continue;
    (m[1] === "approve" ? decisions.approve : decisions.reject).add(m[2]!);
  }
  mkdirSync(path.dirname(tgStateFile), { recursive: true });
  writeFileSync(tgStateFile, JSON.stringify({ offset: maxUpdateId + 1 }));
  return decisions;
}

export async function telegramNotify(text: string): Promise<void> {
  if (!tgConfigured()) return;
  await tgApi("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text });
}

export function mergeDecisions(a: ApprovalDecisions, b: ApprovalDecisions): ApprovalDecisions {
  return {
    approve: new Set([...a.approve, ...b.approve]),
    reject: new Set([...a.reject, ...b.reject]),
  };
}
