import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Params, UniverseEntry } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");
export const dataDir = path.join(repoRoot, "data");
export const briefsDir = path.join(repoRoot, "briefs");

// Minimal .env loader for local runs (CI provides real env vars). Existing
// environment variables always win; the file never overrides them.
try {
  const envFile = readFileSync(path.join(repoRoot, ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]!] === undefined && m[2]) process.env[m[1]!] = m[2];
  }
} catch {
  // no .env file - fine
}

export function loadParams(): Params {
  const raw = readFileSync(path.join(repoRoot, "config", "params.v1.json"), "utf8");
  return JSON.parse(raw) as Params;
}

export function loadUniverse(): UniverseEntry[] {
  const raw = readFileSync(path.join(repoRoot, "config", "universe.json"), "utf8");
  const parsed = JSON.parse(raw) as { symbols: UniverseEntry[] };
  return parsed.symbols;
}

export const env = {
  alpacaKeyId: process.env.ALPACA_KEY_ID ?? "",
  alpacaSecretKey: process.env.ALPACA_SECRET_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  finnhubApiKey: process.env.FINNHUB_API_KEY ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  journalBackend: (process.env.JOURNAL_BACKEND ?? "local") as "local" | "supabase",
};

export function todayEt(): string {
  // Trading dates are US/Eastern regardless of where the job runs.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}
