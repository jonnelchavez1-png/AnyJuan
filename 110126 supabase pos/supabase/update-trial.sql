-- =====================================================================================
-- AnyJuanPOS  -  TRIAL SANDBOX  (update-trial.sql)
--
-- WHAT THIS IS FOR: a shared "try it" copy of the POS where each prospect gets a PRIVATE temporary workspace.
-- Their sales, products, expenses, drawer, stock... live in rows tagged with their workspace id. They never touch your
-- original rows (the rows whose workspace_id is empty), and they are deleted when the trial user logs out or the
-- session expires. Normal accounts (account_type = 'standard') behave EXACTLY as before.
--
-- DO NOT run this on a real client's POS. A client project only needs setup.sql.
-- HOW TO RUN: Supabase > SQL Editor > New query > paste this whole file > Run. It is safe to run twice.
-- It never deletes or changes your existing rows. It ADDS: one table, one column on profiles, one nullable
-- column on 18 tables, some helper functions, extra security rules, and it re-creates 17 functions so that they
-- only see rows of the caller's workspace (the money maths inside them is unchanged).
-- =====================================================================================

begin;

do $$
begin
  if to_regclass('public.shifts') is null or to_regclass('public.returns') is null or to_regclass('public.sale_offline') is null then
    raise exception 'Please run setup.sql (or the older update files) first, then run this file.';
  end if;
end $$;

-- 1. WHO IS A TRIAL USER, AND THEIR TEMPORARY SESSIONS --------------------------------------
alter table public.profiles add column if not exists account_type text not null default 'standard';
alter table public.profiles drop constraint if exists profiles_account_type_check;
alter table public.profiles add constraint profiles_account_type_check check (account_type in ('standard', 'trial'));

create table if not exists public.trial_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  mode            text not null default 'sample' check (mode in ('sample', 'empty')),
  business_name   text,                                   -- the name the trial user typed (the real business name is never changed)
  started_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null,                   -- moves forward while the person is active
  hard_expires_at timestamptz not null,                   -- never moves
  ended_at        timestamptz,                            -- set at logout / Start Fresh / expiry cleanup
  cleaned_at      timestamptz                             -- set when the temporary rows were deleted
);
create index if not exists trial_sessions_user_idx on public.trial_sessions (user_id, started_at desc);
alter table public.trial_sessions enable row level security;
drop policy if exists "own trial sessions" on public.trial_sessions;
create policy "own trial sessions" on public.trial_sessions for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.trial_sessions from anon, authenticated;
grant select on public.trial_sessions to authenticated;

create sequence if not exists public.trial_invoice_seq;
create sequence if not exists public.trial_return_seq;
create sequence if not exists public.trial_shift_seq;

-- 2. THE ONE PLACE THAT DECIDES "WHICH WORKSPACE IS THIS PERSON IN" ---------------------------
-- returns NULL for a normal account (= the original business rows)
-- returns the live session id for a trial account
-- returns a dead id for a trial account with no live session (so it sees and changes nothing)
create or replace function private.is_trial()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select pr.account_type = 'trial' from public.profiles pr where pr.id = (select auth.uid())), false)
$$;

create or replace function private.ws()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when pr.account_type = 'trial'
              then coalesce((select s.id from public.trial_sessions s
                              where s.user_id = pr.id and s.ended_at is null
                                and s.expires_at > now() and s.hard_expires_at > now()
                              order by s.started_at desc limit 1),
                            '00000000-0000-0000-0000-00000000dead'::uuid)
              else null end
    from public.profiles pr where pr.id = (select auth.uid())
$$;

grant execute on function private.is_trial() to authenticated;
grant execute on function private.ws() to authenticated;
revoke all on function private.is_trial() from public, anon;
revoke all on function private.ws() from public, anon;

-- invoice / return / shift numbers: trial documents have their own counters, so your real numbering never skips
create or replace function private.doc_number(p_kind text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if private.ws() is null then
    return case p_kind
      when 'INV'   then 'INV-'   || lpad(nextval('public.invoice_seq')::text, 6, '0')
      when 'RET'   then 'RET-'   || lpad(nextval('public.return_seq')::text, 6, '0')
      when 'SHIFT' then 'SHIFT-' || lpad(nextval('public.shift_seq')::text, 5, '0') end;
  end if;
  return case p_kind
    when 'INV'   then 'TRL-INV-'   || lpad(nextval('public.trial_invoice_seq')::text, 6, '0')
    when 'RET'   then 'TRL-RET-'   || lpad(nextval('public.trial_return_seq')::text, 6, '0')
    when 'SHIFT' then 'TRL-SHIFT-' || lpad(nextval('public.trial_shift_seq')::text, 5, '0') end;
end
$$;
revoke all on function private.doc_number(text) from public, anon, authenticated;

-- 3. TAG EVERY BUSINESS TABLE WITH A WORKSPACE (empty = original) -----------------------------
do $$
declare t text;
begin
  foreach t in array array['categories', 'expense_categories', 'sales_channels', 'payment_methods', 'products', 'customers',
                           'sales', 'sale_items', 'payments', 'expenses', 'inventory_movements', 'audit_logs',
                           'returns', 'return_items', 'shifts', 'cash_movements', 'sale_offline', 'sale_reviews']
  loop
    execute format('alter table public.%I add column if not exists workspace_id uuid references public.trial_sessions (id)', t);
    execute format('alter table public.%I alter column workspace_id set default private.ws()', t);
    execute format('create index if not exists %I on public.%I (workspace_id) where workspace_id is not null', t || '_ws_idx', t);
  end loop;
end $$;

-- names / numbers only have to be unique INSIDE one workspace (so a trial copy can reuse the same names)
drop index if exists public.categories_name_key;
create unique index categories_name_key on public.categories ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(name));
drop index if exists public.expense_categories_name_key;
create unique index expense_categories_name_key on public.expense_categories ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(name));
drop index if exists public.sales_channels_name_key;
create unique index sales_channels_name_key on public.sales_channels ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(name));
drop index if exists public.payment_methods_name_key;
create unique index payment_methods_name_key on public.payment_methods ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(name));
drop index if exists public.products_sku_key;
create unique index products_sku_key on public.products ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(sku)) where sku is not null and sku <> '';
drop index if exists public.products_barcode_key;
create unique index products_barcode_key on public.products ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), barcode) where barcode is not null and barcode <> '';
alter table public.sales   drop constraint if exists sales_invoice_number_key;
drop index if exists public.sales_invoice_ws_key;
create unique index sales_invoice_ws_key on public.sales ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), invoice_number);
alter table public.returns drop constraint if exists returns_return_number_key;
drop index if exists public.returns_number_ws_key;
create unique index returns_number_ws_key on public.returns ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), return_number);
alter table public.shifts  drop constraint if exists shifts_shift_number_key;
drop index if exists public.shifts_number_ws_key;
create unique index shifts_number_ws_key on public.shifts ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), shift_number);
-- one open cash drawer PER WORKSPACE
drop index if exists public.shifts_one_open;
create unique index shifts_one_open on public.shifts ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))) where closed_at is null;

-- 4. THE SAFETY NET: security rules that ALWAYS apply on top of the existing ones -------------
-- (a) the database itself refuses to read / change / delete a row of another workspace
create or replace function private.guard_workspace()
returns trigger
language plpgsql
as $$
declare
  v_row uuid;
begin
  if coalesce(current_setting('app.ws_admin', true), '') = '1' then     -- set only inside the start/clean-up functions
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    v_row := new.workspace_id;
  else
    v_row := old.workspace_id;
    if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then
      raise exception 'A record cannot be moved to another workspace.';
    end if;
  end if;
  if v_row is distinct from private.ws() then
    raise exception 'That record belongs to a different workspace.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['categories', 'expense_categories', 'sales_channels', 'payment_methods', 'products', 'customers',
                           'sales', 'sale_items', 'payments', 'expenses', 'inventory_movements', 'audit_logs',
                           'returns', 'return_items', 'shifts', 'cash_movements', 'sale_offline', 'sale_reviews']
  loop
    execute format('drop trigger if exists a_guard_workspace on public.%I', t);
    execute format('create trigger a_guard_workspace before insert or update or delete on public.%I for each row execute function private.guard_workspace()', t);
    -- (b) the read/write rule: you only see and change rows of your own workspace
    execute format('drop policy if exists workspace_scope on public.%I', t);
    execute format('create policy workspace_scope on public.%I as restrictive for all to authenticated
                    using (workspace_id is not distinct from (select private.ws()))
                    with check (workspace_id is not distinct from (select private.ws()))', t);
  end loop;
end $$;

-- trial users can look at the team page but cannot change anything about people or the real business settings
drop policy if exists trial_profiles_read on public.profiles;
create policy trial_profiles_read on public.profiles as restrictive for select to authenticated
  using (not (select private.is_trial()) or id = (select auth.uid()));
drop policy if exists trial_profiles_write on public.profiles;
create policy trial_profiles_write on public.profiles as restrictive for update to authenticated
  using (not (select private.is_trial())) with check (not (select private.is_trial()));
drop policy if exists trial_business_write on public.businesses;
create policy trial_business_write on public.businesses as restrictive for update to authenticated
  using (not (select private.is_trial())) with check (not (select private.is_trial()));

-- the audit trail stays unchangeable; the only exception is deleting a TRIAL row during clean-up
create or replace function private.audit_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and old.workspace_id is not null and coalesce(current_setting('app.ws_admin', true), '') = '1' then
    return old;
  end if;
  raise exception 'The audit trail cannot be changed.';
end
$$;

-- trial accounts never count as "the owner" when protecting the last real owner
create or replace function private.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'owner' and old.active and old.account_type = 'standard' and (new.role <> 'owner' or not new.active) then
    if not exists (select 1 from public.profiles where role = 'owner' and active and account_type = 'standard' and id <> old.id) then
      raise exception 'There must always be one active owner.';
    end if;
  end if;
  return new;
end
$$;

-- 5. FILTERED VIEWS FOR THE MONEY FUNCTIONS -----------------------------------------------------
-- schema "ws" holds one view per business table that shows ONLY the caller's workspace. The functions below read through
-- these views, so a trial user can never read or total up original rows (and the other way round).
create schema if not exists ws;
revoke all on schema ws from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['categories', 'expense_categories', 'sales_channels', 'payment_methods', 'products', 'customers',
                           'sales', 'sale_items', 'payments', 'expenses', 'inventory_movements', 'audit_logs',
                           'returns', 'return_items', 'shifts', 'cash_movements', 'sale_offline', 'sale_reviews']
  loop
    execute format('drop view if exists ws.%I', t);
    execute format('create view ws.%I as select * from public.%I where workspace_id is not distinct from (select private.ws())', t, t);
    execute format('revoke all on ws.%I from public, anon, authenticated', t);
  end loop;
end $$;


-- 6. THE MONEY FUNCTIONS, NOW WORKSPACE-AWARE ------------------------------------------------------
-- These are the same functions as in setup.sql. The ONLY changes: every table they READ is now read through the
-- filtered 'ws' view (same columns), and new invoice / return / shift numbers come from private.doc_number().
-- For a normal account the filter matches exactly the rows that existed before, so results are identical.

create or replace function public.create_sale(p_sale jsonb, p_items jsonb, p_payments jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_biz       public.businesses%rowtype;
  v_id        uuid;
  v_exist     public.sales%rowtype;
  v_invoice   text;
  v_occurred  timestamptz;
  v_rate      numeric := 0;
  v_mode      text := 'none';
  v_dtype     text;
  v_dval      numeric;
  v_subtotal  numeric(14,2);
  v_discount  numeric(14,2) := 0;
  v_rem       integer;
  v_expected  integer;
  v_window    interval;
  v_found     integer;
  v_bad       text;
  v_tax       numeric(14,2);
  v_total     numeric(14,2);
  v_cogs      numeric(14,2);
  v_paid      numeric(14,2);
  v_after     numeric(12,3);
  v_before    numeric(12,3);
  v_off       boolean;                 -- true when the sale was made on a device with no internet and is being uploaded now
  v_flags     jsonb := '{}'::jsonb;    -- things for the owner to check (offline sales only): kind -> note
  v_cmode     text;
  v_crate     numeric;
  r           record;
begin
  if v_uid is null or not private.has_role('owner', 'manager', 'cashier') then
    raise exception 'You are not allowed to record sales.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item.';
  end if;
  p_payments := coalesce(p_payments, '[]'::jsonb);
  if jsonb_typeof(p_payments) is distinct from 'array' then
    raise exception 'Payments must be a list.';
  end if;

  v_id := coalesce(nullif(p_sale ->> 'id', '')::uuid, gen_random_uuid());
  select * into v_exist from ws.sales where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'sale_id', v_exist.id,
                              'invoice_number', v_exist.invoice_number, 'total', v_exist.total);
  end if;

  select * into v_biz from public.businesses limit 1;
  v_off := coalesce(p_sale ->> 'offline', '') = 'true';
  if v_biz.tax_enabled and v_biz.tax_rate > 0 then
    v_mode := v_biz.tax_mode;
    v_rate := v_biz.tax_rate;
  end if;
  -- an offline sale keeps the tax the customer was shown at the time; if it differs from today's setting, it is flagged
  if v_off and nullif(p_sale ->> 'tax_mode', '') is not null then
    v_cmode := p_sale ->> 'tax_mode';
    v_crate := coalesce(nullif(p_sale ->> 'tax_rate', '')::numeric, 0);
    if v_cmode not in ('none', 'inclusive', 'exclusive') or v_crate < 0 or v_crate > 100 then
      raise exception 'The tax saved with this offline sale is not valid.';
    end if;
    if v_cmode = 'none' or v_crate = 0 then v_cmode := 'none'; v_crate := 0; end if;
    if v_cmode is distinct from v_mode or v_crate is distinct from v_rate then
      v_flags := v_flags || jsonb_build_object('tax',
        format('Tax at the time of sale was %s %s%%, the current setting is %s %s%%.', v_cmode, v_crate, v_mode, v_rate));
    end if;
    v_mode := v_cmode;
    v_rate := v_crate;
  end if;

  v_occurred := least(coalesce(nullif(p_sale ->> 'occurred_at', '')::timestamptz, now()), now());
  -- a sale cannot be back-dated far: cashiers 3 days (enough for a short offline spell), owner/manager 1 year
  v_window := case when v_off then interval '35 days'
                   when private.has_role('owner', 'manager') then interval '366 days' else interval '3 days' end;
  if v_occurred < now() - v_window then
    raise exception 'The sale date is too far in the past.';
  end if;
  if v_off and v_occurred < now() - interval '3 days' and not private.has_role('owner', 'manager') then
    v_flags := v_flags || jsonb_build_object('old', 'This sale was made more than 3 days before it was uploaded.');
  end if;
  -- invoice numbers are always made by the server (a device cannot choose or pre-claim one)
  v_invoice  := private.doc_number('INV');

  -- the sale row first (zeros for now): if two devices send the same id at once, only one gets past here
  insert into public.sales (id, invoice_number, channel_id, customer_id, cashier_id, status,
                            tax_mode, tax_name, tax_rate, note, occurred_at)
  values (v_id, v_invoice, nullif(p_sale ->> 'channel_id', '')::uuid, nullif(p_sale ->> 'customer_id', '')::uuid,
          v_uid, 'completed', v_mode,
          case when v_mode = 'none' then null else v_biz.tax_name end, v_rate,
          nullif(trim(p_sale ->> 'note'), ''), v_occurred)
  on conflict (id) do nothing;
  if not found then
    select * into v_exist from ws.sales where id = v_id;
    return jsonb_build_object('ok', true, 'duplicate', true, 'sale_id', v_exist.id,
                              'invoice_number', v_exist.invoice_number, 'total', v_exist.total);
  end if;

  if exists (select 1 from jsonb_array_elements(p_items) as i
              where nullif(i ->> 'product_id', '') is null
                 or nullif(i ->> 'quantity', '') is null
                 or not ((i ->> 'quantity')::numeric > 0 and (i ->> 'quantity')::numeric < 1000000000)
                 or round((i ->> 'quantity')::numeric, 3) <> (i ->> 'quantity')::numeric) then
    raise exception 'Every item needs a product and a quantity above zero (at most 3 decimals).';
  end if;

  -- lines: the same product twice is merged; the price and cost come from the products table, not the app
  -- (an offline sale uses the price the customer was shown; any difference from today's price is flagged below)
  insert into public.sale_items (sale_id, line_no, product_id, name, quantity, unit_price, unit_cost, line_gross)
  select v_id,
         row_number() over (order by x.first_pos),
         p.id, p.name, x.qty,
         case when v_off and x.cprice is not null and x.cprice >= 0 and x.cprice < 1000000000000 then round(x.cprice, 2) else p.price end,
         p.cost_price,
         round(x.qty * case when v_off and x.cprice is not null and x.cprice >= 0 and x.cprice < 1000000000000 then round(x.cprice, 2) else p.price end, 2)
  from (select (t.item ->> 'product_id')::uuid        as product_id,
               sum((t.item ->> 'quantity')::numeric)  as qty,
               min(t.pos)                             as first_pos,
               (array_agg(nullif(t.item ->> 'unit_price', '')::numeric order by t.pos))[1] as cprice
        from jsonb_array_elements(p_items) with ordinality as t(item, pos)
        group by 1) x
  join ws.products p on p.id = x.product_id and (p.active or v_off);
  get diagnostics v_found = row_count;

  select count(distinct (item ->> 'product_id')::uuid) into v_expected from jsonb_array_elements(p_items) as item;
  if v_found <> v_expected then
    raise exception 'One of the products is missing or switched off.';
  end if;

  -- lock the products (in a fixed order, so two cashiers cannot deadlock) and check stock
  perform 1 from ws.products
   where id in (select product_id from ws.sale_items where sale_id = v_id)
   order by id
   for update;
  select si.name into v_bad
    from ws.sale_items si join ws.products p on p.id = si.product_id
   where si.sale_id = v_id and p.track_stock and p.quantity < si.quantity
   limit 1;
  if v_bad is not null and not v_off then
    raise exception 'Not enough stock for %', v_bad;
  end if;
  if v_off then
    -- the customer already walked away with the goods: record the sale, take stock down to zero, and flag it for a recount
    select string_agg(format('%s: sold %s, only %s was in the system', si.name, si.quantity, p.quantity), '; ' order by si.line_no)
      into v_bad
      from ws.sale_items si join ws.products p on p.id = si.product_id
     where si.sale_id = v_id and p.track_stock and p.quantity < si.quantity;
    if v_bad is not null then
      v_flags := v_flags || jsonb_build_object('stock', v_bad || '. Stock was set to 0: please recount.');
    end if;
    select string_agg(format('%s: sold at %s, price now %s', si.name, si.unit_price, p.price), '; ' order by si.line_no)
      into v_bad
      from ws.sale_items si join ws.products p on p.id = si.product_id
     where si.sale_id = v_id and si.unit_price <> p.price;
    if v_bad is not null then
      v_flags := v_flags || jsonb_build_object('price', v_bad);
    end if;
    if exists (select 1 from ws.sale_items si join ws.products p on p.id = si.product_id where si.sale_id = v_id and not p.active) then
      v_flags := v_flags || jsonb_build_object('inactive', 'A product on this sale was switched off before the sale was uploaded.');
    end if;
  end if;

  -- discount
  select coalesce(sum(line_gross), 0) into v_subtotal from ws.sale_items where sale_id = v_id;
  v_dtype := nullif(p_sale ->> 'discount_type', '');
  v_dval  := coalesce(nullif(p_sale ->> 'discount_value', '')::numeric, 0);
  if v_dtype is not null then
    if v_dval < 0 then
      raise exception 'A discount cannot be negative.';
    elsif v_dtype = 'percent' then
      if v_dval > 100 then
        raise exception 'A discount cannot be more than 100 percent.';
      end if;
      v_discount := round(v_subtotal * v_dval / 100, 2);
    elsif v_dtype = 'amount' then
      v_discount := least(round(v_dval, 2), v_subtotal);
    else
      raise exception 'Unknown discount type.';
    end if;
  end if;

  if v_discount > 0 and not private.has_role('owner', 'manager')
     and v_discount > round(v_subtotal * v_biz.cashier_max_discount_pct / 100, 2) then
    if not v_off then
      raise exception 'This discount needs a manager (cashiers may give up to % percent).', v_biz.cashier_max_discount_pct;
    end if;
    v_flags := v_flags || jsonb_build_object('discount',
      format('The discount of %s is more than a cashier may give (%s%%).', v_discount, v_biz.cashier_max_discount_pct));
  end if;

  -- share the discount over the lines to the cent: round each share down, then give the leftover
  -- cents to the lines that lost the most (ties go to the earlier line)
  if v_discount > 0 then
    update public.sale_items si
       set discount_amount = floor(v_discount * si.line_gross / v_subtotal * 100) / 100
     where si.sale_id = v_id;
    select round((v_discount - coalesce(sum(discount_amount), 0)) * 100)::integer into v_rem
      from ws.sale_items where sale_id = v_id;
    if v_rem > 0 then
      update public.sale_items si
         set discount_amount = si.discount_amount + 0.01
       where si.id in (
         select s2.id from ws.sale_items s2
          where s2.sale_id = v_id
          order by (v_discount * s2.line_gross / v_subtotal * 100) - floor(v_discount * s2.line_gross / v_subtotal * 100) desc,
                   s2.line_no
          limit v_rem);
    end if;
  end if;

  -- tax (only when the owner switched it on and the rate is above zero)
  if v_mode = 'inclusive' then
    -- prices already contain tax: tax = amount x rate / (100 + rate); the customer pays the amount
    update public.sale_items si
       set tax_amount = case when p.tax_exempt then 0
                             else round((si.line_gross - si.discount_amount) * v_rate / (100 + v_rate), 2) end,
           line_total = si.line_gross - si.discount_amount
      from ws.products p
     where si.sale_id = v_id and p.id = si.product_id;
  elsif v_mode = 'exclusive' then
    -- prices are before tax: tax = amount x rate / 100, added on top
    update public.sale_items si
       set tax_amount = case when p.tax_exempt then 0
                             else round((si.line_gross - si.discount_amount) * v_rate / 100, 2) end
      from ws.products p
     where si.sale_id = v_id and p.id = si.product_id;
    update public.sale_items
       set line_total = line_gross - discount_amount + tax_amount
     where sale_id = v_id;
  else
    update public.sale_items
       set tax_amount = 0, line_total = line_gross - discount_amount
     where sale_id = v_id;
  end if;

  select coalesce(sum(tax_amount), 0), coalesce(sum(line_total), 0), coalesce(sum(round(quantity * unit_cost, 2)), 0)
    into v_tax, v_total, v_cogs
    from ws.sale_items where sale_id = v_id;

  -- payments (can be less than the total: the rest is "unpaid" and shows as a receivable)
  if exists (select 1 from jsonb_array_elements(p_payments) x
              where not (coalesce((x ->> 'amount')::numeric, 0) >= 0.01 and (x ->> 'amount')::numeric < 1000000000000)
                 or nullif(x ->> 'method_id', '') is null) then
    raise exception 'Every payment needs a method and an amount above zero.';
  end if;
  select coalesce(sum(round((x ->> 'amount')::numeric, 2)), 0) into v_paid from jsonb_array_elements(p_payments) x;
  if v_paid > v_total then
    raise exception 'Payments are more than the total.';
  end if;

  update public.sales
     set subtotal = v_subtotal, discount_amount = v_discount, tax_amount = v_tax,
         total = v_total, net_sales = v_total - v_tax, cogs = v_cogs
   where id = v_id;

  insert into public.payments (id, sale_id, method_id, amount, paid_at, received_by)
  select coalesce(nullif(x ->> 'id', '')::uuid, gen_random_uuid()), v_id, (x ->> 'method_id')::uuid,
         round((x ->> 'amount')::numeric, 2), v_occurred, v_uid
    from jsonb_array_elements(p_payments) x;

  -- stock
  perform set_config('app.stock_rpc', '1', true);
  for r in
    select si.product_id, si.quantity
      from ws.sale_items si join ws.products p on p.id = si.product_id
     where si.sale_id = v_id and p.track_stock
     order by si.line_no
  loop
    select quantity into v_before from ws.products where id = r.product_id;
    update public.products set quantity = case when v_off then greatest(quantity - r.quantity, 0) else quantity - r.quantity end
     where id = r.product_id
    returning quantity into v_after;
    insert into public.inventory_movements (product_id, type, quantity_change, quantity_after, reference_id, actor_id)
    values (r.product_id, 'sale', v_after - v_before, v_after, v_id, v_uid);
  end loop;
  perform set_config('app.stock_rpc', '', true);

  if v_off then
    insert into public.sale_offline (sale_id, client_time, uploaded_by) values (v_id, v_occurred, v_uid);
    insert into public.sale_reviews (sale_id, kind, note)
    select v_id, f.key, f.value #>> '{}' from jsonb_each(v_flags) f;
    return jsonb_build_object('ok', true, 'duplicate', false, 'sale_id', v_id, 'invoice_number', v_invoice,
                              'total', v_total, 'tax_amount', v_tax, 'flagged', (select count(*) from jsonb_object_keys(v_flags)));
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'sale_id', v_id, 'invoice_number', v_invoice,
                            'total', v_total, 'tax_amount', v_tax);
end
$$;

create or replace function public.void_sale(p_sale_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_sale  public.sales%rowtype;
  v_after numeric(12,3);
  r       record;
begin
  if v_uid is null or not private.has_role('owner', 'manager') then
    raise exception 'Only the owner or a manager can void a sale.';
  end if;
  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'Please give a reason.';
  end if;

  select * into v_sale from ws.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'sale_id', v_sale.id);
  end if;
  if exists (select 1 from ws.returns where sale_id = p_sale_id) then
    raise exception 'This sale already has a return, so it cannot be voided. Return the remaining items instead.';
  end if;

  update public.sales
     set status = 'voided', voided_at = now(), voided_by = v_uid, void_reason = trim(p_reason)
   where id = p_sale_id;

  perform set_config('app.stock_rpc', '1', true);
  for r in
    select im.product_id, -im.quantity_change as quantity
      from ws.inventory_movements im
     where im.reference_id = p_sale_id and im.type = 'sale'
     order by im.product_id
  loop
    update public.products set quantity = quantity + r.quantity where id = r.product_id
    returning quantity into v_after;
    insert into public.inventory_movements (product_id, type, quantity_change, quantity_after, reference_id, note, actor_id)
    values (r.product_id, 'void', r.quantity, v_after, p_sale_id, trim(p_reason), v_uid);
  end loop;
  perform set_config('app.stock_rpc', '', true);

  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values ('void', 'sales', p_sale_id::text, v_uid,
          jsonb_build_object('invoice_number', v_sale.invoice_number, 'total', v_sale.total, 'reason', trim(p_reason)));

  return jsonb_build_object('ok', true, 'duplicate', false, 'sale_id', p_sale_id);
end
$$;

create or replace function public.record_payment(p_payment_id uuid, p_sale_id uuid, p_method_id uuid, p_amount numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_sale  public.sales%rowtype;
  v_paid  numeric(14,2);
  v_owed  numeric(14,2);
  v_amt   numeric(14,2);
begin
  if v_uid is null or not private.has_role('owner', 'manager', 'cashier') then
    raise exception 'You are not allowed to record payments.';
  end if;
  v_amt := round(coalesce(p_amount, 0), 2);
  if not (v_amt >= 0.01 and v_amt < 1000000000000) then
    raise exception 'The amount must be above zero.';
  end if;
  if p_method_id is null then
    raise exception 'Choose how the customer paid.';
  end if;

  select * into v_sale from ws.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  -- checked AFTER the lock, so two devices sending the same payment id cannot both get through
  if p_payment_id is not null and exists (select 1 from ws.payments where id = p_payment_id) then
    if exists (select 1 from ws.payments where id = p_payment_id and sale_id = p_sale_id) then
      return jsonb_build_object('ok', true, 'duplicate', true);
    end if;
    raise exception 'That payment id was already used for another sale.';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'This sale was voided.';
  end if;
  -- what is still owed = total - returned items - (received - refunded)
  select coalesce(sum(amount), 0) into v_paid from ws.payments where sale_id = p_sale_id;
  v_owed := v_sale.total - (select coalesce(sum(total), 0) from ws.returns where sale_id = p_sale_id)
            - (v_paid - (select coalesce(sum(refund_amount), 0) from ws.returns where sale_id = p_sale_id));
  if v_amt > v_owed then
    raise exception 'That is more than the balance (%).', v_owed;
  end if;

  insert into public.payments (id, sale_id, method_id, amount, paid_at, received_by, note)
  values (coalesce(p_payment_id, gen_random_uuid()), p_sale_id, p_method_id, v_amt, now(), v_uid, nullif(trim(p_note), ''));

  return jsonb_build_object('ok', true, 'duplicate', false, 'balance', v_owed - v_amt);
end
$$;

create or replace function private.plan_return(p_sale_id uuid, p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sale     public.sales%rowtype;
  v_lines    jsonb := '[]'::jsonb;
  v_seen     uuid[] := '{}';
  v_item     jsonb;
  v_si       public.sale_items%rowtype;
  v_line_id  uuid;
  v_q        numeric;
  v_restock  boolean;
  pr         record;
  v_remaining numeric;
  v_gross    numeric;
  v_disc     numeric;
  v_tax      numeric;
  v_total    numeric;
  v_basis    numeric;
  v_cogs     numeric;
  v_line_cogs numeric;
  t_sub      numeric := 0;
  t_disc     numeric := 0;
  t_tax      numeric := 0;
  t_total    numeric := 0;
  t_cogs     numeric := 0;
  v_paid     numeric;
  v_returned numeric;
  v_refunded numeric;
  v_owed     numeric;
begin
  select * into v_sale from ws.sales where id = p_sale_id;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one item to return.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line_id := nullif(v_item ->> 'sale_item_id', '')::uuid;
    if v_line_id is null or v_line_id = any (v_seen) then
      raise exception 'Each item can only be listed once.';
    end if;
    v_seen := v_seen || v_line_id;
    select * into v_si from ws.sale_items where id = v_line_id and sale_id = p_sale_id;
    if not found then
      raise exception 'That item is not part of this sale.';
    end if;
    v_q := (v_item ->> 'quantity')::numeric;
    if v_q is null or v_q = 'NaN'::numeric or v_q <= 0 or v_q <> round(v_q, 3) then
      raise exception 'The quantity to return for "%" is not valid.', v_si.name;
    end if;
    v_restock := coalesce((v_item ->> 'restock')::boolean, true);

    select coalesce(sum(quantity), 0) as q, coalesce(sum(gross), 0) as gross, coalesce(sum(discount_amount), 0) as disc,
           coalesce(sum(tax_amount), 0) as tax, coalesce(sum(total), 0) as total, coalesce(sum(cogs_basis), 0) as basis
      into pr from ws.return_items where sale_item_id = v_si.id;
    v_remaining := v_si.quantity - pr.q;
    if v_q > v_remaining then
      raise exception 'You can return at most % of "%" (the rest was already returned).', v_remaining, v_si.name;
    end if;

    v_line_cogs := round(v_si.quantity * v_si.unit_cost, 2);
    if v_q = v_remaining then
      v_gross := v_si.line_gross - pr.gross;
      v_disc  := v_si.discount_amount - pr.disc;
      v_tax   := v_si.tax_amount - pr.tax;
      v_total := v_si.line_total - pr.total;
      v_basis := v_line_cogs - pr.basis;
    else
      v_gross := least(round(v_si.line_gross * v_q / v_si.quantity, 2), v_si.line_gross - pr.gross);
      v_disc  := least(round(v_si.discount_amount * v_q / v_si.quantity, 2), v_si.discount_amount - pr.disc);
      v_tax   := least(round(v_si.tax_amount * v_q / v_si.quantity, 2), v_si.tax_amount - pr.tax);
      v_total := case when v_sale.tax_mode = 'exclusive' then v_gross - v_disc + v_tax else v_gross - v_disc end;
      v_total := least(v_total, v_si.line_total - pr.total);
      v_basis := least(round(v_line_cogs * v_q / v_si.quantity, 2), v_line_cogs - pr.basis);
    end if;
    v_cogs := case when v_restock then v_basis else 0 end;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_si.id, 'product_id', v_si.product_id, 'name', v_si.name, 'quantity', v_q,
      'gross', v_gross, 'discount_amount', v_disc, 'tax_amount', v_tax, 'total', v_total,
      'cogs_basis', v_basis, 'cogs', v_cogs, 'restocked', v_restock));
    t_sub := t_sub + v_gross; t_disc := t_disc + v_disc; t_tax := t_tax + v_tax; t_total := t_total + v_total; t_cogs := t_cogs + v_cogs;
  end loop;

  -- how much money goes back: only what the customer has paid beyond what they now owe
  select coalesce(sum(amount), 0) into v_paid from ws.payments where sale_id = p_sale_id;
  select coalesce(sum(total), 0), coalesce(sum(refund_amount), 0) into v_returned, v_refunded from ws.returns where sale_id = p_sale_id;
  v_owed := v_sale.total - (v_returned + t_total) - (v_paid - v_refunded);

  return jsonb_build_object('lines', v_lines, 'subtotal', t_sub, 'discount_amount', t_disc, 'tax_amount', t_tax,
    'total', t_total, 'net_amount', t_total - t_tax, 'cogs', t_cogs,
    'refund_amount', greatest(-v_owed, 0), 'balance_after', greatest(v_owed, 0));
end
$$;

create or replace function public.create_return(p_return jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_id     uuid;
  v_sale   public.sales%rowtype;
  v_exist  public.returns%rowtype;
  v_plan   jsonb;
  v_reason text;
  v_method uuid;
  v_refund numeric(14,2);
  v_number text;
  v_after  numeric(12,3);
  v_track  boolean;
  l        jsonb;
begin
  if v_uid is null or not private.has_role('owner', 'manager') then
    raise exception 'Only the owner or a manager can process a return.';
  end if;
  v_reason := trim(coalesce(p_return ->> 'reason', ''));
  if v_reason = '' then
    raise exception 'Please give a reason for the return.';
  end if;
  v_id := coalesce(nullif(p_return ->> 'id', '')::uuid, gen_random_uuid());
  select * into v_exist from ws.returns where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'return_id', v_exist.id, 'return_number', v_exist.return_number,
                              'total', v_exist.total, 'refund_amount', v_exist.refund_amount);
  end if;

  select * into v_sale from ws.sales where id = nullif(p_return ->> 'sale_id', '')::uuid for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'This sale was voided, so nothing can be returned.';
  end if;
  select * into v_exist from ws.returns where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'return_id', v_exist.id, 'return_number', v_exist.return_number,
                              'total', v_exist.total, 'refund_amount', v_exist.refund_amount);
  end if;

  v_plan   := private.plan_return(v_sale.id, p_items);
  v_refund := (v_plan ->> 'refund_amount')::numeric;
  v_method := nullif(p_return ->> 'refund_method_id', '')::uuid;
  if v_refund > 0 and v_method is null then
    raise exception 'Choose how the money is given back.';
  end if;
  if v_refund = 0 then v_method := null; end if;
  v_number := private.doc_number('RET');

  insert into public.returns (id, return_number, invoice_number, sale_id, processed_by, reason, subtotal, discount_amount, tax_amount, total,
                              net_amount, cogs, refund_amount, refund_method_id)
  values (v_id, v_number, v_sale.invoice_number, v_sale.id, v_uid, v_reason, (v_plan ->> 'subtotal')::numeric, (v_plan ->> 'discount_amount')::numeric,
          (v_plan ->> 'tax_amount')::numeric, (v_plan ->> 'total')::numeric, (v_plan ->> 'net_amount')::numeric,
          (v_plan ->> 'cogs')::numeric, v_refund, v_method);

  for l in select * from jsonb_array_elements(v_plan -> 'lines') loop
    insert into public.return_items (return_id, sale_item_id, product_id, name, quantity, gross, discount_amount, tax_amount,
                                     total, cogs_basis, cogs, restocked)
    values (v_id, (l ->> 'sale_item_id')::uuid, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'quantity')::numeric,
            (l ->> 'gross')::numeric, (l ->> 'discount_amount')::numeric, (l ->> 'tax_amount')::numeric, (l ->> 'total')::numeric,
            (l ->> 'cogs_basis')::numeric, (l ->> 'cogs')::numeric, (l ->> 'restocked')::boolean);
    if (l ->> 'restocked')::boolean then
      select track_stock into v_track from ws.products where id = (l ->> 'product_id')::uuid;
      if v_track then
        perform set_config('app.stock_rpc', '1', true);
        update public.products set quantity = quantity + (l ->> 'quantity')::numeric
         where id = (l ->> 'product_id')::uuid returning quantity into v_after;
        perform set_config('app.stock_rpc', '', true);
        insert into public.inventory_movements (product_id, type, quantity_change, quantity_after, reference_id, note, actor_id)
        values ((l ->> 'product_id')::uuid, 'return', (l ->> 'quantity')::numeric, v_after, v_id, v_reason, v_uid);
      end if;
    end if;
  end loop;

  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values ('return', 'sales', v_sale.id::text, v_uid,
          jsonb_build_object('return_number', v_number, 'invoice_number', v_sale.invoice_number, 'total', v_plan -> 'total',
                             'refund_amount', v_refund, 'reason', v_reason));

  return jsonb_build_object('ok', true, 'duplicate', false, 'return_id', v_id, 'return_number', v_number,
                            'total', (v_plan ->> 'total')::numeric, 'refund_amount', v_refund);
end
$$;

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
  select * into sh from ws.shifts where id = p_shift_id;
  if not found then
    raise exception 'Shift not found.';
  end if;
  v_end := coalesce(sh.closed_at, now());

  select coalesce(sum(pm.amount) filter (where private.is_cash_method(m.name)), 0),
         coalesce(sum(pm.amount) filter (where private.is_cash_method(m.name) and s.status = 'voided'), 0),
         count(distinct pm.sale_id)
    into v_cash, v_void, v_sales
    from ws.payments pm
    join ws.sales s on s.id = pm.sale_id
    left join ws.payment_methods m on m.id = pm.method_id
   where pm.paid_at >= sh.opened_at and pm.paid_at <= v_end;

  select coalesce(jsonb_agg(jsonb_build_object('method', x.name, 'amount', x.amount) order by x.name), '[]'::jsonb) into v_other
    from (select coalesce(m.name, 'Unknown') as name, sum(pm.amount) as amount
            from ws.payments pm
            left join ws.payment_methods m on m.id = pm.method_id
           where pm.paid_at >= sh.opened_at and pm.paid_at <= v_end and not private.is_cash_method(m.name)
           group by coalesce(m.name, 'Unknown')) x;

  select coalesce(sum(r.refund_amount) filter (where private.is_cash_method(m.name)), 0),
         coalesce(sum(r.refund_amount) filter (where not private.is_cash_method(m.name)), 0),
         count(*)
    into v_ref, v_ref_oth, v_rets
    from ws.returns r left join ws.payment_methods m on m.id = r.refund_method_id
   where r.occurred_at >= sh.opened_at and r.occurred_at <= v_end;

  select coalesce(sum(amount) filter (where kind = 'in'), 0), coalesce(sum(amount) filter (where kind = 'out'), 0)
    into v_in, v_out from ws.cash_movements where shift_id = p_shift_id;

  return jsonb_build_object(
    'opening_cash', sh.opening_cash, 'cash_received', v_cash, 'cash_refunded', v_ref, 'cash_in', v_in, 'cash_out', v_out,
    'expected_cash', sh.opening_cash + v_cash - v_ref + v_in - v_out,
    'other_methods', v_other, 'other_refunded', v_ref_oth,
    'sales_paid', v_sales, 'returns', v_rets, 'voided_cash', v_void);
end
$$;

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
  select * into sh from ws.shifts where closed_at is null;
  if not found then
    return null;
  end if;
  return jsonb_build_object('shift', to_jsonb(sh), 'figures', private.shift_figures(sh.id),
    'opened_by_name', (select name from public.profiles where id = sh.opened_by),
    'movements', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]'::jsonb) from ws.cash_movements c where c.shift_id = sh.id));
end
$$;

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
  select * into sh from ws.shifts where id = p_shift_id;
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
    'movements', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]'::jsonb) from ws.cash_movements c where c.shift_id = sh.id));
end
$$;

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
  select * into v_exist from ws.shifts where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'shift_id', v_exist.id, 'shift_number', v_exist.shift_number);
  end if;
  v_cash := round((p_shift ->> 'opening_cash')::numeric, 2);
  if v_cash is null or v_cash = 'NaN'::numeric or v_cash < 0 or v_cash >= 1000000000000 then
    raise exception 'Enter the cash counted into the drawer (0 or more).';
  end if;
  -- one drawer: serialise openers so two devices cannot both open
  perform pg_advisory_xact_lock(hashtext('cash-drawer-shift'));
  select * into v_open from ws.shifts where closed_at is null;
  if found then
    raise exception 'A shift is already open (%). Close it first.', v_open.shift_number;
  end if;
  v_num := private.doc_number('SHIFT');
  insert into public.shifts (id, shift_number, opened_by, opening_cash, open_note)
  values (v_id, v_num, v_uid, v_cash, nullif(trim(p_shift ->> 'note'), ''));
  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values ('open', 'shifts', v_id::text, v_uid, jsonb_build_object('shift_number', v_num, 'opening_cash', v_cash));
  return jsonb_build_object('ok', true, 'duplicate', false, 'shift_id', v_id, 'shift_number', v_num);
end
$$;

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
  select * into v_exist from ws.cash_movements where id = v_id;
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
  select * into sh from ws.shifts where closed_at is null for update;
  if not found then
    raise exception 'There is no open shift. Open one first.';
  end if;
  insert into public.cash_movements (id, shift_id, kind, amount, reason, created_by) values (v_id, sh.id, v_kind, v_amt, v_why, v_uid);
  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values ('cash_' || v_kind, 'shifts', sh.id::text, v_uid, jsonb_build_object('shift_number', sh.shift_number, 'amount', v_amt, 'reason', v_why));
  return jsonb_build_object('ok', true, 'duplicate', false, 'expected_cash', (private.shift_figures(sh.id) ->> 'expected_cash')::numeric);
end
$$;

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
  select * into sh from ws.shifts where id = p_shift_id for update;
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

create or replace function public.adjust_stock(p_product_id uuid, p_change numeric, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_prod  public.products%rowtype;
  v_after numeric(12,3);
begin
  if v_uid is null or not private.has_role('owner', 'manager') then
    raise exception 'Only the owner or a manager can adjust stock.';
  end if;
  if p_change is null or not (abs(p_change) >= 0.001 and abs(p_change) < 1000000000) or round(p_change, 3) <> p_change then
    raise exception 'The change must be a number other than zero (at most 3 decimals).';
  end if;

  select * into v_prod from ws.products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found.';
  end if;
  if not v_prod.track_stock then
    raise exception 'This product does not track stock.';
  end if;
  if v_prod.quantity + p_change < 0 then
    raise exception 'Stock cannot go below zero.';
  end if;

  perform set_config('app.stock_rpc', '1', true);
  update public.products set quantity = quantity + p_change where id = p_product_id
  returning quantity into v_after;
  perform set_config('app.stock_rpc', '', true);

  insert into public.inventory_movements (product_id, type, quantity_change, quantity_after, note, actor_id)
  values (p_product_id, 'adjustment', p_change, v_after, nullif(trim(p_note), ''), v_uid);

  return jsonb_build_object('ok', true, 'quantity', v_after);
end
$$;

create or replace function private.period_totals(p_start timestamptz, p_end timestamptz, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_orders    integer;
  v_units     numeric;
  v_gross     numeric;
  v_disc      numeric;
  v_tax       numeric;
  v_billed    numeric;
  v_net       numeric;
  v_cogs      numeric;
  v_collected numeric;
  v_expenses  numeric;
  r           record;
  r_units     numeric;
begin
  select count(*), coalesce(sum(subtotal), 0), coalesce(sum(discount_amount), 0), coalesce(sum(tax_amount), 0),
         coalesce(sum(total), 0), coalesce(sum(net_sales), 0), coalesce(sum(cogs), 0)
    into v_orders, v_gross, v_disc, v_tax, v_billed, v_net, v_cogs
    from ws.sales
   where status = 'completed' and occurred_at >= p_start and occurred_at < p_end;

  select coalesce(sum(si.quantity), 0) into v_units
    from ws.sale_items si join ws.sales s on s.id = si.sale_id
   where s.status = 'completed' and s.occurred_at >= p_start and s.occurred_at < p_end;

  select count(*) as cnt, coalesce(sum(subtotal), 0) as subtotal, coalesce(sum(discount_amount), 0) as disc,
         coalesce(sum(tax_amount), 0) as tax, coalesce(sum(total), 0) as total, coalesce(sum(net_amount), 0) as net,
         coalesce(sum(cogs), 0) as cogs, coalesce(sum(refund_amount), 0) as refunded
    into r from ws.returns where occurred_at >= p_start and occurred_at < p_end;

  select coalesce(sum(ri.quantity), 0) into r_units
    from ws.return_items ri join ws.returns rt on rt.id = ri.return_id
   where rt.occurred_at >= p_start and rt.occurred_at < p_end;

  select coalesce(sum(pm.amount), 0) into v_collected
    from ws.payments pm join ws.sales s on s.id = pm.sale_id
   where s.status = 'completed' and pm.paid_at >= p_start and pm.paid_at < p_end;

  select coalesce(sum(amount), 0) into v_expenses
    from ws.expenses
   where voided_at is null and expense_date between p_from and p_to;

  v_gross := v_gross - r.subtotal;  v_disc := v_disc - r.disc;  v_tax := v_tax - r.tax;
  v_billed := v_billed - r.total;   v_net := v_net - r.net;     v_cogs := v_cogs - r.cogs;
  v_collected := v_collected - r.refunded;  v_units := v_units - r_units;

  return jsonb_build_object(
    'orders', v_orders, 'units', v_units, 'gross_sales', v_gross, 'discounts', v_disc, 'tax_collected', v_tax,
    'billed', v_billed, 'net_sales', v_net, 'cogs', v_cogs, 'gross_profit', v_net - v_cogs,
    'collected', v_collected, 'expenses', v_expenses, 'net_profit', v_net - v_cogs - v_expenses,
    'returns_count', r.cnt, 'returns_total', r.total, 'refunded', r.refunded);
end
$$;

create or replace function private.dash_lines(p_start timestamptz, p_end timestamptz)
returns table (product_id uuid, name text, qty numeric, net numeric, profit numeric)
language sql
stable
security definer
set search_path = public
as $$
  select si.product_id, si.name, si.quantity, si.line_total - si.tax_amount,
         si.line_total - si.tax_amount - round(si.quantity * si.unit_cost, 2)
    from ws.sale_items si join ws.sales s on s.id = si.sale_id
   where s.status = 'completed' and s.occurred_at >= p_start and s.occurred_at < p_end
  union all
  select ri.product_id, ri.name, -ri.quantity, -(ri.total - ri.tax_amount), -(ri.total - ri.tax_amount - ri.cogs)
    from ws.return_items ri join ws.returns rt on rt.id = ri.return_id
   where rt.occurred_at >= p_start and rt.occurred_at < p_end
$$;

create or replace function public.get_dashboard(p_from date, p_to date, p_prev_from date, p_prev_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz       text;
  v_start    timestamptz;
  v_end      timestamptz;
  v_pstart   timestamptz;
  v_pend     timestamptz;
  v_series   jsonb;
  v_top_qty  jsonb;
  v_top_net  jsonb;
  v_by_cat   jsonb;
  v_by_chan  jsonb;
  v_by_pay   jsonb;
  v_exp_cat  jsonb;
  v_recv     jsonb;
  v_low      jsonb;
begin
  if not private.has_role('owner', 'manager', 'accountant') then
    raise exception 'You are not allowed to see reports.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then
    raise exception 'Choose a date range of up to two years.';
  end if;
  if p_prev_from is null or p_prev_to is null or p_prev_to < p_prev_from then
    raise exception 'The comparison range is not valid.';
  end if;

  select timezone into v_tz from public.businesses limit 1;
  v_start  := p_from::timestamp at time zone v_tz;
  v_end    := (p_to + 1)::timestamp at time zone v_tz;
  v_pstart := p_prev_from::timestamp at time zone v_tz;
  v_pend   := (p_prev_to + 1)::timestamp at time zone v_tz;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date', d.day, 'orders', coalesce(s.orders, 0),
           'net_sales', coalesce(s.net, 0) - coalesce(rt.net, 0),
           'gross_profit', (coalesce(s.net, 0) - coalesce(s.cogs, 0)) - (coalesce(rt.net, 0) - coalesce(rt.cogs, 0)),
           'expenses', coalesce(e.amount, 0))
         order by d.day), '[]'::jsonb)
    into v_series
    from (select g::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
    left join (select (occurred_at at time zone v_tz)::date as day, count(*) as orders,
                      sum(net_sales) as net, sum(cogs) as cogs
                 from ws.sales
                where status = 'completed' and occurred_at >= v_start and occurred_at < v_end
                group by 1) s on s.day = d.day
    left join (select (occurred_at at time zone v_tz)::date as day, sum(net_amount) as net, sum(cogs) as cogs
                 from ws.returns
                where occurred_at >= v_start and occurred_at < v_end
                group by 1) rt on rt.day = d.day
    left join (select expense_date as day, sum(amount) as amount
                 from ws.expenses
                where voided_at is null and expense_date between p_from and p_to
                group by 1) e on e.day = d.day;

  select coalesce(jsonb_agg(t order by t.qty desc, t.name), '[]'::jsonb) into v_top_qty
    from (select l.name, sum(l.qty) as qty, sum(l.net) as net_sales
            from private.dash_lines(v_start, v_end) l group by l.product_id, l.name
           having sum(l.qty) > 0
           order by sum(l.qty) desc, l.name limit 10) t;

  select coalesce(jsonb_agg(t order by t.net_sales desc, t.name), '[]'::jsonb) into v_top_net
    from (select l.name, sum(l.qty) as qty, sum(l.net) as net_sales, sum(l.profit) as gross_profit
            from private.dash_lines(v_start, v_end) l group by l.product_id, l.name
           having sum(l.net) > 0
           order by sum(l.net) desc, l.name limit 10) t;

  select coalesce(jsonb_agg(t order by t.net_sales desc, t.name), '[]'::jsonb) into v_by_cat
    from (select coalesce(c.name, 'No category') as name, sum(l.net) as net_sales, sum(l.profit) as gross_profit
            from private.dash_lines(v_start, v_end) l
            join ws.products p on p.id = l.product_id
            left join ws.categories c on c.id = p.category_id
           group by coalesce(c.name, 'No category')) t;

  select coalesce(jsonb_agg(t order by t.net_sales desc, t.name), '[]'::jsonb) into v_by_chan
    from (select x.name, sum(x.orders) as orders, sum(x.net) as net_sales
            from (select coalesce(ch.name, 'No channel') as name, 1 as orders, s.net_sales as net
                    from ws.sales s left join ws.sales_channels ch on ch.id = s.channel_id
                   where s.status = 'completed' and s.occurred_at >= v_start and s.occurred_at < v_end
                  union all
                  select coalesce(ch.name, 'No channel'), 0, -rt.net_amount
                    from ws.returns rt join ws.sales s on s.id = rt.sale_id
                    left join ws.sales_channels ch on ch.id = s.channel_id
                   where rt.occurred_at >= v_start and rt.occurred_at < v_end) x
           group by x.name) t;

  select coalesce(jsonb_agg(t order by t.amount desc, t.name), '[]'::jsonb) into v_by_pay
    from (select x.name, sum(x.amount) as amount
            from (select coalesce(m.name, 'Unknown') as name, pm.amount
                    from ws.payments pm
                    join ws.sales s on s.id = pm.sale_id
                    left join ws.payment_methods m on m.id = pm.method_id
                   where s.status = 'completed' and pm.paid_at >= v_start and pm.paid_at < v_end
                  union all
                  select coalesce(m.name, 'Unknown'), -rt.refund_amount
                    from ws.returns rt left join ws.payment_methods m on m.id = rt.refund_method_id
                   where rt.refund_amount > 0 and rt.occurred_at >= v_start and rt.occurred_at < v_end) x
           group by x.name) t;

  select coalesce(jsonb_agg(t order by t.amount desc, t.name), '[]'::jsonb) into v_exp_cat
    from (select coalesce(ec.name, 'No category') as name, sum(e.amount) as amount
            from ws.expenses e left join ws.expense_categories ec on ec.id = e.category_id
           where e.voided_at is null and e.expense_date between p_from and p_to
           group by coalesce(ec.name, 'No category')) t;

  -- receivables are "as of now", not "in the period"
  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(b.balance), 0)) into v_recv
    from (select s.total - coalesce(r.returned, 0) - (coalesce(p.paid, 0) - coalesce(r.refunded, 0)) as balance
            from ws.sales s
            left join (select sale_id, sum(amount) as paid from ws.payments group by sale_id) p on p.sale_id = s.id
            left join (select sale_id, sum(total) as returned, sum(refund_amount) as refunded from ws.returns group by sale_id) r on r.sale_id = s.id
           where s.status = 'completed') b
   where b.balance > 0;

  select coalesce(jsonb_agg(t order by t.quantity, t.name), '[]'::jsonb) into v_low
    from (select p.id, p.name, p.quantity, p.reorder_level
            from ws.products p
           where p.active and p.track_stock and p.reorder_level > 0 and p.quantity <= p.reorder_level
           order by p.quantity, p.name
           limit 10) t;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'prev_from', p_prev_from, 'prev_to', p_prev_to, 'timezone', v_tz),
    'current', private.period_totals(v_start, v_end, p_from, p_to),
    'previous', private.period_totals(v_pstart, v_pend, p_prev_from, p_prev_to),
    'series', v_series, 'top_by_quantity', v_top_qty, 'top_by_net_sales', v_top_net,
    'by_category', v_by_cat, 'by_channel', v_by_chan, 'by_payment_method', v_by_pay,
    'expenses_by_category', v_exp_cat, 'receivables', v_recv, 'low_stock', v_low);
end
$$;

create or replace function public.get_tax_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz     text;
  v_start  timestamptz;
  v_end    timestamptz;
  v_tot    jsonb;
  v_rates  jsonb;
  v_days   jsonb;
  v_void   jsonb;
  s        record;
  r        record;
  st       record;
  rt       record;
begin
  if not private.has_role('owner', 'manager', 'accountant') then
    raise exception 'You are not allowed to see reports.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then
    raise exception 'Choose a date range of up to two years.';
  end if;
  select timezone into v_tz from public.businesses limit 1;
  v_start := p_from::timestamp at time zone v_tz;
  v_end   := (p_to + 1)::timestamp at time zone v_tz;

  select count(*) as orders, coalesce(sum(subtotal), 0) as gross, coalesce(sum(discount_amount), 0) as disc,
         coalesce(sum(tax_amount), 0) as tax, coalesce(sum(total), 0) as total, coalesce(sum(net_sales), 0) as net
    into s from ws.sales
   where status = 'completed' and occurred_at >= v_start and occurred_at < v_end;
  select count(*) as cnt, coalesce(sum(subtotal), 0) as gross, coalesce(sum(discount_amount), 0) as disc,
         coalesce(sum(tax_amount), 0) as tax, coalesce(sum(total), 0) as total, coalesce(sum(net_amount), 0) as net
    into r from ws.returns
   where occurred_at >= v_start and occurred_at < v_end;

  select coalesce(sum(si.line_total - si.tax_amount) filter (where si.tax_amount > 0), 0) as tx,
         coalesce(sum(si.line_total - si.tax_amount) filter (where si.tax_amount = 0), 0) as ntx
    into st
    from ws.sale_items si join ws.sales sl on sl.id = si.sale_id
   where sl.status = 'completed' and sl.occurred_at >= v_start and sl.occurred_at < v_end;
  select coalesce(sum(ri.total - ri.tax_amount) filter (where osi.tax_amount > 0), 0) as tx,
         coalesce(sum(ri.total - ri.tax_amount) filter (where osi.tax_amount = 0), 0) as ntx
    into rt
    from ws.return_items ri
    join ws.returns rr on rr.id = ri.return_id
    join ws.sale_items osi on osi.id = ri.sale_item_id
   where rr.occurred_at >= v_start and rr.occurred_at < v_end;

  v_tot := jsonb_build_object(
    'orders', s.orders, 'gross_sales', s.gross - r.gross, 'discounts', s.disc - r.disc,
    'tax_collected', s.tax - r.tax, 'billed', s.total - r.total, 'net_sales', s.net - r.net,
    'taxable_sales', st.tx - rt.tx, 'not_taxable_sales', st.ntx - rt.ntx,
    'returns_count', r.cnt, 'returns_total', r.total, 'returns_tax', r.tax);

  select coalesce(jsonb_agg(t order by t.tax_name, t.tax_rate), '[]'::jsonb) into v_rates
    from (select x.tax_name, x.tax_rate, x.tax_mode,
                 count(distinct x.sale_id) filter (where x.kind = 'sale') as orders,
                 coalesce(sum(x.net) filter (where x.taxed), 0) as taxable_sales,
                 coalesce(sum(x.net) filter (where not x.taxed), 0) as not_taxable_sales,
                 coalesce(sum(x.tax), 0) as tax
            from (select coalesce(sl.tax_name, 'No tax') as tax_name, sl.tax_rate, sl.tax_mode, 'sale' as kind, sl.id as sale_id,
                         si.line_total - si.tax_amount as net, si.tax_amount as tax, si.tax_amount > 0 as taxed
                    from ws.sales sl join ws.sale_items si on si.sale_id = sl.id
                   where sl.status = 'completed' and sl.occurred_at >= v_start and sl.occurred_at < v_end
                  union all
                  select coalesce(sl.tax_name, 'No tax'), sl.tax_rate, sl.tax_mode, 'return', sl.id,
                         -(ri.total - ri.tax_amount), -ri.tax_amount, osi.tax_amount > 0
                    from ws.returns rr
                    join ws.return_items ri on ri.return_id = rr.id
                    join ws.sales sl on sl.id = rr.sale_id
                    join ws.sale_items osi on osi.id = ri.sale_item_id
                   where rr.occurred_at >= v_start and rr.occurred_at < v_end) x
           group by x.tax_name, x.tax_rate, x.tax_mode) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date', d.day, 'orders', coalesce(x.orders, 0), 'net_sales', coalesce(x.net, 0) - coalesce(y.net, 0),
           'tax', coalesce(x.tax, 0) - coalesce(y.tax, 0), 'billed', coalesce(x.billed, 0) - coalesce(y.billed, 0),
           'returned', coalesce(y.billed, 0)) order by d.day), '[]'::jsonb)
    into v_days
    from (select g::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
    left join (select (occurred_at at time zone v_tz)::date as day, count(*) as orders, sum(net_sales) as net,
                      sum(tax_amount) as tax, sum(total) as billed
                 from ws.sales
                where status = 'completed' and occurred_at >= v_start and occurred_at < v_end
                group by 1) x on x.day = d.day
    left join (select (occurred_at at time zone v_tz)::date as day, sum(net_amount) as net,
                      sum(tax_amount) as tax, sum(total) as billed
                 from ws.returns
                where occurred_at >= v_start and occurred_at < v_end
                group by 1) y on y.day = d.day;

  select jsonb_build_object('orders', count(*), 'billed', coalesce(sum(total), 0), 'tax', coalesce(sum(tax_amount), 0))
    into v_void
    from ws.sales
   where status = 'voided' and occurred_at >= v_start and occurred_at < v_end;

  return jsonb_build_object('range', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz),
                            'totals', v_tot, 'by_rate', v_rates, 'daily', v_days, 'voided', v_void);
end
$$;

create or replace function public.get_sale_reviews(p_include_resolved boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not private.has_role('owner', 'manager') then
    raise exception 'You are not allowed to see this.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'sale_id', r.sale_id, 'invoice_number', s.invoice_number, 'kind', r.kind, 'note', r.note,
             'total', s.total, 'occurred_at', s.occurred_at, 'uploaded_at', o.uploaded_at, 'cashier', pr.name,
             'resolved_at', r.resolved_at, 'resolved_note', r.resolved_note) order by r.created_at desc)
      from ws.sale_reviews r
      join ws.sales s on s.id = r.sale_id
      left join ws.sale_offline o on o.sale_id = r.sale_id
      left join public.profiles pr on pr.id = s.cashier_id
     where p_include_resolved or r.resolved_at is null), '[]'::jsonb);
end $$;

-- 7. TRIAL SESSIONS: START, START FRESH, LOG OUT, EXPIRE, CLEAN UP --------------------------------
-- Two tiny additions to existing triggers so that copying the sample data does not create fake "initial stock" / audit rows
create or replace function private.log_initial_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('app.trial_clone', true), '') = '1' then
    return new;
  end if;
  if new.quantity <> 0 then
    insert into public.inventory_movements (product_id, type, quantity_change, quantity_after, actor_id)
    values (new.id, 'initial', new.quantity, new.quantity, auth.uid());
  end if;
  return new;
end
$$;

create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
  v_details jsonb;
begin
  if coalesce(current_setting('app.trial_clone', true), '') = '1' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_id := new.id::text;
    v_details := jsonb_build_object('new', to_jsonb(new));
  else
    v_id := new.id::text;
    v_details := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
  end if;
  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values (lower(tg_op), tg_table_name, v_id, auth.uid(), v_details);
  return null;
end
$$;

-- copy the ORIGINAL rows into a new workspace (new ids; staff columns point at the trial user; originals are only READ)
-- p_lists_only = true  -> only the four small lists (payment methods, sales channels, categories, expense categories): an empty shop
create or replace function private.trial_seed(p_ws uuid, p_user uuid, p_lists_only boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_sql text;
  v_fk text;
  v_usr text;
  v_tables text[];
begin
  if private.ws() is distinct from p_ws then
    raise exception 'The sample copy can only be made for your own live trial workspace.';
  end if;
  perform set_config('app.ws_admin', '1', true);
  perform set_config('app.trial_clone', '1', true);
  perform set_config('app.stock_rpc', '1', true);

  create temp table _m (old uuid primary key, new uuid not null) on commit drop;
  v_tables := case when p_lists_only
    then array['categories', 'expense_categories', 'sales_channels', 'payment_methods']
    else array['categories', 'expense_categories', 'sales_channels', 'payment_methods', 'products', 'customers', 'sales', 'sale_items',
               'payments', 'expenses', 'inventory_movements', 'returns', 'return_items', 'shifts', 'cash_movements'] end;
  for s in select unnest(v_tables) as t loop
    execute format('insert into _m select id, gen_random_uuid() from public.%I where workspace_id is null', s.t);
  end loop;

  for s in
    select * from (values
      (1,  'categories',          '{}'::text[],                                      '{}'::text[]),
      (2,  'expense_categories',  '{}',                                              '{}'),
      (3,  'sales_channels',      '{}',                                              '{}'),
      (4,  'payment_methods',     '{}',                                              '{}'),
      (5,  'products',            '{category_id}',                                   '{}'),
      (6,  'customers',           '{}',                                              '{}'),
      (7,  'sales',               '{channel_id,customer_id}',                        '{cashier_id,voided_by}'),
      (8,  'sale_items',          '{sale_id,product_id}',                            '{}'),
      (9,  'payments',            '{sale_id,method_id}',                             '{received_by}'),
      (10, 'expenses',            '{category_id}',                                   '{created_by,voided_by}'),
      (11, 'inventory_movements', '{product_id,reference_id}',                       '{actor_id}'),
      (12, 'returns',             '{sale_id,refund_method_id}',                      '{processed_by}'),
      (13, 'return_items',        '{return_id,sale_item_id,product_id}',             '{}'),
      (14, 'shifts',              '{}',                                              '{opened_by,closed_by}'),
      (15, 'cash_movements',      '{shift_id}',                                      '{created_by}')
    ) as v(ord, t, fks, usrs) where v.t = any (v_tables) order by v.ord
  loop
    v_fk := '';
    for i in 1 .. coalesce(array_length(s.fks, 1), 0) loop
      v_fk := v_fk || format(' || jsonb_build_object(%L, (select x.new from _m x where x.old = o.%I))', s.fks[i], s.fks[i]);
    end loop;
    v_usr := '';
    for i in 1 .. coalesce(array_length(s.usrs, 1), 0) loop
      v_usr := v_usr || format(' || jsonb_build_object(%L, case when o.%I is null then null else %L::uuid end)', s.usrs[i], s.usrs[i], p_user);
    end loop;
    v_sql := format('insert into public.%1$I select (jsonb_populate_record(null::public.%1$I, to_jsonb(o) || jsonb_build_object(''id'', m.new, ''workspace_id'', %2$L::uuid)%3$s%4$s)).* '
                    'from public.%1$I o join _m m on m.old = o.id where o.workspace_id is null',
                    s.t, p_ws, v_fk, v_usr);
    execute v_sql;
  end loop;

  drop table _m;
  perform set_config('app.trial_clone', '', true);
  perform set_config('app.stock_rpc', '', true);
  perform set_config('app.ws_admin', '', true);
end
$$;
revoke all on function private.trial_seed(uuid, uuid, boolean) from public, anon, authenticated;

-- delete EVERYTHING that belongs to one trial workspace (and nothing else), then mark the session cleaned
create or replace function private.trial_clean(p_ws uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t text;
begin
  if p_ws is null then
    raise exception 'Refusing to clean without a workspace id.';
  end if;
  perform set_config('app.ws_admin', '1', true);
  perform set_config('app.stock_rpc', '1', true);
  foreach t in array array['return_items', 'returns', 'sale_reviews', 'sale_offline', 'payments', 'sale_items', 'cash_movements', 'shifts',
                           'inventory_movements', 'sales', 'expenses', 'audit_logs', 'products', 'customers', 'categories',
                           'expense_categories', 'sales_channels', 'payment_methods']
  loop
    execute format('delete from public.%I where workspace_id = %L', t, p_ws);
  end loop;
  update public.trial_sessions set ended_at = coalesce(ended_at, now()), cleaned_at = now() where id = p_ws;
  perform set_config('app.stock_rpc', '', true);
  perform set_config('app.ws_admin', '', true);
end
$$;
revoke all on function private.trial_clean(uuid) from public, anon, authenticated;

create or replace function private.trial_session_json(s public.trial_sessions)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('session_id', s.id, 'mode', s.mode, 'business_name', s.business_name,
                            'expires_at', s.expires_at, 'hard_expires_at', s.hard_expires_at)
$$;

-- the trial user's own live session (or null)
create or replace function private.trial_live(p_user uuid)
returns public.trial_sessions
language sql
stable
security definer
set search_path = public
as $$
  select s.* from public.trial_sessions s
   where s.user_id = p_user and s.ended_at is null and s.expires_at > now() and s.hard_expires_at > now()
   order by s.started_at desc limit 1
$$;
revoke all on function private.trial_live(uuid) from public, anon, authenticated;

-- called right after a trial person signs in. Gives them their live session, or makes a new one from a fresh copy of the sample shop.
create or replace function public.trial_begin()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s     public.trial_sessions;
  o     record;
begin
  if v_uid is null or not private.is_trial() then
    raise exception 'This is only for trial accounts.';
  end if;
  perform pg_advisory_xact_lock(hashtext('trial-' || v_uid::text));
  s := private.trial_live(v_uid);
  if s.id is not null then
    update public.trial_sessions set last_seen_at = now(), expires_at = least(now() + interval '4 hours', hard_expires_at) where id = s.id returning * into s;
    return private.trial_session_json(s);
  end if;
  -- anything left over from an earlier (expired / abandoned) session of this person goes now
  for o in select id from public.trial_sessions where user_id = v_uid and cleaned_at is null loop
    perform private.trial_clean(o.id);
  end loop;
  insert into public.trial_sessions (user_id, mode, expires_at, hard_expires_at)
  values (v_uid, 'sample', now() + interval '4 hours', now() + interval '24 hours') returning * into s;
  perform private.trial_seed(s.id, v_uid, false);
  return private.trial_session_json(s);
end
$$;

-- the "Start Fresh" button: throw away this person's workspace and start an EMPTY one (only the small lists are copied)
create or replace function public.trial_start_fresh()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  s      public.trial_sessions;
  v_name text;
  o      record;
begin
  if v_uid is null or not private.is_trial() then
    raise exception 'This is only for trial accounts.';
  end if;
  perform pg_advisory_xact_lock(hashtext('trial-' || v_uid::text));
  s := private.trial_live(v_uid);
  if s.id is null then
    raise exception 'Your trial session has ended. Please sign in again.';
  end if;
  v_name := s.business_name;
  for o in select id from public.trial_sessions where user_id = v_uid and cleaned_at is null loop
    perform private.trial_clean(o.id);
  end loop;
  insert into public.trial_sessions (user_id, mode, business_name, expires_at, hard_expires_at)
  values (v_uid, 'empty', v_name, now() + interval '4 hours', s.hard_expires_at) returning * into s;
  perform private.trial_seed(s.id, v_uid, true);
  return private.trial_session_json(s);
end
$$;

-- log out: the session is closed and its rows are deleted straight away (the scheduled sweep is the backup)
create or replace function public.trial_end()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  o     record;
begin
  if v_uid is null or not private.is_trial() then
    return jsonb_build_object('ok', true, 'trial', false);
  end if;
  perform pg_advisory_xact_lock(hashtext('trial-' || v_uid::text));
  for o in select id from public.trial_sessions where user_id = v_uid and cleaned_at is null loop
    perform private.trial_clean(o.id);
  end loop;
  return jsonb_build_object('ok', true, 'trial', true);
end
$$;

-- "still here": pushes the expiry forward (never past the 24 hour limit). Fails once the session is over.
create or replace function public.trial_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s     public.trial_sessions;
begin
  if v_uid is null or not private.is_trial() then
    raise exception 'This is only for trial accounts.';
  end if;
  s := private.trial_live(v_uid);
  if s.id is null then
    raise exception 'Your trial session has ended. Please sign in again.';
  end if;
  update public.trial_sessions set last_seen_at = now(), expires_at = least(now() + interval '4 hours', hard_expires_at) where id = s.id returning * into s;
  return private.trial_session_json(s);
end
$$;

-- trial users cannot edit the real business, but they may give THEIR trial shop a name
create or replace function public.trial_set_business_name(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  s      public.trial_sessions;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if v_uid is null or not private.is_trial() then
    raise exception 'This is only for trial accounts.';
  end if;
  if v_name is null or char_length(v_name) > 80 then
    raise exception 'Enter a business name (1 to 80 characters).';
  end if;
  s := private.trial_live(v_uid);
  if s.id is null then
    raise exception 'Your trial session has ended. Please sign in again.';
  end if;
  update public.trial_sessions set business_name = v_name where id = s.id returning * into s;
  return private.trial_session_json(s);
end
$$;

-- the scheduled sweep: cleans every session that ended or expired, and forgets very old session records. Safe to run any time.
create or replace function public.trial_cleanup()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  o record;
  n integer := 0;
begin
  for o in select id from public.trial_sessions
            where cleaned_at is null and (ended_at is not null or expires_at <= now() or hard_expires_at <= now())
  loop
    perform private.trial_clean(o.id);
    n := n + 1;
  end loop;
  delete from public.trial_sessions where cleaned_at is not null and cleaned_at < now() - interval '7 days';
  return n;
end
$$;

-- who may call what
revoke all on function public.trial_begin(), public.trial_start_fresh(), public.trial_end(), public.trial_heartbeat(),
                       public.trial_set_business_name(text), public.trial_cleanup() from public, anon, authenticated;
grant execute on function public.trial_begin(), public.trial_start_fresh(), public.trial_end(), public.trial_heartbeat(),
                          public.trial_set_business_name(text) to authenticated;
grant execute on function public.trial_cleanup() to service_role;

-- you run these two in the SQL Editor to turn someone into a trial user (or back into a normal user)
create or replace function public.make_trial_user(p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.profiles set account_type = 'trial', role = 'owner', active = true where lower(email) = lower(trim(p_email));
  get diagnostics n = row_count;
  if n = 0 then raise exception 'No account with that email yet. Create it in Authentication > Users first.'; end if;
  return 'OK: ' || p_email || ' is now a trial user.';
end
$$;
create or replace function public.make_standard_user(p_email text, p_role text default 'cashier')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.profiles set account_type = 'standard', role = p_role where lower(email) = lower(trim(p_email));
  get diagnostics n = row_count;
  if n = 0 then raise exception 'No account with that email.'; end if;
  return 'OK: ' || p_email || ' is now a normal ' || p_role || '.';
end
$$;
revoke all on function public.make_trial_user(text), public.make_standard_user(text, text) from public, anon, authenticated;

-- run the sweep every 15 minutes (needs the pg_cron extension: Supabase > Database > Extensions > pg_cron > enable)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'trial-cleanup';
    perform cron.schedule('trial-cleanup', '*/15 * * * *', 'select public.trial_cleanup()');
  else
    raise notice 'pg_cron is not enabled, so the 15-minute sweep was NOT scheduled. Enable it in Database > Extensions and run this file again. (Logout cleanup still works, and an expired person is cleaned the next time they sign in.)';
  end if;
end $$;


commit;

select 'Trial sandbox installed.' as result;
