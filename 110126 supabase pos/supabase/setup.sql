-- =====================================================================================
-- Retailer POS v3  -  database setup
-- For a NEW, EMPTY Supabase project (Postgres 15 or newer). ONE business per project.
--
-- HOW TO RUN: Supabase dashboard > SQL Editor > New query > paste this whole file > Run.
-- BEFORE you run it: change the owner email in section 1 (the line marked CHANGE THIS).
-- It never reads or deletes data from other tables. It can be run again safely.
--
-- The browser never writes sales, payments or stock directly. It calls the functions in
-- section 7 (create_sale, void_sale, record_payment, adjust_stock). Those functions
-- recompute every price, tax amount and total on the server, so a customer-facing
-- screen cannot send made-up numbers.
-- =====================================================================================

begin;

-- 1. WHO IS THE OWNER ----------------------------------------------------------------
create schema if not exists private;

create table if not exists private.bootstrap (
  singleton   boolean primary key default true check (singleton),
  owner_email text not null
);

insert into private.bootstrap (singleton, owner_email)
values (true, 'CHANGE_ME@example.com')            -- <<< CHANGE THIS to your own email address
on conflict (singleton) do update set owner_email = excluded.owner_email;

alter table private.bootstrap enable row level security;
revoke all on private.bootstrap from public, anon, authenticated;

do $$
begin
  if exists (select 1 from private.bootstrap where owner_email = 'CHANGE_ME@example.com') then
    raise exception 'Please edit the line marked CHANGE THIS (section 1) and put your own email address in it, then run again.';
  end if;
end
$$;

-- 2. TABLES --------------------------------------------------------------------------
create table if not exists public.businesses (
  id              uuid primary key default gen_random_uuid(),
  singleton       boolean not null default true unique check (singleton),
  name            text not null default 'My Business',
  currency        text not null default 'PHP' check (char_length(currency) = 3),
  locale          text not null default 'en-PH',
  timezone        text not null default 'Asia/Manila',
  week_starts_on  smallint not null default 1 check (week_starts_on in (0, 1)),   -- 0 Sunday, 1 Monday
  cashier_max_discount_pct numeric(5,2) not null default 100 check (cashier_max_discount_pct between 0 and 100),
  tax_enabled     boolean not null default false,                                  -- tax is OPTIONAL
  tax_name        text not null default 'Tax',
  tax_rate        numeric(6,3) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  tax_mode        text not null default 'inclusive' check (tax_mode in ('inclusive', 'exclusive')),
  receipt_header  text,
  receipt_footer  text default 'Thank you!',
  theme           text not null default 'deep-sea',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null,
  email       text not null,
  role        text not null default 'cashier' check (role in ('owner', 'manager', 'cashier', 'accountant')),
  active      boolean not null default false,       -- nobody gets in until the owner switches them on
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Four small lists the owner can edit in the app (nothing is hard-coded in the app).
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.expense_categories (like public.categories including all);
create table if not exists public.sales_channels      (like public.categories including all);
create table if not exists public.payment_methods     (like public.categories including all);

create unique index if not exists categories_name_key         on public.categories         (lower(name));
create unique index if not exists expense_categories_name_key on public.expense_categories (lower(name));
create unique index if not exists sales_channels_name_key     on public.sales_channels     (lower(name));
create unique index if not exists payment_methods_name_key    on public.payment_methods    (lower(name));

create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(trim(name)) > 0),
  sku           text,
  barcode       text,
  category_id   uuid references public.categories (id) on delete set null,
  price         numeric(14,2) not null default 0 check (price >= 0),
  cost_price    numeric(14,2) not null default 0 check (cost_price >= 0),
  track_stock   boolean not null default true,       -- turn off for services
  quantity      numeric(12,3) not null default 0,
  reorder_level numeric(12,3) not null default 0 check (reorder_level >= 0),
  tax_exempt    boolean not null default false,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (not track_stock or quantity >= 0),
  check (quantity <> 'NaN'::numeric)
);
create unique index if not exists products_sku_key     on public.products (lower(sku))  where sku is not null and sku <> '';
create unique index if not exists products_barcode_key on public.products (barcode)     where barcode is not null and barcode <> '';
create index if not exists products_name_idx on public.products (lower(name));

create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) > 0),
  phone       text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create sequence if not exists public.invoice_seq;

-- ids of sales, items and payments can be created by the app itself (needed for future offline use)
create table if not exists public.sales (
  id              uuid primary key default gen_random_uuid(),
  invoice_number  text not null unique,
  channel_id      uuid references public.sales_channels (id) on delete set null,
  customer_id     uuid references public.customers (id) on delete set null,
  cashier_id      uuid not null references public.profiles (id),
  status          text not null default 'completed' check (status in ('completed', 'voided')),
  subtotal        numeric(14,2) not null default 0,   -- quantity x price, before discount
  discount_amount numeric(14,2) not null default 0,
  tax_mode        text not null default 'none' check (tax_mode in ('none', 'inclusive', 'exclusive')),
  tax_name        text,
  tax_rate        numeric(6,3) not null default 0,
  tax_amount      numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,   -- what the customer owes
  net_sales       numeric(14,2) not null default 0,   -- total minus tax: this is the revenue
  cogs            numeric(14,2) not null default 0,   -- cost of the goods sold
  note            text,
  occurred_at     timestamptz not null default now(), -- when the sale happened (may be earlier than created_at if offline)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid references public.profiles (id),
  void_reason     text
);
create index if not exists sales_occurred_idx on public.sales (occurred_at desc);
create index if not exists sales_customer_idx on public.sales (customer_id);

create table if not exists public.sale_items (
  id              uuid primary key default gen_random_uuid(),
  sale_id         uuid not null references public.sales (id) on delete cascade,
  line_no         integer not null,
  product_id      uuid not null references public.products (id),
  name            text not null,
  quantity        numeric(12,3) not null check (quantity > 0),
  unit_price      numeric(14,2) not null check (unit_price >= 0),
  unit_cost       numeric(14,2) not null default 0,
  line_gross      numeric(14,2) not null default 0,
  discount_amount numeric(14,2) not null default 0,
  tax_amount      numeric(14,2) not null default 0,
  line_total      numeric(14,2) not null default 0
);
create index if not exists sale_items_sale_idx    on public.sale_items (sale_id);
create index if not exists sale_items_product_idx on public.sale_items (product_id);

create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references public.sales (id) on delete cascade,
  method_id    uuid references public.payment_methods (id) on delete set null,
  amount       numeric(14,2) not null check (amount > 0),
  paid_at      timestamptz not null default now(),
  received_by  uuid references public.profiles (id),
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists payments_sale_idx on public.payments (sale_id);
create index if not exists payments_paid_idx on public.payments (paid_at);

create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid references public.expense_categories (id) on delete set null,
  amount       numeric(14,2) not null check (amount > 0),
  expense_date date not null,
  payee        text,
  note         text,
  created_by   uuid references public.profiles (id),
  voided_at    timestamptz,
  voided_by    uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists expenses_date_idx on public.expenses (expense_date);

create table if not exists public.inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products (id),
  type            text not null check (type in ('initial', 'sale', 'void', 'adjustment')),
  quantity_change numeric(12,3) not null,
  quantity_after  numeric(12,3) not null,
  reference_id    uuid,
  note            text,
  actor_id        uuid references public.profiles (id),
  created_at      timestamptz not null default now()
);
create index if not exists inventory_product_idx on public.inventory_movements (product_id, created_at desc);

create table if not exists public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  action     text not null,
  entity     text not null,
  entity_id  text,
  actor_id   uuid,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_created_idx on public.audit_logs (created_at desc);

-- 3. HELPER FUNCTIONS USED BY THE SECURITY RULES -------------------------------------
create or replace function private.has_role(variadic p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select pr.role = any (p_roles) from public.profiles pr where pr.id = (select auth.uid()) and pr.active),
    false)
$$;

create or replace function private.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.active)
$$;

grant usage on schema private to authenticated;
revoke all on function private.has_role(text[]) from public;
revoke all on function private.is_member() from public;
grant execute on function private.has_role(text[]) to authenticated;
grant execute on function private.is_member() to authenticated;

-- 4. TRIGGERS: bookkeeping that cannot be skipped -----------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['businesses', 'profiles', 'categories', 'expense_categories', 'sales_channels',
                           'payment_methods', 'products', 'customers', 'sales', 'expenses']
  loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()', t);
  end loop;
end
$$;

-- time zone must be a real one, otherwise reports would fail
create or replace function private.check_business()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone;
  end if;
  return new;
end
$$;
drop trigger if exists check_business on public.businesses;
create trigger check_business before insert or update on public.businesses
  for each row execute function private.check_business();

-- stock may only change through the functions in section 7 (so every change is logged)
create or replace function private.guard_stock()
returns trigger
language plpgsql
as $$
begin
  if new.quantity is distinct from old.quantity
     and coalesce(current_setting('app.stock_rpc', true), '') <> '1' then
    raise exception 'Stock can only be changed with a stock adjustment or a sale.';
  end if;
  return new;
end
$$;
drop trigger if exists guard_stock on public.products;
create trigger guard_stock before update on public.products
  for each row execute function private.guard_stock();

-- opening stock entered when a product is created is logged too
create or replace function private.log_initial_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.quantity <> 0 then
    insert into public.inventory_movements (product_id, type, quantity_change, quantity_after, actor_id)
    values (new.id, 'initial', new.quantity, new.quantity, auth.uid());
  end if;
  return new;
end
$$;
drop trigger if exists log_initial_stock on public.products;
create trigger log_initial_stock after insert on public.products
  for each row execute function private.log_initial_stock();

-- the business can never be left without an active owner
create or replace function private.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'owner' and old.active and (new.role <> 'owner' or not new.active) then
    if not exists (select 1 from public.profiles where role = 'owner' and active and id <> old.id) then
      raise exception 'There must always be one active owner.';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists guard_last_owner on public.profiles;
create trigger guard_last_owner before update on public.profiles
  for each row execute function private.guard_last_owner();

-- audit trail for the things that change money or access
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

do $$
declare t text;
begin
  foreach t in array array['businesses', 'profiles', 'expenses']
  loop
    execute format('drop trigger if exists audit_ins on public.%I', t);
    execute format('drop trigger if exists audit_upd on public.%I', t);
    execute format('create trigger audit_ins after insert on public.%I for each row execute function private.audit_row()', t);
    execute format('create trigger audit_upd after update on public.%I for each row execute function private.audit_row()', t);
  end loop;
end
$$;

drop trigger if exists audit_ins on public.products;
drop trigger if exists audit_upd on public.products;
create trigger audit_ins after insert on public.products
  for each row execute function private.audit_row();
create trigger audit_upd after update on public.products
  for each row when (old.name is distinct from new.name or old.price is distinct from new.price
                     or old.cost_price is distinct from new.cost_price or old.active is distinct from new.active
                     or old.tax_exempt is distinct from new.tax_exempt or old.track_stock is distinct from new.track_stock)
  execute function private.audit_row();

-- the audit trail can be added to, never changed or deleted (not even by the owner)
create or replace function private.audit_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'The audit trail cannot be changed.';
end
$$;
drop trigger if exists audit_immutable on public.audit_logs;
create trigger audit_immutable before update or delete on public.audit_logs
  for each row execute function private.audit_immutable();

-- new sign-ups get a profile. Only the owner email from section 1 becomes an active owner.
-- Everyone else starts INACTIVE and sees nothing until the owner switches them on.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_email text;
  v_is_owner boolean;
begin
  select owner_email into v_owner_email from private.bootstrap limit 1;
  -- only a CONFIRMED address can become the owner, and only while the business has no active owner yet
  v_is_owner := v_owner_email is not null
    and new.email_confirmed_at is not null
    and lower(new.email) = lower(v_owner_email)
    and not exists (select 1 from public.profiles where role = 'owner' and active);
  insert into public.profiles (id, name, email, role, active)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    new.email,
    case when v_is_owner then 'owner' else 'cashier' end,
    v_is_owner
  )
  on conflict (id) do nothing;
  return new;
end
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- when the owner's email is confirmed LATER (usual when "Confirm email" is on), promote them then
create or replace function public.promote_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and lower(new.email) = (select lower(owner_email) from private.bootstrap)
     and not exists (select 1 from public.profiles where role = 'owner' and active) then
    update public.profiles set role = 'owner', active = true where id = new.id;
  end if;
  return new;
end
$$;
revoke all on function public.promote_owner() from public, anon, authenticated;
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.promote_owner();

-- 5. THE ONE BUSINESS, DEFAULT LISTS, AND PROFILES FOR PEOPLE WHO ALREADY EXIST ---------
insert into public.businesses (singleton) values (true) on conflict (singleton) do nothing;

insert into public.payment_methods (name, sort_order)
select v.name, v.ord from (values ('Cash', 1), ('Card', 2), ('E-wallet', 3)) as v(name, ord)
where not exists (select 1 from public.payment_methods m where lower(m.name) = lower(v.name));

insert into public.sales_channels (name, sort_order)
select v.name, v.ord from (values ('In-store', 1), ('Online', 2), ('Delivery', 3)) as v(name, ord)
where not exists (select 1 from public.sales_channels m where lower(m.name) = lower(v.name));

insert into public.expense_categories (name, sort_order)
select v.name, v.ord from (values ('Rent', 1), ('Utilities', 2), ('Salaries', 3), ('Supplies', 4), ('Transport', 5), ('Other', 6)) as v(name, ord)
where not exists (select 1 from public.expense_categories m where lower(m.name) = lower(v.name));

insert into public.profiles (id, name, email, role, active)
select u.id, split_part(u.email, '@', 1), u.email,
       'cashier',
       false
from auth.users u
where u.email is not null
on conflict (id) do nothing;

-- an already-registered, CONFIRMED owner-email account becomes the owner (only if there is no active owner yet)
update public.profiles pr
   set role = 'owner', active = true
  from auth.users u, private.bootstrap b
 where u.id = pr.id and u.email_confirmed_at is not null and lower(u.email) = lower(b.owner_email)
   and not exists (select 1 from public.profiles o where o.role = 'owner' and o.active);

-- 6. SECURITY RULES (row level security) ---------------------------------------------
alter table public.businesses          enable row level security;
alter table public.profiles            enable row level security;
alter table public.categories          enable row level security;
alter table public.expense_categories  enable row level security;
alter table public.sales_channels      enable row level security;
alter table public.payment_methods     enable row level security;
alter table public.products            enable row level security;
alter table public.customers           enable row level security;
alter table public.sales               enable row level security;
alter table public.sale_items          enable row level security;
alter table public.payments            enable row level security;
alter table public.expenses            enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.audit_logs          enable row level security;

-- businesses: everyone on the team reads it, only the owner edits it
drop policy if exists "team reads business" on public.businesses;
create policy "team reads business" on public.businesses for select to authenticated using ((select private.is_member()));
drop policy if exists "owner edits business" on public.businesses;
create policy "owner edits business" on public.businesses for update to authenticated
  using (private.has_role('owner')) with check (private.has_role('owner'));

-- profiles: you can always read your own row (so the app can say "waiting for approval");
-- the team reads everyone; only the owner changes roles / switches people on or off
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_member());
drop policy if exists "owner edits profiles" on public.profiles;
create policy "owner edits profiles" on public.profiles for update to authenticated
  using (private.has_role('owner')) with check (private.has_role('owner'));

-- the four editable lists: team reads, owner and manager edit (they are switched off, never deleted)
do $$
declare t text;
begin
  foreach t in array array['categories', 'expense_categories', 'sales_channels', 'payment_methods']
  loop
    execute format('drop policy if exists "team reads" on public.%I', t);
    execute format('create policy "team reads" on public.%I for select to authenticated using ((select private.is_member()))', t);
    execute format('drop policy if exists "managers add" on public.%I', t);
    execute format('create policy "managers add" on public.%I for insert to authenticated with check (private.has_role(''owner'', ''manager''))', t);
    execute format('drop policy if exists "managers edit" on public.%I', t);
    execute format('create policy "managers edit" on public.%I for update to authenticated using (private.has_role(''owner'', ''manager'')) with check (private.has_role(''owner'', ''manager''))', t);
  end loop;
end
$$;

-- products: team reads, owner and manager add and edit (never delete: switch off instead)
drop policy if exists "team reads products" on public.products;
create policy "team reads products" on public.products for select to authenticated using ((select private.is_member()));
drop policy if exists "managers add products" on public.products;
create policy "managers add products" on public.products for insert to authenticated
  with check (private.has_role('owner', 'manager'));
drop policy if exists "managers edit products" on public.products;
create policy "managers edit products" on public.products for update to authenticated
  using (private.has_role('owner', 'manager')) with check (private.has_role('owner', 'manager'));

-- customers: anyone who sells can add and edit
drop policy if exists "team reads customers" on public.customers;
create policy "team reads customers" on public.customers for select to authenticated using ((select private.is_member()));
drop policy if exists "sellers add customers" on public.customers;
create policy "sellers add customers" on public.customers for insert to authenticated
  with check (private.has_role('owner', 'manager', 'cashier'));
drop policy if exists "sellers edit customers" on public.customers;
create policy "sellers edit customers" on public.customers for update to authenticated
  using (private.has_role('owner', 'manager', 'cashier')) with check (private.has_role('owner', 'manager', 'cashier'));

-- sales, items, payments: the team can READ. Nobody can write directly (only the functions can).
drop policy if exists "team reads sales" on public.sales;
create policy "team reads sales" on public.sales for select to authenticated using ((select private.is_member()));
drop policy if exists "team reads sale items" on public.sale_items;
create policy "team reads sale items" on public.sale_items for select to authenticated using ((select private.is_member()));
drop policy if exists "team reads payments" on public.payments;
create policy "team reads payments" on public.payments for select to authenticated using ((select private.is_member()));

-- expenses
drop policy if exists "finance reads expenses" on public.expenses;
create policy "finance reads expenses" on public.expenses for select to authenticated
  using (private.has_role('owner', 'manager', 'accountant'));
drop policy if exists "finance adds expenses" on public.expenses;
create policy "finance adds expenses" on public.expenses for insert to authenticated
  with check (private.has_role('owner', 'manager', 'accountant') and created_by = (select auth.uid()));
drop policy if exists "finance edits expenses" on public.expenses;
create policy "finance edits expenses" on public.expenses for update to authenticated
  using (private.has_role('owner', 'manager', 'accountant')) with check (private.has_role('owner', 'manager', 'accountant'));

-- stock history and the audit trail: owner and manager read only
drop policy if exists "managers read stock history" on public.inventory_movements;
create policy "managers read stock history" on public.inventory_movements for select to authenticated
  using (private.has_role('owner', 'manager'));
drop policy if exists "managers read audit" on public.audit_logs;
create policy "managers read audit" on public.audit_logs for select to authenticated
  using (private.has_role('owner', 'manager'));

-- defence in depth: even without a rule, signed-in users get no direct write access to these
revoke all on all tables in schema public from anon;
-- Explicit grants (so this works whatever default privileges the project has). Row level security above still
-- decides WHICH rows. Signed-in users can read everything the policies allow, but write only where listed here.
revoke all on all tables in schema public from authenticated;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update on public.categories, public.expense_categories, public.sales_channels, public.payment_methods,
  public.customers, public.expenses to authenticated;
grant update on public.businesses to authenticated;
grant update (name, role, active) on public.profiles to authenticated;
grant insert on public.products to authenticated;
-- the stock quantity is NOT in this list: it can only change through the sale / void / adjust functions
grant update (name, sku, barcode, category_id, price, cost_price, track_stock, reorder_level, tax_exempt, active)
  on public.products to authenticated;

-- a handy list of sales with how much is still unpaid (obeys the same security rules as the tables)
create or replace view public.sales_overview
with (security_invoker = true)
as
select s.*,
       coalesce(p.paid, 0)               as paid,
       case when s.status = 'completed' then s.total - coalesce(p.paid, 0) else 0 end as balance
from public.sales s
left join (select sale_id, sum(amount) as paid from public.payments group by sale_id) p on p.sale_id = s.id;

revoke all on public.sales_overview from anon;
grant select on public.sales_overview to authenticated;

-- 7. THE FUNCTIONS THE APP CALLS ------------------------------------------------------

-- create_sale: records a sale, its lines, stock and payments in ONE step.
--   p_sale     {"id": uuid, "invoice_number"?, "channel_id"?, "customer_id"?, "discount_type"?: "percent"|"amount",
--               "discount_value"?, "note"?, "occurred_at"?}
--   p_items    [{"product_id": uuid, "quantity": number}]       prices always come from the products table
--   p_payments [{"id"?: uuid, "method_id": uuid, "amount": number}]   may be less than the total (pay later)
-- Sending the same sale id twice is safe: the second call changes nothing and says "duplicate".
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
  select * into v_exist from public.sales where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'sale_id', v_exist.id,
                              'invoice_number', v_exist.invoice_number, 'total', v_exist.total);
  end if;

  select * into v_biz from public.businesses limit 1;
  if v_biz.tax_enabled and v_biz.tax_rate > 0 then
    v_mode := v_biz.tax_mode;
    v_rate := v_biz.tax_rate;
  end if;

  v_occurred := least(coalesce(nullif(p_sale ->> 'occurred_at', '')::timestamptz, now()), now());
  -- a sale cannot be back-dated far: cashiers 3 days (enough for a short offline spell), owner/manager 1 year
  v_window := case when private.has_role('owner', 'manager') then interval '366 days' else interval '3 days' end;
  if v_occurred < now() - v_window then
    raise exception 'The sale date is too far in the past.';
  end if;
  -- invoice numbers are always made by the server (a device cannot choose or pre-claim one)
  v_invoice  := 'INV-' || lpad(nextval('public.invoice_seq')::text, 6, '0');

  -- the sale row first (zeros for now): if two devices send the same id at once, only one gets past here
  insert into public.sales (id, invoice_number, channel_id, customer_id, cashier_id, status,
                            tax_mode, tax_name, tax_rate, note, occurred_at)
  values (v_id, v_invoice, nullif(p_sale ->> 'channel_id', '')::uuid, nullif(p_sale ->> 'customer_id', '')::uuid,
          v_uid, 'completed', v_mode,
          case when v_mode = 'none' then null else v_biz.tax_name end, v_rate,
          nullif(trim(p_sale ->> 'note'), ''), v_occurred)
  on conflict (id) do nothing;
  if not found then
    select * into v_exist from public.sales where id = v_id;
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
  insert into public.sale_items (sale_id, line_no, product_id, name, quantity, unit_price, unit_cost, line_gross)
  select v_id,
         row_number() over (order by x.first_pos),
         p.id, p.name, x.qty, p.price, p.cost_price, round(x.qty * p.price, 2)
  from (select (t.item ->> 'product_id')::uuid        as product_id,
               sum((t.item ->> 'quantity')::numeric)  as qty,
               min(t.pos)                             as first_pos
        from jsonb_array_elements(p_items) with ordinality as t(item, pos)
        group by 1) x
  join public.products p on p.id = x.product_id and p.active;
  get diagnostics v_found = row_count;

  select count(distinct (item ->> 'product_id')::uuid) into v_expected from jsonb_array_elements(p_items) as item;
  if v_found <> v_expected then
    raise exception 'One of the products is missing or switched off.';
  end if;

  -- lock the products (in a fixed order, so two cashiers cannot deadlock) and check stock
  perform 1 from public.products
   where id in (select product_id from public.sale_items where sale_id = v_id)
   order by id
   for update;
  select si.name into v_bad
    from public.sale_items si join public.products p on p.id = si.product_id
   where si.sale_id = v_id and p.track_stock and p.quantity < si.quantity
   limit 1;
  if v_bad is not null then
    raise exception 'Not enough stock for %', v_bad;
  end if;

  -- discount
  select coalesce(sum(line_gross), 0) into v_subtotal from public.sale_items where sale_id = v_id;
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
    raise exception 'This discount needs a manager (cashiers may give up to % percent).', v_biz.cashier_max_discount_pct;
  end if;

  -- share the discount over the lines to the cent: round each share down, then give the leftover
  -- cents to the lines that lost the most (ties go to the earlier line)
  if v_discount > 0 then
    update public.sale_items si
       set discount_amount = floor(v_discount * si.line_gross / v_subtotal * 100) / 100
     where si.sale_id = v_id;
    select round((v_discount - coalesce(sum(discount_amount), 0)) * 100)::integer into v_rem
      from public.sale_items where sale_id = v_id;
    if v_rem > 0 then
      update public.sale_items si
         set discount_amount = si.discount_amount + 0.01
       where si.id in (
         select s2.id from public.sale_items s2
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
      from public.products p
     where si.sale_id = v_id and p.id = si.product_id;
  elsif v_mode = 'exclusive' then
    -- prices are before tax: tax = amount x rate / 100, added on top
    update public.sale_items si
       set tax_amount = case when p.tax_exempt then 0
                             else round((si.line_gross - si.discount_amount) * v_rate / 100, 2) end
      from public.products p
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
    from public.sale_items where sale_id = v_id;

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
      from public.sale_items si join public.products p on p.id = si.product_id
     where si.sale_id = v_id and p.track_stock
     order by si.line_no
  loop
    update public.products set quantity = quantity - r.quantity where id = r.product_id
    returning quantity into v_after;
    insert into public.inventory_movements (product_id, type, quantity_change, quantity_after, reference_id, actor_id)
    values (r.product_id, 'sale', -r.quantity, v_after, v_id, v_uid);
  end loop;
  perform set_config('app.stock_rpc', '', true);

  return jsonb_build_object('ok', true, 'duplicate', false, 'sale_id', v_id, 'invoice_number', v_invoice,
                            'total', v_total, 'tax_amount', v_tax);
end
$$;

-- void_sale: cancels a whole sale and puts the stock back. Owner and manager only.
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

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'sale_id', v_sale.id);
  end if;

  update public.sales
     set status = 'voided', voided_at = now(), voided_by = v_uid, void_reason = trim(p_reason)
   where id = p_sale_id;

  perform set_config('app.stock_rpc', '1', true);
  for r in
    select im.product_id, -im.quantity_change as quantity
      from public.inventory_movements im
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

-- record_payment: money received later for a sale that was not fully paid.
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

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  -- checked AFTER the lock, so two devices sending the same payment id cannot both get through
  if p_payment_id is not null and exists (select 1 from public.payments where id = p_payment_id) then
    if exists (select 1 from public.payments where id = p_payment_id and sale_id = p_sale_id) then
      return jsonb_build_object('ok', true, 'duplicate', true);
    end if;
    raise exception 'That payment id was already used for another sale.';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'This sale was voided.';
  end if;
  select coalesce(sum(amount), 0) into v_paid from public.payments where sale_id = p_sale_id;
  if v_amt > v_sale.total - v_paid then
    raise exception 'That is more than the balance (%).', v_sale.total - v_paid;
  end if;

  insert into public.payments (id, sale_id, method_id, amount, paid_at, received_by, note)
  values (coalesce(p_payment_id, gen_random_uuid()), p_sale_id, p_method_id, v_amt, now(), v_uid, nullif(trim(p_note), ''));

  return jsonb_build_object('ok', true, 'duplicate', false, 'balance', v_sale.total - v_paid - v_amt);
end
$$;

-- adjust_stock: add or remove stock with a note (delivery received, damage, count correction).
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

  select * into v_prod from public.products where id = p_product_id for update;
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

-- Numbers for one period. Used twice by get_dashboard (this period and the one before).
--   net sales        = money from sales without tax, after discounts (completed sales only)
--   collected        = payments received in the period (for completed sales)
--   gross profit     = net sales - cost of goods sold
--   net profit       = gross profit - expenses
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
begin
  select count(*), coalesce(sum(subtotal), 0), coalesce(sum(discount_amount), 0), coalesce(sum(tax_amount), 0),
         coalesce(sum(total), 0), coalesce(sum(net_sales), 0), coalesce(sum(cogs), 0)
    into v_orders, v_gross, v_disc, v_tax, v_billed, v_net, v_cogs
    from public.sales
   where status = 'completed' and occurred_at >= p_start and occurred_at < p_end;

  select coalesce(sum(si.quantity), 0) into v_units
    from public.sale_items si join public.sales s on s.id = si.sale_id
   where s.status = 'completed' and s.occurred_at >= p_start and s.occurred_at < p_end;

  select coalesce(sum(pm.amount), 0) into v_collected
    from public.payments pm join public.sales s on s.id = pm.sale_id
   where s.status = 'completed' and pm.paid_at >= p_start and pm.paid_at < p_end;

  select coalesce(sum(amount), 0) into v_expenses
    from public.expenses
   where voided_at is null and expense_date between p_from and p_to;

  return jsonb_build_object(
    'orders', v_orders, 'units', v_units, 'gross_sales', v_gross, 'discounts', v_disc, 'tax_collected', v_tax,
    'billed', v_billed, 'net_sales', v_net, 'cogs', v_cogs, 'gross_profit', v_net - v_cogs,
    'collected', v_collected, 'expenses', v_expenses, 'net_profit', v_net - v_cogs - v_expenses);
end
$$;

-- get_dashboard: everything the dashboard shows, for a date range in the business time zone.
-- p_from / p_to are whole days (both included). The "previous" range is chosen by the app.
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
           'date', d.day, 'orders', coalesce(s.orders, 0), 'net_sales', coalesce(s.net, 0),
           'gross_profit', coalesce(s.net, 0) - coalesce(s.cogs, 0), 'expenses', coalesce(e.amount, 0))
         order by d.day), '[]'::jsonb)
    into v_series
    from (select g::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
    left join (select (occurred_at at time zone v_tz)::date as day, count(*) as orders,
                      sum(net_sales) as net, sum(cogs) as cogs
                 from public.sales
                where status = 'completed' and occurred_at >= v_start and occurred_at < v_end
                group by 1) s on s.day = d.day
    left join (select expense_date as day, sum(amount) as amount
                 from public.expenses
                where voided_at is null and expense_date between p_from and p_to
                group by 1) e on e.day = d.day;

  select coalesce(jsonb_agg(t order by t.qty desc, t.name), '[]'::jsonb) into v_top_qty
    from (select si.name, sum(si.quantity) as qty, sum(si.line_total - si.tax_amount) as net_sales
            from public.sale_items si join public.sales s on s.id = si.sale_id
           where s.status = 'completed' and s.occurred_at >= v_start and s.occurred_at < v_end
           group by si.product_id, si.name
           order by sum(si.quantity) desc, si.name
           limit 10) t;

  select coalesce(jsonb_agg(t order by t.net_sales desc, t.name), '[]'::jsonb) into v_top_net
    from (select si.name, sum(si.quantity) as qty, sum(si.line_total - si.tax_amount) as net_sales,
                 sum(si.line_total - si.tax_amount - round(si.quantity * si.unit_cost, 2)) as gross_profit
            from public.sale_items si join public.sales s on s.id = si.sale_id
           where s.status = 'completed' and s.occurred_at >= v_start and s.occurred_at < v_end
           group by si.product_id, si.name
           order by sum(si.line_total - si.tax_amount) desc, si.name
           limit 10) t;

  select coalesce(jsonb_agg(t order by t.net_sales desc, t.name), '[]'::jsonb) into v_by_cat
    from (select coalesce(c.name, 'No category') as name, sum(si.line_total - si.tax_amount) as net_sales,
                 sum(si.line_total - si.tax_amount - round(si.quantity * si.unit_cost, 2)) as gross_profit
            from public.sale_items si
            join public.sales s on s.id = si.sale_id
            join public.products p on p.id = si.product_id
            left join public.categories c on c.id = p.category_id
           where s.status = 'completed' and s.occurred_at >= v_start and s.occurred_at < v_end
           group by coalesce(c.name, 'No category')) t;

  select coalesce(jsonb_agg(t order by t.net_sales desc, t.name), '[]'::jsonb) into v_by_chan
    from (select coalesce(ch.name, 'No channel') as name, count(*) as orders, sum(s.net_sales) as net_sales
            from public.sales s left join public.sales_channels ch on ch.id = s.channel_id
           where s.status = 'completed' and s.occurred_at >= v_start and s.occurred_at < v_end
           group by coalesce(ch.name, 'No channel')) t;

  select coalesce(jsonb_agg(t order by t.amount desc, t.name), '[]'::jsonb) into v_by_pay
    from (select coalesce(m.name, 'Unknown') as name, sum(pm.amount) as amount
            from public.payments pm
            join public.sales s on s.id = pm.sale_id
            left join public.payment_methods m on m.id = pm.method_id
           where s.status = 'completed' and pm.paid_at >= v_start and pm.paid_at < v_end
           group by coalesce(m.name, 'Unknown')) t;

  select coalesce(jsonb_agg(t order by t.amount desc, t.name), '[]'::jsonb) into v_exp_cat
    from (select coalesce(ec.name, 'No category') as name, sum(e.amount) as amount
            from public.expenses e left join public.expense_categories ec on ec.id = e.category_id
           where e.voided_at is null and e.expense_date between p_from and p_to
           group by coalesce(ec.name, 'No category')) t;

  -- receivables are "as of now", not "in the period"
  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(b.balance), 0)) into v_recv
    from (select s.total - coalesce(p.paid, 0) as balance
            from public.sales s
            left join (select sale_id, sum(amount) as paid from public.payments group by sale_id) p on p.sale_id = s.id
           where s.status = 'completed' and s.total - coalesce(p.paid, 0) > 0) b;

  select coalesce(jsonb_agg(t order by t.quantity, t.name), '[]'::jsonb) into v_low
    from (select p.id, p.name, p.quantity, p.reorder_level
            from public.products p
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

-- who may call what: signed-in users only (never the public/anonymous key)
revoke all on function public.create_sale(jsonb, jsonb, jsonb)                        from public, anon;
revoke all on function public.void_sale(uuid, text)                                    from public, anon;
revoke all on function public.record_payment(uuid, uuid, uuid, numeric, text)          from public, anon;
revoke all on function public.adjust_stock(uuid, numeric, text)                        from public, anon;
revoke all on function public.get_dashboard(date, date, date, date)                    from public, anon;
revoke all on function private.period_totals(timestamptz, timestamptz, date, date)     from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, jsonb)                      to authenticated;
grant execute on function public.void_sale(uuid, text)                                 to authenticated;
grant execute on function public.record_payment(uuid, uuid, uuid, numeric, text)       to authenticated;
grant execute on function public.adjust_stock(uuid, numeric, text)                     to authenticated;
grant execute on function public.get_dashboard(date, date, date, date)                 to authenticated;

commit;

-- Check: you should see one business and your owner email.
select (select name from public.businesses limit 1) as business,
       (select owner_email from private.bootstrap)   as owner_email,
       (select count(*) from public.profiles)        as people;
