-- Approval gate: only people on an org's Team list may use the app.
-- * Active members are approved (RLS already scopes every table to is_org_member/has_org_role, so a signed-in user
--   with no membership reads and writes nothing).
-- * A user whose verified email matches an unexpired, unrevoked PENDING invitation is auto-joined on sign-in
--   (same effect as clicking the invite link), so invitees can sign in directly.
-- * Removed members, revoked/expired invites and everyone else are not approved; the API answers 403 not_approved.

create or replace function public.claim_pending_invitations()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_user  uuid := (select auth.uid());
  v_email text := lower(btrim(coalesce((select auth.jwt()) ->> 'email', '')));
  v_inv   public.invitations%rowtype;
  v_n     integer := 0;
begin
  if v_user is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if v_email = '' then return 0; end if;
  for v_inv in
    select * from public.invitations i
    where i.email = v_email and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
    order by i.created_at
    for update
  loop
    if not exists (select 1 from public.memberships m where m.org_id = v_inv.org_id and m.user_id = v_user) then
      insert into public.memberships (org_id, user_id, role, created_by) values (v_inv.org_id, v_user, v_inv.role, v_inv.invited_by);
      v_n := v_n + 1;
    end if;
    update public.invitations set accepted_at = now(), accepted_by = v_user where id = v_inv.id;
    insert into public.outreach_events (org_id, actor_id, event_type, details)
      values (v_inv.org_id, v_user, 'invitation_accepted', jsonb_build_object('invitationId', v_inv.id, 'role', v_inv.role, 'via', 'sign_in'));
  end loop;
  return v_n;
end $$;
revoke all on function public.claim_pending_invitations() from public, anon;
grant execute on function public.claim_pending_invitations() to authenticated;
