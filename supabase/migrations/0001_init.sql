-- 0dark30 Phase 1 schema. The local JSONL journal is the Phase 1 source of
-- record; setting JOURNAL_BACKEND=supabase mirrors writes here so Phase 2
-- picks up a populated database. Append-only by convention: no updates or
-- deletes from application code except proposal shadow-status transitions.

create table if not exists journal_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null,
  type text not null,
  rule_version text not null,
  payload jsonb
);
create index if not exists journal_events_ts_idx on journal_events (ts);
create index if not exists journal_events_type_idx on journal_events (type);

create table if not exists proposals (
  id uuid primary key,
  date date not null,
  rule_version text not null,
  body jsonb not null
);
create index if not exists proposals_date_idx on proposals (date);

create table if not exists iv_history (
  symbol text not null,
  date date not null,
  iv double precision not null,
  primary key (symbol, date)
);

create table if not exists scoreboard_daily (
  date date primary key,
  spy_close double precision,
  shadow_realized_total double precision,
  shadow_unrealized double precision,
  shadow_open_count int,
  shadow_closed_count int,
  realized_today double precision,
  rule_version text
);
