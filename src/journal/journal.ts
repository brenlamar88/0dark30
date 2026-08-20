import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { dataDir, env } from "../config.js";
import type { JournalEvent, Proposal } from "../types.js";

/**
 * Append-only journal per PLAN.md 2.0 #6. The local backend (JSONL under
 * data/) is the source of record in Phase 1; the Supabase backend mirrors the
 * same writes when configured, so promotion to Phase 2 is a config change,
 * not a rewrite.
 */
export class Journal {
  private supabase: SupabaseClient | null = null;

  constructor(private ruleVersion: string) {
    mkdirSync(path.join(dataDir, "journal"), { recursive: true });
    mkdirSync(path.join(dataDir, "iv"), { recursive: true });
    mkdirSync(path.join(dataDir, "proposals"), { recursive: true });
    mkdirSync(path.join(dataDir, "scoreboard"), { recursive: true });
    if (env.journalBackend === "supabase") {
      if (!env.supabaseUrl || !env.supabaseServiceKey) {
        throw new Error("JOURNAL_BACKEND=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
      }
      this.supabase = createClient(env.supabaseUrl, env.supabaseServiceKey);
    }
  }

  async event(type: string, payload: unknown): Promise<void> {
    const ev: JournalEvent = {
      ts: new Date().toISOString(),
      type,
      ruleVersion: this.ruleVersion,
      payload,
    };
    const day = ev.ts.slice(0, 10);
    appendFileSync(path.join(dataDir, "journal", `${day}.jsonl`), JSON.stringify(ev) + "\n");
    if (this.supabase) {
      await this.supabase.from("journal_events").insert({
        ts: ev.ts,
        type: ev.type,
        rule_version: ev.ruleVersion,
        payload: ev.payload,
      });
    }
  }

  async appendIv(symbol: string, date: string, iv: number): Promise<void> {
    const file = path.join(dataDir, "iv", `${symbol}.jsonl`);
    const rows = this.readIvFile(symbol);
    if (rows.some((r) => r.date === date)) return; // idempotent per day
    appendFileSync(file, JSON.stringify({ date, iv }) + "\n");
    if (this.supabase) {
      await this.supabase.from("iv_history").upsert({ symbol, date, iv });
    }
  }

  async ivHistory(symbol: string, limit: number): Promise<{ date: string; iv: number }[]> {
    return this.readIvFile(symbol).slice(-limit);
  }

  private readIvFile(symbol: string): { date: string; iv: number }[] {
    const file = path.join(dataDir, "iv", `${symbol}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  async saveProposals(date: string, proposals: Proposal[]): Promise<void> {
    writeFileSync(
      path.join(dataDir, "proposals", `${date}.json`),
      JSON.stringify(proposals, null, 2),
    );
    if (this.supabase) {
      await this.supabase.from("proposals").upsert(
        proposals.map((p) => ({ id: p.id, date: p.date, rule_version: p.ruleVersion, body: p })),
      );
    }
  }

  loadProposals(date: string): Proposal[] {
    const file = path.join(dataDir, "proposals", `${date}.json`);
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf8"));
  }

  allProposalDates(): string[] {
    const dir = path.join(dataDir, "proposals");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
      .sort();
  }

  async appendScoreboard(row: Record<string, unknown>): Promise<void> {
    appendFileSync(path.join(dataDir, "scoreboard", "daily.jsonl"), JSON.stringify(row) + "\n");
    if (this.supabase) {
      await this.supabase.from("scoreboard_daily").insert(row);
    }
  }

  scoreboardRows(): Record<string, any>[] {
    const file = path.join(dataDir, "scoreboard", "daily.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}
