-- Team management: invitations, member roster with emails, last-owner protection.

-- ───────────────────────────── Invitations ─────────────────────────────
create table public.invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  email        text not null check (email = lower(btrim(email)) and char_length(email) <= 320
                                    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role         public.member_role not null default 'staff',
  -- sha256(hex) of the secret token in the invite link. The raw token is never stored.
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_sent_at timestamptz not null default now(),
  send_count   integer not null default 1 check (send_count between 1 and 100),
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users (id) on delete set null,
  revoked_at   timestamptz,
  revoked_by   uuid references auth.users (id) on delete set null,
  check (accepted_at is null or revoked_at is null),
  check (expires_at > created_at)
);
-- At most one open invitation per org + email.
create unique index invitations_pending_uidx on public.invitations (org_id, email)
  where accepted_at is null and revoked_at is null;
create index invitations_org_idx on public.invitations (org_id, created_at desc);

create trigger invitations_set_updated_at before update on public.invitations
  for each row execute function public.set_updated_at();

alter table public.invitations enable row level security;

-- Owners/admins manage invitations. Only owners can invite (or re-role an invite to) 'owner'.
create policy invitations_select on public.invitations for select to authenticated
  using (public.has_org_role(org_id, '{owner,admin}'));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (public.has_org_role(org_id, '{owner,admin}')
              and (role <> 'owner' or public.has_org_role(org_id, '{owner}'))
              and invited_by = (select auth.uid())
              and accepted_at is null and revoked_at is null);
create policy invitations_update on public.invitations for update to authenticated
  using (public.has_org_role(org_id, '{owner,admin}') and (role <> 'owner' or public.has_org_role(org_id, '{owner}')))
  with check (public.has_org_role(org_id, '{owner,admin}') and (role <> 'owner' or public.has_org_role(org_id, '{owner}'))
              and accepted_at is null);
-- No delete policy: invitations are revoked, never deleted (audit).

grant select, insert, update on public.invitations to authenticated;
revoke all on public.invitations from anon;

-- ───────────────────────────── Last owner guard ─────────────────────────────
-- An org must always keep at least one owner. Applies to every path (API, SQL editor, cascades from
-- auth.users deletion), except when the organization itself is being deleted.
create or replace function public.enforce_last_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner' and new.org_id = old.org_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Serialize concurrent owner changes within one org.
  perform 1 from public.organizations where id = old.org_id for update;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;   -- org is being deleted
  end if;
  if not exists (select 1 from public.memberships
                 where org_id = old.org_id and role = 'owner' and user_id <> old.user_id) then
    raise exception 'last_owner' using errcode = 'P0001',
      hint = 'Promote another member to owner first.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger memberships_last_owner before update or delete on public.memberships
  for each row execute function public.enforce_last_owner();

-- ───────────────────────────── Roster (with emails) ─────────────────────────────
-- auth.users is not readable by `authenticated`; expose only emails of co-members.
create or replace function public.list_org_members(p_org uuid)
returns table (user_id uuid, email text, role public.member_role, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.org_id = p_org and public.is_org_member(p_org)
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(u.email::text)
$$;

-- ───────────────────────────── Accepting ─────────────────────────────
-- The signed-in user's verified email (from the JWT) must match the invitation.
create or replace function public.accept_invitation(p_token_hash text)
returns table (org_id uuid, role public.member_role, already_member boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_user  uuid := (select auth.uid());
  v_email text := lower(btrim(coalesce((select auth.jwt()) ->> 'email', '')));
  v_inv   public.invitations%rowtype;
  v_role  public.member_role;
  v_existing boolean;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into v_inv from public.invitations i where i.token_hash = p_token_hash for update;
  if not found then raise exception 'invitation_invalid' using errcode = 'P0001'; end if;
  if v_inv.revoked_at is not null then raise exception 'invitation_revoked' using errcode = 'P0001'; end if;
  if v_inv.accepted_at is not null then
    if v_inv.accepted_by = v_user then
      return query select v_inv.org_id, m.role, true from public.memberships m
        where m.org_id = v_inv.org_id and m.user_id = v_user;
      return;
    end if;
    raise exception 'invitation_used' using errcode = 'P0001';
  end if;
  if v_inv.expires_at <= now() then raise exception 'invitation_expired' using errcode = 'P0001'; end if;
  if v_email = '' or v_email <> v_inv.email then
    raise exception 'invitation_email_mismatch' using errcode = 'P0001';
  end if;

  select m.role into v_role from public.memberships m where m.org_id = v_inv.org_id and m.user_id = v_user;
  v_existing := found;
  if not v_existing then
    insert into public.memberships (org_id, user_id, role, created_by)
      values (v_inv.org_id, v_user, v_inv.role, v_inv.invited_by);
    v_role := v_inv.role;
  end if;
  update public.invitations set accepted_at = now(), accepted_by = v_user where id = v_inv.id;
  insert into public.outreach_events (org_id, actor_id, event_type, details)
    values (v_inv.org_id, v_user, 'invitation_accepted',
            jsonb_build_object('invitationId', v_inv.id, 'role', v_role, 'alreadyMember', v_existing));
  return query select v_inv.org_id, v_role, v_existing;
end $$;

-- Minimal, non-sensitive details for the accept page (token holders only).
create or replace function public.preview_invitation(p_token_hash text)
returns table (org_name text, email text, role public.member_role, status text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.name, i.email, i.role,
    case when i.revoked_at is not null then 'revoked'
         when i.accepted_at is not null then 'accepted'
         when i.expires_at <= now() then 'expired'
         else 'pending' end,
    i.expires_at
  from public.invitations i join public.organizations o on o.id = i.org_id
  where i.token_hash = p_token_hash
$$;

revoke execute on function public.enforce_last_owner(), public.list_org_members(uuid),
  public.accept_invitation(text), public.preview_invitation(text) from public, anon;
grant execute on function public.list_org_members(uuid), public.accept_invitation(text) to authenticated;
-- preview_invitation is called by the backend's privileged connection only.
