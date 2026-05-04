-- ============================================================================
-- Migration 041: Tuition-B2-import — staging RPCs (v3.8.18)
--
-- Three SECURITY DEFINER functions implementing the bulk import
-- workflow on the staging tables introduced in Migration 040.
--
--   create_tuition_audit_import_batch — uploads parsed rows into
--     staging; runs server-side validation; returns batch_id
--   accept_tuition_audit_import_batch — commits staged rows into
--     tuition_worksheet_family_details (append or replace mode);
--     applies faculty cascade; writes synthetic change_log row for
--     Recent Activity surfacing
--   reject_tuition_audit_import_batch — marks the batch rejected;
--     retains staged data as historical audit record; writes
--     synthetic change_log row
--
-- Defense-in-depth posture: server-side validation runs in
-- create_tuition_audit_import_batch even though the client also
-- validates (the client validation is for UX; the server validation
-- is for trust). Hard errors and warnings both surface in the
-- staging UI; only hard errors block accept.
--
-- Audit-trail surfacing per v3.8.17 lesson: each accept/reject
-- writes a SYNTHETIC change_log row pointed at the parent scenario
-- (target_table='tuition_worksheet_scenarios', field_name=
-- '__import_accepted__' / '__import_rejected__') so the Recent
-- Activity feed picks it up via Tuition-D's MODULE_AUDIT_CONFIGS.
-- The natural change_log rows on tuition_audit_import_batches /
-- tuition_audit_import_staged_rows tables also exist (per Migration
-- 040 triggers) but are invisible to the activity feed today.
-- ============================================================================


-- ---- Helper: validate a single staged row -------------------------------
--
-- Returns a record (parse_errors, parse_warnings) describing the
-- validation outcome for a single parsed row. The errors/warnings
-- are jsonb arrays of {field, message} objects.
--
-- Hard errors (parse_errors) BLOCK accept:
--   - missing family_label
--   - missing students_enrolled
--   - students_enrolled < 1 or non-integer
--   - negative discount amounts
--   - date_withdrawn before date_enrolled (when both present)
--
-- Soft warnings (parse_warnings) ADVISE but do not block:
--   - is_faculty_family=true with non-auto faculty_discount_amount
--     value (suggests operator deliberately overrode; reminds them
--     about the gold-dot indicator)
--   - faculty_discount_amount provided when is_faculty_family=false
--     (likely operator confusion — non-faculty rows shouldn't have
--     a faculty discount)

create or replace function tg_validate_tuition_import_row(
  p_row tuition_audit_import_staged_rows
)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  v_errors   jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  -- Family label required.
  if p_row.family_label is null or length(trim(p_row.family_label)) = 0 then
    v_errors := v_errors || jsonb_build_object(
      'field',   'family_label',
      'message', 'Family Name is required.'
    );
  end if;

  -- Students enrolled required and >= 1.
  if p_row.students_enrolled is null then
    v_errors := v_errors || jsonb_build_object(
      'field',   'students_enrolled',
      'message', '# Enrolled is required.'
    );
  elsif p_row.students_enrolled < 1 then
    v_errors := v_errors || jsonb_build_object(
      'field',   'students_enrolled',
      'message', '# Enrolled must be at least 1.'
    );
  end if;

  -- Discount amounts must be non-negative.
  if p_row.faculty_discount_amount is not null and p_row.faculty_discount_amount < 0 then
    v_errors := v_errors || jsonb_build_object(
      'field',   'faculty_discount_amount',
      'message', 'Discount amounts must be entered as positive numbers; the system displays them as negative on the page.'
    );
  end if;
  if p_row.other_discount_amount is not null and p_row.other_discount_amount < 0 then
    v_errors := v_errors || jsonb_build_object(
      'field',   'other_discount_amount',
      'message', 'Discount amounts must be entered as positive numbers.'
    );
  end if;
  if p_row.financial_aid_amount is not null and p_row.financial_aid_amount < 0 then
    v_errors := v_errors || jsonb_build_object(
      'field',   'financial_aid_amount',
      'message', 'Discount amounts must be entered as positive numbers.'
    );
  end if;

  -- Date order: date_withdrawn must be on or after date_enrolled.
  if p_row.date_enrolled is not null
     and p_row.date_withdrawn is not null
     and p_row.date_withdrawn < p_row.date_enrolled then
    v_errors := v_errors || jsonb_build_object(
      'field',   'date_withdrawn',
      'message', 'Date Withdrawn cannot be before Date Enrolled.'
    );
  end if;

  -- Faculty-discount on non-faculty row (likely confusion).
  if (p_row.is_faculty_family is null or p_row.is_faculty_family = false)
     and p_row.faculty_discount_amount is not null
     and p_row.faculty_discount_amount > 0 then
    v_warnings := v_warnings || jsonb_build_object(
      'field',   'faculty_discount_amount',
      'message', 'Faculty Discount is set but Faculty column is not "Yes". The discount applies only to faculty families; consider clearing this value or marking the family as faculty.'
    );
  end if;

  return jsonb_build_object('errors', v_errors, 'warnings', v_warnings);
end;
$$;


-- ---- 1. create_tuition_audit_import_batch -------------------------------
--
-- Parses rows from p_parsed_rows (jsonb array of objects keyed by
-- column name) and inserts them into staging. Server-side validation
-- runs per-row via tg_validate_tuition_import_row; results populate
-- parse_errors and parse_warnings.
--
-- p_parsed_rows[N] keys (snake_case, normalized client-side):
--   family_label              (text)
--   students_enrolled         (int)
--   is_faculty_family         (bool)
--   date_enrolled             (text or null; ISO 'YYYY-MM-DD' or
--                              null)
--   date_withdrawn            (text or null; ISO 'YYYY-MM-DD')
--   faculty_discount_amount   (numeric or null)
--   other_discount_amount     (numeric or null)
--   financial_aid_amount      (numeric or null)
--   notes                     (text or null)
--   raw_row                   (jsonb; original parsed shape for
--                              diagnostic visibility)

create or replace function create_tuition_audit_import_batch(
  p_scenario_id  uuid,
  p_file_name    text,
  p_file_format  text,
  p_parsed_rows  jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller       uuid := auth.uid();
  v_scenario     record;
  v_stage        record;
  v_batch_id     uuid;
  v_row_count    int;
  v_index        int;
  v_row_data     jsonb;
  v_staged_id    uuid;
  v_validation   jsonb;
begin
  if not current_user_has_module_perm('tuition', 'edit') then
    raise exception 'Bulk import requires edit permission on tuition.';
  end if;

  if p_file_format not in ('csv', 'xlsx') then
    raise exception 'Invalid file_format "%". Allowed: csv, xlsx.', p_file_format;
  end if;

  if jsonb_typeof(p_parsed_rows) <> 'array' then
    raise exception 'p_parsed_rows must be a JSON array.';
  end if;

  v_row_count := jsonb_array_length(p_parsed_rows);
  if v_row_count = 0 then
    raise exception 'Cannot create an empty import batch. The uploaded file produced no parsed rows.';
  end if;

  -- Scenario must exist and be Stage 2.
  select * into v_scenario
    from tuition_worksheet_scenarios
   where id = p_scenario_id;
  if v_scenario is null then
    raise exception 'Scenario % not found.', p_scenario_id;
  end if;
  select s.stage_type into v_stage
    from module_workflow_stages s
   where s.id = v_scenario.stage_id;
  if v_stage.stage_type <> 'final' then
    raise exception
      'Bulk import operates on Stage 2 (Tuition Audit) scenarios only. The provided scenario''s stage_type is %.',
      v_stage.stage_type;
  end if;
  if v_scenario.state <> 'drafting' then
    raise exception
      'Stage 2 scenarios should always be in drafting state. Current state: %.',
      v_scenario.state;
  end if;

  -- Insert the batch header.
  insert into tuition_audit_import_batches (
    scenario_id, uploaded_by, file_name, file_format, row_count, status
  ) values (
    p_scenario_id, v_caller, trim(p_file_name), p_file_format, v_row_count, 'staged'
  )
  returning id into v_batch_id;

  -- Insert each staged row, validate inline.
  for v_index in 0 .. (v_row_count - 1) loop
    v_row_data := p_parsed_rows -> v_index;

    insert into tuition_audit_import_staged_rows (
      batch_id, row_number,
      family_label, students_enrolled, is_faculty_family,
      date_enrolled, date_withdrawn,
      faculty_discount_amount, other_discount_amount, financial_aid_amount,
      notes,
      raw_row
    ) values (
      v_batch_id, v_index + 1,
      nullif(trim(coalesce(v_row_data->>'family_label', '')), ''),
      case when v_row_data ? 'students_enrolled' and v_row_data->>'students_enrolled' is not null and v_row_data->>'students_enrolled' <> ''
           then (v_row_data->>'students_enrolled')::int else null end,
      case when v_row_data ? 'is_faculty_family' and v_row_data->>'is_faculty_family' is not null
           then (v_row_data->>'is_faculty_family')::boolean else null end,
      case when v_row_data ? 'date_enrolled' and v_row_data->>'date_enrolled' is not null and v_row_data->>'date_enrolled' <> ''
           then (v_row_data->>'date_enrolled')::date else null end,
      case when v_row_data ? 'date_withdrawn' and v_row_data->>'date_withdrawn' is not null and v_row_data->>'date_withdrawn' <> ''
           then (v_row_data->>'date_withdrawn')::date else null end,
      case when v_row_data ? 'faculty_discount_amount' and v_row_data->>'faculty_discount_amount' is not null and v_row_data->>'faculty_discount_amount' <> ''
           then (v_row_data->>'faculty_discount_amount')::numeric else null end,
      case when v_row_data ? 'other_discount_amount' and v_row_data->>'other_discount_amount' is not null and v_row_data->>'other_discount_amount' <> ''
           then (v_row_data->>'other_discount_amount')::numeric else null end,
      case when v_row_data ? 'financial_aid_amount' and v_row_data->>'financial_aid_amount' is not null and v_row_data->>'financial_aid_amount' <> ''
           then (v_row_data->>'financial_aid_amount')::numeric else null end,
      nullif(trim(coalesce(v_row_data->>'notes', '')), ''),
      coalesce(v_row_data, '{}'::jsonb)
    )
    returning id into v_staged_id;

    -- Validate the row we just inserted; populate parse_errors /
    -- parse_warnings.
    update tuition_audit_import_staged_rows
       set parse_errors   = (tg_validate_tuition_import_row(tuition_audit_import_staged_rows.*) ->> 'errors')::jsonb,
           parse_warnings = (tg_validate_tuition_import_row(tuition_audit_import_staged_rows.*) ->> 'warnings')::jsonb
     where id = v_staged_id;
  end loop;

  return v_batch_id;
end;
$$;

grant execute on function create_tuition_audit_import_batch(uuid, text, text, jsonb) to authenticated;


-- ---- 2. accept_tuition_audit_import_batch -------------------------------
--
-- Commits all error-free staged rows into tuition_worksheet_family_
-- details, applying the faculty cascade rules. Validates that no
-- staged row has parse_errors (defense-in-depth — UI should also
-- gate). p_mode = 'append' preserves existing rows; 'replace'
-- deletes existing rows first (in same transaction).
--
-- Faculty cascade applied during commit: when is_faculty_family =
-- true, applied_tier_size = 1 and applied_tier_rate = base_rate
-- (read from scenario.tier_rates jsonb). When the operator did not
-- supply faculty_discount_amount, auto-populate as base × students
-- × pct/100. When they did supply it, the supplied value is treated
-- as a manual override (gold dot post-import; the existing
-- override-detection logic in tuitionMath.js compares stored vs.
-- auto-computed at render time).
--
-- For non-faculty rows, applied_tier_size = students_enrolled
-- (capped at top tier_size), applied_tier_rate = the corresponding
-- per-student rate from tier_rates jsonb.
--
-- Synthetic change_log row pointed at the scenario surfaces the
-- import event in Recent Activity (per v3.8.17 audit-trail lesson).

create or replace function accept_tuition_audit_import_batch(
  p_batch_id  uuid,
  p_mode      text
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller       uuid := auth.uid();
  v_batch        record;
  v_scenario     record;
  v_error_count  int;
  v_committed    int := 0;
  v_base_rate    numeric;
  v_top_tier     int;
  v_faculty_pct  numeric;
  v_row          record;
  v_tier_size    int;
  v_tier_rate    numeric;
  v_faculty_amt  numeric;
begin
  if not current_user_has_module_perm('tuition', 'edit') then
    raise exception 'Accepting an import batch requires edit permission on tuition.';
  end if;

  if p_mode not in ('append', 'replace') then
    raise exception 'Invalid mode "%". Allowed: append, replace.', p_mode;
  end if;

  -- Fetch the batch and lock it.
  select * into v_batch
    from tuition_audit_import_batches
   where id = p_batch_id
   for update;
  if v_batch is null then
    raise exception 'Import batch % not found.', p_batch_id;
  end if;
  if v_batch.status <> 'staged' then
    raise exception
      'Cannot accept a batch in status "%". Only staged batches can be accepted.',
      v_batch.status;
  end if;

  -- Defensive: any row with parse_errors blocks accept.
  select count(*) into v_error_count
    from tuition_audit_import_staged_rows
   where batch_id = p_batch_id
     and jsonb_array_length(parse_errors) > 0;
  if v_error_count > 0 then
    raise exception
      'Cannot accept import batch: % row(s) have validation errors. Reject the batch and re-upload after fixing the source spreadsheet.',
      v_error_count;
  end if;

  -- Resolve scenario configuration for the faculty cascade.
  select * into v_scenario
    from tuition_worksheet_scenarios
   where id = v_batch.scenario_id;
  if v_scenario is null then
    raise exception 'Scenario % no longer exists.', v_batch.scenario_id;
  end if;

  v_base_rate := coalesce(
    (select (item->>'per_student_rate')::numeric
       from jsonb_array_elements(v_scenario.tier_rates) item
      where (item->>'tier_size')::int = 1
      limit 1),
    0
  );
  v_top_tier := coalesce(
    (select max((item->>'tier_size')::int)
       from jsonb_array_elements(v_scenario.tier_rates) item),
    1
  );
  v_faculty_pct := coalesce(v_scenario.faculty_discount_pct, 0);

  -- Replace mode: delete existing family_details rows.
  if p_mode = 'replace' then
    delete from tuition_worksheet_family_details
     where scenario_id = v_batch.scenario_id;
  end if;

  -- Walk staged rows in row_number order; commit each.
  for v_row in
    select * from tuition_audit_import_staged_rows
     where batch_id = p_batch_id
     order by row_number
  loop
    -- Faculty cascade.
    if v_row.is_faculty_family then
      v_tier_size := 1;
      v_tier_rate := v_base_rate;
      -- Auto-populate faculty discount if operator did not provide.
      if v_row.faculty_discount_amount is null then
        v_faculty_amt := v_base_rate * v_row.students_enrolled * (v_faculty_pct / 100.0);
      else
        v_faculty_amt := v_row.faculty_discount_amount;
      end if;
    else
      -- Non-faculty: tier resolves from students_enrolled, capped
      -- at the top configured tier_size.
      v_tier_size := least(v_row.students_enrolled, v_top_tier);
      v_tier_rate := coalesce(
        (select (item->>'per_student_rate')::numeric
           from jsonb_array_elements(v_scenario.tier_rates) item
          where (item->>'tier_size')::int = v_tier_size
          limit 1),
        v_base_rate
      );
      v_faculty_amt := null;
    end if;

    insert into tuition_worksheet_family_details (
      scenario_id, family_label, students_enrolled,
      applied_tier_size, applied_tier_rate,
      faculty_discount_amount, other_discount_amount, financial_aid_amount,
      notes,
      is_faculty_family, date_enrolled, date_withdrawn,
      created_by, updated_by
    ) values (
      v_batch.scenario_id, v_row.family_label, v_row.students_enrolled,
      v_tier_size, v_tier_rate,
      v_faculty_amt, v_row.other_discount_amount, v_row.financial_aid_amount,
      v_row.notes,
      coalesce(v_row.is_faculty_family, false), v_row.date_enrolled, v_row.date_withdrawn,
      v_caller, v_caller
    );

    v_committed := v_committed + 1;
  end loop;

  -- Mark the batch accepted.
  update tuition_audit_import_batches
     set status      = 'accepted',
         mode        = p_mode,
         accepted_at = now()
   where id = p_batch_id;

  -- Synthetic change_log row pointed at the scenario, so the
  -- Recent Activity feed surfaces the event (per Tuition-D's
  -- MODULE_AUDIT_CONFIGS.tuition which queries by scenario table).
  insert into change_log (
    target_table, target_id, field_name,
    old_value, new_value,
    changed_by, changed_at, reason
  ) values (
    'tuition_worksheet_scenarios',
    v_batch.scenario_id,
    '__import_accepted__',
    null,
    jsonb_build_object(
      'batch_id',     p_batch_id,
      'file_name',    v_batch.file_name,
      'mode',         p_mode,
      'row_count',    v_committed
    ),
    v_caller,
    now(),
    'import_accepted: ' || v_committed || ' families ' || p_mode
  );

  return v_committed;
end;
$$;

grant execute on function accept_tuition_audit_import_batch(uuid, text) to authenticated;


-- ---- 3. reject_tuition_audit_import_batch -------------------------------

create or replace function reject_tuition_audit_import_batch(
  p_batch_id  uuid,
  p_reason    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_batch    record;
  v_label    text;
begin
  if not current_user_has_module_perm('tuition', 'edit') then
    raise exception 'Rejecting an import batch requires edit permission on tuition.';
  end if;

  select * into v_batch
    from tuition_audit_import_batches
   where id = p_batch_id
   for update;
  if v_batch is null then
    raise exception 'Import batch % not found.', p_batch_id;
  end if;
  if v_batch.status <> 'staged' then
    raise exception
      'Cannot reject a batch in status "%". Only staged batches can be rejected.',
      v_batch.status;
  end if;

  v_label := nullif(trim(coalesce(p_reason, '')), '');

  update tuition_audit_import_batches
     set status          = 'rejected',
         rejected_at     = now(),
         rejected_reason = v_label
   where id = p_batch_id;

  -- Synthetic change_log row pointed at the scenario.
  insert into change_log (
    target_table, target_id, field_name,
    old_value, new_value,
    changed_by, changed_at, reason
  ) values (
    'tuition_worksheet_scenarios',
    v_batch.scenario_id,
    '__import_rejected__',
    null,
    jsonb_build_object(
      'batch_id',  p_batch_id,
      'file_name', v_batch.file_name,
      'reason',    v_label,
      'row_count', v_batch.row_count
    ),
    v_caller,
    now(),
    'import_rejected'
      || case when v_label is not null then ': ' || v_label else '' end
  );

  return p_batch_id;
end;
$$;

grant execute on function reject_tuition_audit_import_batch(uuid, text) to authenticated;


-- ---- 4. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 041
-- ============================================================================
