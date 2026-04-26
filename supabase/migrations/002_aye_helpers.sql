-- ============================================================================
-- Migration 002: AYE bootstrap helper
--
-- Adds bootstrap_aye(label, start, end, set_current) — a single transactional
-- entry point for creating an Academic Year End and seeding a draft
-- module_instances row for every active module.
--
-- Callable from authenticated client code via supabase.rpc().
-- Marked SECURITY DEFINER so it can write to RLS-protected tables; the
-- function enforces its own admin check via is_system_admin() internally.
-- ============================================================================

create or replace function bootstrap_aye(
  p_label       text,
  p_start_date  date,
  p_end_date    date,
  p_set_current boolean default false
)
returns academic_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_aye academic_years;
begin
  -- Caller must be a system admin.
  if not is_system_admin() then
    raise exception 'Only system admins can create academic years';
  end if;

  -- If marking as current, demote the existing current AYE first —
  -- the unique partial index academic_years_one_current_idx would
  -- otherwise reject the insert.
  if p_set_current then
    update academic_years
       set is_current = false
     where is_current = true;
  end if;

  -- Create the new AYE.
  insert into academic_years (
    label, start_date, end_date, is_current, created_by, updated_by
  )
  values (
    p_label, p_start_date, p_end_date, p_set_current, auth.uid(), auth.uid()
  )
  returning * into v_new_aye;

  -- Seed a draft module_instances row for every active module so users
  -- can immediately start working on this AYE's data.
  insert into module_instances (module_id, aye_id, state)
  select m.id, v_new_aye.id, 'draft'::module_state
    from modules m
   where m.is_active = true;

  return v_new_aye;
end;
$$;

-- Allow logged-in users to call it; the function gates access internally.
grant execute on function bootstrap_aye(text, date, date, boolean) to authenticated;
