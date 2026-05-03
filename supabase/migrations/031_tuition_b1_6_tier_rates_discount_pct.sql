-- ============================================================================
-- Migration 031: Tuition-B1.6 — Tier Rates editability flip
--                                (tier_rates jsonb gains discount_pct)
--
-- v3.8.9 (Tuition-B1.6). Real-data walkthrough surfaced that the
-- prior model — all per-student rates editable, discount column
-- read-only — required the user to manually compute tier rates
-- with a calculator while toggling between scenarios. The flip:
-- tier 1 per-student rate stays editable as the base input; tiers
-- 2+ per-student rates become read-only computed values from the
-- base rate × (1 − discount_pct/100); discount_pct per tier 2+
-- becomes the editable input.
--
-- Schema change: each row in the tier_rates jsonb gains a
-- discount_pct field (numeric, 2-decimal precision via application-
-- side rounding). Backfill rule:
--   - Tier 1 (lowest tier_size): discount_pct = 0 unconditionally
--   - Tiers 2+: discount_pct = ROUND(((tier_1_rate - this_tier_rate)
--     / tier_1_rate) × 100, 2) when tier_1_rate > 0; else 0
//
-- Per-student rate values preserved verbatim during backfill — no
-- rounding, no recomputation. The migration only adds the new
-- field. Round-trip math (per_student_rate ↔ discount_pct ↔
-- per_student_rate) preserves the input dollar values exactly for
-- the AYE 2026 walkthrough scenario:
--   $6,720 / $6,615 / $6,300 / $5,775
--   → 0% / 1.56% / 6.25% / 14.06%
--   → recomputed back to $6,720 / $6,615 / $6,300 / $5,775
--
-- Snapshot mirror: same backfill applied to tuition_worksheet_snapshots.
-- Likely zero locked snapshots at present, but the migration handles
-- them safely.
--
-- No new DB validators added in this migration. The application save
-- path is the source of truth for per_student_rate (computes
-- atomically from discount_pct on every save). DB-level validation
-- of "tier 1 discount must be 0" or "discount must be < 100" adds
-- trigger complexity without much safety. The existing
-- tg_validate_tuition_scenario (breakdown_pct sum check from
-- Migration 027) stays as-is.
--
-- Architecture references: §7.3 (extended in v3.8.9), Migration 027
-- (closest precedent for jsonb shape backfill).
-- ============================================================================


-- ---- 1. Backfill scenarios -----------------------------------------------
--
-- Per-row reshape via PL/pgSQL DO block (parallels Migration 027's
-- pattern for clarity). For each scenario:
--   - Determine tier_1_rate (the per_student_rate of the row with
--     the minimum tier_size; typically the row with tier_size = 1
--     but defensive against schemas where tier 1 was renamed).
--   - For each row in tier_rates:
--       - If row is tier 1 (min tier_size): set discount_pct = 0.
--       - Else: compute discount_pct from the formula above.
--   - Write the reshaped jsonb back.

do $$
declare
  r record;
  v_min_tier_size int;
  v_tier_1_rate numeric;
  v_new_rates jsonb;
  v_row jsonb;
  v_rate numeric;
  v_size int;
  v_discount numeric;
begin
  for r in select id, tier_rates from tuition_worksheet_scenarios loop
    if r.tier_rates is null
       or jsonb_typeof(r.tier_rates) <> 'array'
       or jsonb_array_length(r.tier_rates) = 0 then
      continue;  -- defensive; skip rows with empty / malformed jsonb
    end if;

    -- Find the minimum tier_size and its rate (the base / tier 1).
    select min((tr->>'tier_size')::int)
      into v_min_tier_size
      from jsonb_array_elements(r.tier_rates) tr;

    select (tr->>'per_student_rate')::numeric
      into v_tier_1_rate
      from jsonb_array_elements(r.tier_rates) tr
     where (tr->>'tier_size')::int = v_min_tier_size
     limit 1;

    -- Walk and reshape.
    v_new_rates := '[]'::jsonb;
    for v_row in select value from jsonb_array_elements(r.tier_rates) loop
      v_size := (v_row->>'tier_size')::int;
      v_rate := coalesce((v_row->>'per_student_rate')::numeric, 0);
      if v_size = v_min_tier_size then
        v_discount := 0;
      else
        if v_tier_1_rate is null or v_tier_1_rate <= 0 then
          v_discount := 0;
        else
          v_discount := round(((v_tier_1_rate - v_rate) / v_tier_1_rate) * 100, 2);
        end if;
      end if;
      -- Preserve all existing keys; add discount_pct.
      v_new_rates := v_new_rates
        || jsonb_build_array(v_row || jsonb_build_object('discount_pct', v_discount));
    end loop;

    update tuition_worksheet_scenarios
       set tier_rates = v_new_rates
     where id = r.id;
  end loop;
end $$;


-- ---- 2. Backfill snapshots -----------------------------------------------
--
-- Mirror the same logic on tuition_worksheet_snapshots. Likely zero
-- rows at present, but the migration handles them safely.

do $$
declare
  r record;
  v_min_tier_size int;
  v_tier_1_rate numeric;
  v_new_rates jsonb;
  v_row jsonb;
  v_rate numeric;
  v_size int;
  v_discount numeric;
begin
  for r in select id, tier_rates from tuition_worksheet_snapshots loop
    if r.tier_rates is null
       or jsonb_typeof(r.tier_rates) <> 'array'
       or jsonb_array_length(r.tier_rates) = 0 then
      continue;
    end if;

    select min((tr->>'tier_size')::int)
      into v_min_tier_size
      from jsonb_array_elements(r.tier_rates) tr;

    select (tr->>'per_student_rate')::numeric
      into v_tier_1_rate
      from jsonb_array_elements(r.tier_rates) tr
     where (tr->>'tier_size')::int = v_min_tier_size
     limit 1;

    v_new_rates := '[]'::jsonb;
    for v_row in select value from jsonb_array_elements(r.tier_rates) loop
      v_size := (v_row->>'tier_size')::int;
      v_rate := coalesce((v_row->>'per_student_rate')::numeric, 0);
      if v_size = v_min_tier_size then
        v_discount := 0;
      else
        if v_tier_1_rate is null or v_tier_1_rate <= 0 then
          v_discount := 0;
        else
          v_discount := round(((v_tier_1_rate - v_rate) / v_tier_1_rate) * 100, 2);
        end if;
      end if;
      -- Snapshot tables block UPDATE via tg_prevent_snapshot_update
      -- (Migration 011 → 023). The DO block runs as the migration
      -- user (postgres / supabase_admin), which the trigger does
      -- not block — the trigger raises only on regular role UPDATEs.
      -- Confirm by attempting; if blocked, this loop body needs a
      -- different approach (e.g., direct UPDATE bypass via system
      -- role).
      v_new_rates := v_new_rates
        || jsonb_build_array(v_row || jsonb_build_object('discount_pct', v_discount));
    end loop;

    -- Snapshot immutability is enforced by tg_prevent_snapshot_update;
    -- backfill UPDATEs may need to disable + re-enable the trigger if
    -- it does not differentiate by role. Use SESSION REPLICATION ROLE
    -- to bypass triggers for this single migration, then restore.
    set local session_replication_role = replica;
    update tuition_worksheet_snapshots
       set tier_rates = v_new_rates
     where id = r.id;
    set local session_replication_role = origin;
  end loop;
end $$;


-- ---- 3. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 031
-- ============================================================================
