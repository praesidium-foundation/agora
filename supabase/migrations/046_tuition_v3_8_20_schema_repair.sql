-- ============================================================================
-- Migration 046: Tuition v3.8.20 schema repair (v3.8.23)
--
-- Defensive repair for Migration 043's silent partial failure.
--
-- Background. Migration 043 (v3.8.20, "Final Budget reference snapshot
-- mechanism") added an `is_final_budget_reference boolean NOT NULL
-- DEFAULT false` column on `tuition_worksheet_snapshots` plus a partial
-- unique index `tuition_worksheet_snapshots_one_final_budget_reference`
-- enforcing one promoted reference per scenario. Both DDL statements
-- are present and well-formed in the M043 file (lines 45–54).
--
-- Operational reality. The v3.8.20 burndown surfaced "column does not
-- exist" errors at runtime when the snapshot-promotion RPC was invoked.
-- Verification SELECTs against the live database confirmed the column
-- and the partial unique index were both absent:
--
--     -- Returned zero rows:
--     SELECT column_name, data_type, is_nullable, column_default
--       FROM information_schema.columns
--      WHERE table_name = 'tuition_worksheet_snapshots'
--        AND column_name = 'is_final_budget_reference';
--
--     -- Returned zero rows:
--     SELECT indexname, indexdef
--       FROM pg_indexes
--      WHERE tablename = 'tuition_worksheet_snapshots'
--        AND indexname = 'tuition_worksheet_snapshots_one_final_budget_reference';
--
-- Migration 043 nonetheless reported success when applied via the
-- Supabase tooling — no error surfaced to the operator. The RPC body
-- (`mark_snapshot_as_final_budget_reference`) DID land, since the only
-- visible failure was at RPC-invocation time when it tried to UPDATE
-- a column that didn't exist.
--
-- Failure mode is undiagnosable without server-side audit logs. Three
-- candidate explanations, none verifiable post-hoc:
--   (a) Transaction rollback on a downstream non-DDL error that
--       reverted the DDL statements while leaving the function-create
--       in place (implausible given the file's statement ordering, but
--       not impossible if statement-level rollback semantics differed
--       from expected).
--   (b) Application-tooling bug or network glitch that swallowed an
--       error and reported success on a partially-executed batch.
--   (c) Manual operator action (DROP COLUMN, DROP INDEX) between
--       M043's apply and the verification SELECT (no record of such
--       action; included for completeness).
--
-- Migration 046 ships the defensive repair: re-issue the column-add
-- and the partial unique index with `IF NOT EXISTS` patterns so the
-- migration is idempotent against any possible live state. If the
-- schema is already correct (e.g., on a fresh deploy where M043 did
-- land correctly), this migration is a no-op. If the schema is missing
-- the column / index (the live state today), this migration adds them.
--
-- Migration 043 itself is left in the migration log unchanged as a
-- historical record. The repair lives in M046 to preserve migration-
-- log integrity per the standard discipline ("never edit a committed
-- migration; ship a follow-up").
--
-- Class-of-issue note. This is the third instance of "migration
-- reported success but partially failed" in the Tuition module's
-- evolution:
--
--   1. Migration 032 → M033/M034 — `compute_tuition_scenario_kpis`
--      and `lock_tuition_scenario` were rewritten from M024's pre-
--      B1.1 baseline, losing M027's column renames; the function-
--      create succeeded but every invocation raised at runtime.
--   2. Migration 037 — `create_tuition_scenario_from_snapshot` was
--      created with a parameter name (`p_scenario_label`) that didn't
--      match the application's call site (`p_scenario_name`); the
--      function existed but was unreachable via PostgREST's named-
--      parameter resolution.
--   3. Migration 043 → this — DDL statements that didn't execute
--      against the live database despite the migration succeeding;
--      RPCs that referenced the absent column raised at runtime.
--
-- The systemic response is captured in Appendix C as a new
-- architectural commitment: "Migrations must be verified post-apply,
-- not assumed correct from migration-tool success." Run schema-state
-- verification SELECTs after applying any migration that touches
-- tables, indexes, or function signatures. The cost is small; the
-- alternative is silent partial failures surfacing as runtime errors
-- during user testing — which is what happened here.
-- ============================================================================


-- ---- 1. Schema repair ---------------------------------------------------

-- Defensive ADD COLUMN IF NOT EXISTS — no-op if M043 did land
-- correctly on a particular environment; adds the column on the live
-- DB where M043 silently dropped it.
alter table tuition_worksheet_snapshots
  add column if not exists is_final_budget_reference boolean not null default false;

-- Partial unique index enforcing one promoted reference per scenario.
-- Same definition as M043 lines 52–54; CREATE INDEX IF NOT EXISTS is
-- idempotent against an already-existing index. The index uses the
-- column above and would fail to create with a clear error if the
-- column-add is somehow still missing — that's the right outcome
-- (loud failure beats silent partial).
create unique index if not exists tuition_worksheet_snapshots_one_final_budget_reference
  on tuition_worksheet_snapshots (scenario_id)
  where is_final_budget_reference = true;


-- ---- 2. PostgREST schema cache reload -----------------------------------
--
-- Defensive against schema-cache miss. M043 already issued this; M046
-- re-issues it because the column-add is what populates the schema
-- cache for PostgREST consumers, and the cache may be stale.

notify pgrst, 'reload schema';


-- ---- 3. Post-apply verification (operator runs manually) ----------------
--
-- These SELECTs are NOT executed by the migration. They are documented
-- here as the verification step the operator should run after applying
-- any schema-touching migration per the Appendix C v3.8.23 commitment.
-- Both should return exactly one row:
--
--     SELECT column_name, data_type, is_nullable, column_default
--       FROM information_schema.columns
--      WHERE table_name = 'tuition_worksheet_snapshots'
--        AND column_name = 'is_final_budget_reference';
--
--     SELECT indexname, indexdef
--       FROM pg_indexes
--      WHERE tablename = 'tuition_worksheet_snapshots'
--        AND indexname = 'tuition_worksheet_snapshots_one_final_budget_reference';

-- ============================================================================
-- END OF MIGRATION 046
-- ============================================================================
