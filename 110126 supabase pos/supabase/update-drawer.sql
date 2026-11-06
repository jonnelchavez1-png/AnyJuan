-- UPDATE: adds the CASH DRAWER (open a shift, count the cash, close with over/short) to a shop that already ran setup.sql.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run. It is safe to run twice.
-- It only ADDS two new tables and some new functions. Nothing that exists today is changed or removed:
-- sales, payments, returns, expenses, the Dashboard and the Tax report work exactly as before.
-- (Run update-returns.sql first if you have not yet.) Success looks like a result row saying: Cash drawer installed.

begin;

-- Safety check: the drawer reads the returns table, so Returns must be installed first.
do $$
begin
  if to_regclass('public.returns') is null then
    raise exception 'Please run update-returns.sql first, then run this file again.';
  end if;
end $$;

-- CASH DRAWER SHIFTS --------------------------------------------------------------------
-- One shared till. A shift starts with the cash counted into the drawer and ends with the cash counted out.
-- It does NOT change how selling works: you can sell with or without an open shift. The shift only adds up the cash
-- that came in and went out between "open" and "close" so the count at the end can be compared with what it should be.
create sequence if not exists public.shift_seq;

create table if not exists public.shifts (
  id            uuid primary key default gen_random_uuid(),
  shift_number  text not null unique,
  opened_by     uuid not null references public.profiles (id),
  opened_at     timestamptz not null default now(),
  opening_cash  numeric(14,2) not null check (opening_cash >= 0 and opening_cash < 1000000000000),
  open_note     text,
  closed_by     uuid references public.profiles (id),
  closed_at     timestamptz,
  expected_cash numeric(14,2),            -- saved when the shift is closed, never recalculated afterwards
  counted_cash  numeric(14,2) check (counted_cash is null or counted_cash >= 0),
  difference    numeric(14,2),            -- counted - expected: negative = short, positive = over
  close_note    text,
  summary       jsonb,                    -- the full breakdown at the moment of closing
  created_at    timestamptz not null default now(),
  check ((closed_at is null) = (counted_cash is null))
);
-- only one shift can be open at a time (one shared drawer)
create unique index if not exists shifts_one_open on public.shifts ((true)) where closed_at is null;
create index if not exists shifts_opened_idx on public.shifts (opened_at desc);

create table if not exists public.cash_movements (
  id          uuid primary key default gen_random_uuid(),
  shift_id    uuid not null references public.shifts (id),
  kind        text not null check (kind in ('in', 'out')),
  amount      numeric(14,2) not null check (amount > 0 and amount < 1000000000000),
  reason      text not null check (char_length(trim(reason)) > 0),
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now()
);
create index if not exists cash_movements_shift_idx on public.cash_movements (shift_id, created_at);

-- shifts: owner, manager and accountant read all; a cashier reads the shifts they opened or closed. Only the functions write.
alter table public.shifts         enable row level security;
alter table public.cash_movements enable row level security;
drop policy if exists "read shifts" on public.shifts;
create policy "read shifts" on public.shifts for select to authenticated
  using (private.has_role('owner', 'manager', 'accountant')
         or (private.is_member() and (opened_by = (select auth.uid()) or closed_by = (select auth.uid()))));
drop policy if exists "read cash movements" on public.cash_movements;
create policy "read cash movements" on public.cash_movements for select to authenticated
  using (private.has_role('owner', 'manager', 'accountant')
         or exists (select 1 from public.shifts sh where sh.id = shift_id and private.is_member()
                    and (sh.opened_by = (select auth.uid()) or sh.closed_by = (select auth.uid()))));
revoke all on public.shifts, public.cash_movements from anon;
revoke all on public.shifts, public.cash_movements from authenticated;
grant select on public.shifts, public.cash_movements to authenticated;

-- Which payment methods count as cash in the drawer: the ones with "cash" in their name (the same rule the Sell screen uses).
create or replace function private.is_cash_method(p_name text)
returns boolean
language sql
immutable
as $$ select coalesce(p_name, '') ~* 'cash' $$;

-- shift_figures: what the drawer should hold, worked out from the payments, refunds and cash in/out of the shift's time window.
--   expected cash = opening cash + cash received - cash refunded + cash in - cash out
-- Cash received counts every cash payment in the window (even for a sale that was voided later: the money did come in;
-- if it was handed back, record it as "cash out"). The dashboard works differently on purpose: it is about sales, not the drawer.
create or replace function private.shift_figures(p_shift_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sh        public.shifts%rowtype;
  v_end     timestamptz;
  v_cash    numeric;
  v_other   jsonb;
  v_ref     numeric;
  v_ref_oth numeric;
  v_in      numeric;
  v_out     numeric;
  v_void    numeric;
  v_sales   integer;
  v_rets    integer;
begin
  select * into sh from public.shifts where id = p_shift_id;
  if not found then
    raise exception 'Shift not found.';
  end if;
  v_end := coalesce(sh.closed_at, now());

  select coalesce(sum(pm.amount) filter (where private.is_cash_method(m.name)), 0),
         coalesce(sum(pm.amount) filter (where private.is_cash_method(m.name) and s.status = 'voided'), 0),
         count(distinct pm.sale_id)
    into v_cash, v_void, v_sales
    from public.payments pm
    join public.sales s on s.id = pm.sale_id
    left join public.payment_methods m on m.id = pm.method_id
   where pm.paid_at >= sh.opened_at and pm.paid_at <= v_end;

  select coalesce(jsonb_agg(jsonb_build_object('method', x.name, 'amount', x.amount) order by x.name), '[]'::jsonb) into v_other
    from (select coalesce(m.name, 'Unknown') as name, sum(pm.amount) as amount
            from public.payments pm
            left join public.payment_methods m on m.id = pm.method_id
           where pm.paid_at >= sh.opened_at and pm.paid_at <= v_end and not private.is_cash_method(m.name)
           group by coalesce(m.name, 'Unknown')) x;

  select coalesce(sum(r.refund_amount) filter (where private.is_cash_method(m.name)), 0),
         coalesce(sum(r.refund_amount) filter (where not private.is_cash_method(m.name)), 0),
         count(*)
    into v_ref, v_ref_oth, v_rets
    from public.returns r left join public.payment_methods m on m.id = r.refund_method_id
   where r.occurred_at >= sh.opened_at and r.occurred_at <= v_end;

  select coalesce(sum(amount) filter (where kind = 'in'), 0), coalesce(sum(amount) filter (where kind = 'out'), 0)
    into v_in, v_out from public.cash_movements where shift_id = p_shift_id;

  return jsonb_build_object(
    'opening_cash', sh.opening_cash, 'cash_received', v_cash, 'cash_refunded', v_ref, 'cash_in', v_in, 'cash_out', v_out,
    'expected_cash', sh.opening_cash + v_cash - v_ref + v_in - v_out,
    'other_methods', v_other, 'other_refunded', v_ref_oth,
    'sales_paid', v_sales, 'returns', v_rets, 'voided_cash', v_void);
end
$$;

-- current_shift: the open shift (or null) with its live figures and cash in/out list. Anyone on the team can ask.
create or replace function public.current_shift()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sh public.shifts%rowtype;
begin
  if not private.is_member() then
    raise exception 'You are not allowed to see the cash drawer.';
  end if;
  select * into sh from public.shifts where closed_at is null;
  if not found then
    return null;
  end if;
  return jsonb_build_object('shift', to_jsonb(sh), 'figures', private.shift_figures(sh.id),
    'opened_by_name', (select name from public.profiles where id = sh.opened_by),
    'movements', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]'::jsonb) from public.cash_movements c where c.shift_id = sh.id));
end
$$;

-- get_shift: one shift with its breakdown (live when open, the saved one when closed) and its cash in/out.
create or replace function public.get_shift(p_shift_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sh public.shifts%rowtype;
begin
  select * into sh from public.shifts where id = p_shift_id;
  if not found then
    raise exception 'Shift not found.';
  end if;
  if not coalesce(private.has_role('owner', 'manager', 'accountant') or (private.is_member() and (sh.opened_by = auth.uid() or sh.closed_by = auth.uid())), false) then
    raise exception 'You are not allowed to see this shift.';
  end if;
  return jsonb_build_object('shift', to_jsonb(sh),
    'figures', case when sh.closed_at is null then private.shift_figures(sh.id) else sh.summary end,
    'opened_by_name', (select name from public.profiles where id = sh.opened_by),
    'closed_by_name', (select name from public.profiles where id = sh.closed_by),
    'movements', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]'::jsonb) from public.cash_movements c where c.shift_id = sh.id));
end
$$;

-- open_shift: start counting. p_shift {"id"?: uuid, "opening_cash": number, "note"?: text}. Sending the same id twice is safe.
create or replace function public.open_shift(p_shift jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_id    uuid;
  v_cash  numeric(14,2);
  v_exist public.shifts%rowtype;
  v_open  public.shifts%rowtype;
  v_num   text;
begin
  if v_uid is null or not private.has_role('owner', 'manager', 'cashier') then
    raise exception 'You are not allowed to open a cash drawer shift.';
  end if;
  v_id := coalesce(nullif(p_shift ->> 'id', '')::uuid, gen_random_uuid());
  select * into v_exist from public.shifts where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'shift_id', v_exist.id, 'shift_number', v_exist.shift_number);
  end if;
  v_cash := round((p_shift ->> 'opening_cash')::numeric, 2);
  if v_cash is null or v_cash = 'NaN'::numeric or v_cash < 0 or v_cash >= 1000000000000 then
    raise exception 'Enter the cash counted into the drawer (0 or more).';
  end if;
  -- one drawer: serialise openers so two devices cannot both open
  perform pg_advisory_xact_lock(hashtext('cash-drawer-shift'));
  select * into v_open from public.shifts where closed_at is null;
  if found then
    raise exception 'A shift is already open (%). Close it first.', v_open.shift_number;
  end if;
  v_num := 'SHIFT-' || lpad(nextval('public.shift_seq')::text, 5, '0');
  insert into public.shifts (id, shift_number, opened_by, opening_cash, open_note)
  values (v_id, v_num, v_uid, v_cash, nullif(trim(p_shift ->> 'note'), ''));
  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values ('open', 'shifts', v_id::text, v_uid, jsonb_build_object('shift_number', v_num, 'opening_cash', v_cash));
  return jsonb_build_object('ok', true, 'duplicate', false, 'shift_id', v_id, 'shift_number', v_num);
end
$$;

-- add_cash_movement: cash put into or taken out of the drawer during the open shift (change float, a supplier paid in cash...).
--   p_move {"id"?: uuid, "kind": "in"|"out", "amount": number, "reason": text}
create or replace function public.add_cash_movement(p_move jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_id    uuid;
  v_kind  text;
  v_amt   numeric(14,2);
  v_why   text;
  sh      public.shifts%rowtype;
  v_exist public.cash_movements%rowtype;
begin
  if v_uid is null or not private.has_role('owner', 'manager', 'cashier') then
    raise exception 'You are not allowed to move cash in the drawer.';
  end if;
  v_id := coalesce(nullif(p_move ->> 'id', '')::uuid, gen_random_uuid());
  select * into v_exist from public.cash_movements where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  v_kind := p_move ->> 'kind';
  v_amt  := round((p_move ->> 'amount')::numeric, 2);
  v_why  := trim(coalesce(p_move ->> 'reason', ''));
  if v_kind not in ('in', 'out') then
    raise exception 'Choose cash in or cash out.';
  end if;
  if v_amt is null or v_amt = 'NaN'::numeric or v_amt <= 0 or v_amt >= 1000000000000 then
    raise exception 'The amount must be above zero.';
  end if;
  if v_why = '' then
    raise exception 'Please write what the cash was for.';
  end if;
  select * into sh from public.shifts where closed_at is null for update;
  if not found then
    raise exception 'There is no open shift. Open one first.';
  end if;
  insert into public.cash_movements (id, shift_id, kind, amount, reason, created_by) values (v_id, sh.id, v_kind, v_amt, v_why, v_uid);
  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values ('cash_' || v_kind, 'shifts', sh.id::text, v_uid, jsonb_build_object('shift_number', sh.shift_number, 'amount', v_amt, 'reason', v_why));
  return jsonb_build_object('ok', true, 'duplicate', false, 'expected_cash', (private.shift_figures(sh.id) ->> 'expected_cash')::numeric);
end
$$;

-- close_shift: count the drawer and finish. The expected cash is worked out here and saved with the shift for good.
--   If the count is different from what was expected, a note explaining why is required.
create or replace function public.close_shift(p_shift_id uuid, p_counted numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  sh      public.shifts%rowtype;
  v_fig   jsonb;
  v_exp   numeric(14,2);
  v_cnt   numeric(14,2);
  v_diff  numeric(14,2);
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  if v_uid is null or not private.has_role('owner', 'manager', 'cashier') then
    raise exception 'You are not allowed to close the cash drawer.';
  end if;
  select * into sh from public.shifts where id = p_shift_id for update;
  if not found then
    raise exception 'Shift not found.';
  end if;
  if sh.closed_at is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'shift_id', sh.id, 'expected_cash', sh.expected_cash,
                              'counted_cash', sh.counted_cash, 'difference', sh.difference);
  end if;
  v_cnt := round(p_counted, 2);
  if v_cnt is null or v_cnt = 'NaN'::numeric or v_cnt < 0 or v_cnt >= 1000000000000 then
    raise exception 'Enter the cash you counted (0 or more).';
  end if;
  v_fig  := private.shift_figures(sh.id);
  v_exp  := (v_fig ->> 'expected_cash')::numeric;
  v_diff := v_cnt - v_exp;
  if v_diff <> 0 and v_note is null then
    raise exception 'The cash counted is % compared with what was expected. Please write a note that explains it.', case when v_diff < 0 then 'short' else 'over' end;
  end if;
  update public.shifts
     set closed_by = v_uid, closed_at = now(), expected_cash = v_exp, counted_cash = v_cnt, difference = v_diff,
         close_note = v_note, summary = v_fig || jsonb_build_object('closed_at', now())
   where id = sh.id;
  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values ('close', 'shifts', sh.id::text, v_uid,
          jsonb_build_object('shift_number', sh.shift_number, 'expected_cash', v_exp, 'counted_cash', v_cnt, 'difference', v_diff, 'note', v_note));
  return jsonb_build_object('ok', true, 'duplicate', false, 'shift_id', sh.id, 'expected_cash', v_exp, 'counted_cash', v_cnt, 'difference', v_diff);
end
$$;

revoke all on function private.is_cash_method(text)          from public, anon;
revoke all on function private.shift_figures(uuid)           from public, anon, authenticated;
revoke all on function public.current_shift()                from public, anon;
revoke all on function public.get_shift(uuid)                from public, anon;
revoke all on function public.open_shift(jsonb)              from public, anon;
revoke all on function public.add_cash_movement(jsonb)       from public, anon;
revoke all on function public.close_shift(uuid, numeric, text) from public, anon;
grant execute on function private.is_cash_method(text)       to authenticated;
grant execute on function public.current_shift()             to authenticated;
grant execute on function public.get_shift(uuid)             to authenticated;
grant execute on function public.open_shift(jsonb)           to authenticated;
grant execute on function public.add_cash_movement(jsonb)    to authenticated;
grant execute on function public.close_shift(uuid, numeric, text) to authenticated;

commit;

select 'Cash drawer installed' as result;
