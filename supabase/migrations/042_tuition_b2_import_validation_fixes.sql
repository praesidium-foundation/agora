-- ============================================================================
-- Migration 042: Tuition-B2-import polish — validation gap fixes (v3.8.19)
--
-- The B2-import walkthrough surfaced three validation rules that
-- were specified in the build prompt but didn't engage as expected.
-- Migration 042 closes the gaps via CREATE OR REPLACE on two
-- functions; no schema change.
--
-- Gaps addressed:
--
--   1. Negative discount values produce WARNINGS, not errors.
--      Migration 041 raised them as hard errors, blocking accept.
--      Spec calls for a warning ("Discounts are entered as positive
--      numbers; the system displays them as negative on the page")
--      with the value still committed (operator decides to accept
--      or reject). v3.8.19 flips error → warning on three discount
--      fields: faculty_discount_amount, other_discount_amount,
--      financial_aid_amount.
--
--   2. Unparseable dates produce HARD ERRORS visible in staging.
--      The client-side parser already detects unparseable dates and
--      flags them, but the upload modal previously dropped those
--      errors when posting to the RPC — only the normalized data
--      crossed the wire, never the client's parse_errors /
--      parse_warnings arrays. The fix has two halves:
--        (a) Upload modal (TuitionImportUploadModal.jsx) now
--            includes `client_parse_errors` and
--            `client_parse_warnings` arrays per row in the
--            p_parsed_rows payload.
--        (b) This migration's RPC reads those arrays as the
--            STARTING set of staged-row errors/warnings, and
--            APPENDS server-side validation outcomes on top.
--      Result: client-flagged unparseable-date errors now surface
--      in the staging UI with the correct message ("Date format
--      not recognized. Use MM/DD/YYYY or YYYY-MM-DD.") and block
--      accept.
--
--   3. date_withdrawn before date_enrolled produces WARNING, not
--      error. Migration 041 raised it as a hard error; spec calls
--      for a warning ("Withdrawal date appears to be before the
--      enrollment date.") because there are edge cases where
--      unusual date relationships are legitimate. The client-side
--      parser ALSO emits this warning (per v3.8.19 parser update);
--      both layers fire so the warning surfaces regardless of
--      where the dates were caught.
--
-- Class-of-issue note (v3.8.19 history entry): spec-vs-implementation
-- drift on validation logic is a recurring failure mode. The "happy
-- path" gets implemented; edge-case validators get skipped without
-- surfacing in compile errors or smoke tests. Future builds should
-- explicitly verify each spec'd validation rule fires against
-- intentional bad data before declaring the validation surface
-- complete. Adding the test fixture path is queued.
--
-- Function signatures unchanged — both functions go through CREATE
-- OR REPLACE without DROP. Argument lists, return types, and
-- behavior contracts on valid-data paths are preserved.
-- ============================================================================


-- ---- 1. tg_validate_tuition_import_row — flip errors → warnings ---------
--
-- Two rule changes from Migration 041:
--   - Negative discount: error → warning
--   - date_withdrawn before date_enrolled: error → warning
-- The existing rules (missing family_label, missing/invalid
-- students_enrolled, faculty_discount on non-faculty row) preserve
-- their classifications.

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
  -- Family label required (unchanged: hard error).
  if p_row.family_label is null or length(trim(p_row.family_label)) = 0 then
    v_errors := v_errors || jsonb_build_object(
      'field',   'family_label',
      'message', 'Family Name is required.'
    );
  end if;

  -- Students enrolled required and >= 1 (unchanged: hard error).
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

  -- Negative discount amounts → WARNING (v3.8.19 spec change).
  -- The value is staged as-parsed; operator sees the warning and
  -- decides whether to proceed.
  if p_row.faculty_discount_amount is not null and p_row.faculty_discount_amount < 0 then
    v_warnings := v_warnings || jsonb_build_object(
      'field',   'faculty_discount_amount',
      'message', 'Discounts are entered as positive numbers; the system displays them as negative on the page.'
    );
  end if;
  if p_row.other_discount_amount is not null and p_row.other_discount_amount < 0 then
    v_warnings := v_warnings || jsonb_build_object(
      'field',   'other_discount_amount',
      'message', 'Discounts are entered as positive numbers; the system displays them as negative on the page.'
    );
  end if;
  if p_row.financial_aid_amount is not null and p_row.financial_aid_amount < 0 then
    v_warnings := v_warnings || jsonb_build_object(
      'field',   'financial_aid_amount',
      'message', 'Discounts are entered as positive numbers; the system displays them as negative on the page.'
    );
  end if;

  -- date_withdrawn before date_enrolled → WARNING (v3.8.19 spec
  -- change). Edge cases where unusual date relationships are
  -- legitimate (e.g., a sibling joining on a withdrawn family's
  -- behalf, mid-year transitions); operator decides.
  if p_row.date_enrolled is not null
     and p_row.date_withdrawn is not null
     and p_row.date_withdrawn < p_row.date_enrolled then
    v_warnings := v_warnings || jsonb_build_object(
      'field',   'date_withdrawn',
      'message', 'Withdrawal date appears to be before the enrollment date.'
    );
  end if;

  -- Faculty-discount on non-faculty row (unchanged: warning).
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


-- ---- 2. create_tuition_audit_import_batch — preserve client errors ------
--
-- The RPC now reads `client_parse_errors` and `client_parse_warnings`
-- from each element of p_parsed_rows. Those arrays become the
-- STARTING values of the staged row's parse_errors / parse_warnings;
-- server-side validation results from tg_validate_tuition_import_row
-- are APPENDED on top.
--
-- This closes the v3.8.19 gap where client-detected unparseable
-- dates (and other client-only validations) were lost on the wire.
-- Result: any client-side parse error or warning now surfaces in
-- the staging UI alongside server-side validation outcomes.

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
  v_client_errors   jsonb;
  v_client_warnings jsonb;
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

  -- Insert each staged row + validate inline.
  for v_index in 0 .. (v_row_count - 1) loop
    v_row_data := p_parsed_rows -> v_index;

    -- v3.8.19: read client-side errors/warnings as the starting
    -- set. They merge with server-side validation outcomes via
    -- jsonb || concatenation in the UPDATE below.
    v_client_errors := coalesce(v_row_data -> 'client_parse_errors', '[]'::jsonb);
    if jsonb_typeof(v_client_errors) <> 'array' then
      v_client_errors := '[]'::jsonb;
    end if;
    v_client_warnings := coalesce(v_row_data -> 'client_parse_warnings', '[]'::jsonb);
    if jsonb_typeof(v_client_warnings) <> 'array' then
      v_client_warnings := '[]'::jsonb;
    end if;

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

    -- Validate the row + merge with client-supplied errors/warnings.
    -- The client array is the FIRST set; server-side validation
    -- appends its findings via jsonb concatenation.
    update tuition_audit_import_staged_rows
       set parse_errors   = v_client_errors
                          || ((tg_validate_tuition_import_row(tuition_audit_import_staged_rows.*) ->> 'errors')::jsonb),
           parse_warnings = v_client_warnings
                          || ((tg_validate_tuition_import_row(tuition_audit_import_staged_rows.*) ->> 'warnings')::jsonb)
     where id = v_staged_id;
  end loop;

  return v_batch_id;
end;
$$;

grant execute on function create_tuition_audit_import_batch(uuid, text, text, jsonb) to authenticated;


-- ---- 3. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 042
-- ============================================================================
