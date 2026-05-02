-- ============================================================================
-- Migration 020: Refactor unlock workflow to two-identity model
--
-- v3.7. The unlock workflow originally shipped (H1 / Migration 016) with a
-- three-identity model: the requester, approver_1, and approver_2 all had
-- to be distinct people. The intended model — and what this migration
-- collapses to — is two identities: the requester's submission counts as
-- approval_1, and one additional approver completes the unlock as
-- approval_2.
--
-- Schema effect of the refactor: drop the CHECK constraint that prevented
-- the requester from also being approver_1. The other constraints stay.
--
-- Migration 021 (separate file) updates the three SECURITY DEFINER
-- functions to populate approval_1 atomically at request time. This
-- migration is schema-only.
--
-- Pre-migration requirement: no rows in budget_stage_scenarios with
-- unlock_requested = true at apply time. Verified by the operator
-- before running this migration. If any pending unlock request had
-- existed, dropping the constraint would still be safe (the constraint
-- only fires on UPDATE/INSERT, not on existing rows), but the live
-- pending request was already withdrawn so this is moot.
-- ============================================================================

alter table budget_stage_scenarios
  drop constraint if exists unlock_initiator_not_approver_1;

-- Remaining constraints (kept):
--   unlock_initiator_not_approver_2  — requester ≠ approval_2
--   unlock_approvers_distinct        — approval_1 ≠ approval_2
--                                       (still meaningful: prevents the
--                                       requester-as-approval_1 from
--                                       also being approval_2 by re-
--                                       calling the approve RPC. The
--                                       function-layer initiator check
--                                       is the primary guard; this
--                                       constraint is the schema floor.)
--   unlock_sequential_ordering       — approval_2 cannot populate
--                                       before approval_1
--   tg_unlock_only_when_locked       — unlock_requested = true requires
--                                       state = 'locked'

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 020
-- ============================================================================
