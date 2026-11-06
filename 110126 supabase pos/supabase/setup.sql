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
  type            text not null check (type in ('initial', 'sale', 'void', 'adjustment', 'return')),
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

-- RETURNS AND REFUNDS ------------------------------------------------------------------
-- A return never edits the original sale. It is its own record, counted on the day the goods come back.
create sequence if not exists public.return_seq;

create table if not exists public.returns (
  id               uuid primary key default gen_random_uuid(),
  return_number    text not null unique,
  invoice_number   text not null default '',   -- of the sale (kept here so lists need no join)
  sale_id          uuid not null references public.sales (id),
  processed_by     uuid not null references public.profiles (id),
  reason           text not null check (char_length(trim(reason)) > 0),
  subtotal         numeric(14,2) not null default 0,   -- value of the returned items before discount
  discount_amount  numeric(14,2) not null default 0,
  tax_amount       numeric(14,2) not null default 0,
  total            numeric(14,2) not null default 0,   -- what the returned items were worth to the customer (with tax)
  net_amount       numeric(14,2) not null default 0,   -- total minus tax: the sales that are taken back
  cogs             numeric(14,2) not null default 0,   -- cost of goods put back in stock (damaged items are not counted)
  refund_amount    numeric(14,2) not null default 0 check (refund_amount >= 0),   -- money handed back
  refund_method_id uuid references public.payment_methods (id) on delete set null,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create index if not exists returns_sale_idx     on public.returns (sale_id);
create index if not exists returns_occurred_idx on public.returns (occurred_at desc);

create table if not exists public.return_items (
  id              uuid primary key default gen_random_uuid(),
  return_id       uuid not null references public.returns (id) on delete cascade,
  sale_item_id    uuid not null references public.sale_items (id),
  product_id      uuid not null references public.products (id),
  name            text not null,
  quantity        numeric(12,3) not null check (quantity > 0),
  gross           numeric(14,2) not null default 0,
  discount_amount numeric(14,2) not null default 0,
  tax_amount      numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  cogs_basis      numeric(14,2) not null default 0,   -- cost of these units (used to split a line exactly)
  cogs            numeric(14,2) not null default 0,   -- the same, but 0 when the goods were not put back in stock
  restocked       boolean not null default true
);
create index if not exists return_items_return_idx on public.return_items (return_id);
create index if not exists return_items_line_idx   on public.return_items (sale_item_id);

alter table public.inventory_movements drop constraint if exists inventory_movements_type_check;
alter table public.inventory_movements add constraint inventory_movements_type_check
  check (type in ('initial', 'sale', 'void', 'adjustment', 'return'));

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

-- returns: the team can READ; only create_return() can write
alter table public.returns      enable row level security;
alter table public.return_items enable row level security;
drop policy if exists "team reads returns" on public.returns;
create policy "team reads returns" on public.returns for select to authenticated using ((select private.is_member()));
drop policy if exists "team reads return items" on public.return_items;
create policy "team reads return items" on public.return_items for select to authenticated using ((select private.is_member()));
revoke all on public.returns, public.return_items from anon;
revoke all on public.returns, public.return_items from authenticated;
grant select on public.returns, public.return_items to authenticated;

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
--   balance = total - returned items - (money received - money refunded)
create or replace view public.sales_overview
with (security_invoker = true)
as
select s.*,
       coalesce(p.paid, 0)               as paid,
       case when s.status = 'completed'
            then s.total - coalesce(r.returned, 0) - (coalesce(p.paid, 0) - coalesce(r.refunded, 0))
            else 0 end                   as balance,
       coalesce(r.returned, 0)           as returned,
       coalesce(r.refunded, 0)           as refunded
from public.sales s
left join (select sale_id, sum(amount) as paid from public.payments group by sale_id) p on p.sale_id = s.id
left join (select sale_id, sum(total) as returned, sum(refund_amount) as refunded from public.returns group by sale_id) r on r.sale_id = s.id;

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
  if exists (select 1 from public.returns where sale_id = p_sale_id) then
    raise exception 'This sale already has a return, so it cannot be voided. Return the remaining items instead.';
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
  -- what is still owed = total - returned items - (received - refunded)
  select coalesce(sum(amount), 0) into v_paid from public.payments where sale_id = p_sale_id;
  v_owed := v_sale.total - (select coalesce(sum(total), 0) from public.returns where sale_id = p_sale_id)
            - (v_paid - (select coalesce(sum(refund_amount), 0) from public.returns where sale_id = p_sale_id));
  if v_amt > v_owed then
    raise exception 'That is more than the balance (%).', v_owed;
  end if;

  insert into public.payments (id, sale_id, method_id, amount, paid_at, received_by, note)
  values (coalesce(p_payment_id, gen_random_uuid()), p_sale_id, p_method_id, v_amt, now(), v_uid, nullif(trim(p_note), ''));

  return jsonb_build_object('ok', true, 'duplicate', false, 'balance', v_owed - v_amt);
end
$$;

-- plan_return: works out what a return is worth, line by line, in cents. Used by create_return.
-- Splitting rule: returning the LAST units of a line takes exactly what is left of it (so repeated returns always
-- add up to the original sale to the cent); returning some units takes their share, rounded half up.
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
  select * into v_sale from public.sales where id = p_sale_id;
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
    select * into v_si from public.sale_items where id = v_line_id and sale_id = p_sale_id;
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
      into pr from public.return_items where sale_item_id = v_si.id;
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
  select coalesce(sum(amount), 0) into v_paid from public.payments where sale_id = p_sale_id;
  select coalesce(sum(total), 0), coalesce(sum(refund_amount), 0) into v_returned, v_refunded from public.returns where sale_id = p_sale_id;
  v_owed := v_sale.total - (v_returned + t_total) - (v_paid - v_refunded);

  return jsonb_build_object('lines', v_lines, 'subtotal', t_sub, 'discount_amount', t_disc, 'tax_amount', t_tax,
    'total', t_total, 'net_amount', t_total - t_tax, 'cogs', t_cogs,
    'refund_amount', greatest(-v_owed, 0), 'balance_after', greatest(v_owed, 0));
end
$$;

-- create_return: records a return (some or all items of one sale), puts goods back in stock and works out the refund.
--   p_return  {"id"?: uuid, "sale_id": uuid, "reason": text, "refund_method_id"?: uuid}
--   p_items   [{"sale_item_id": uuid, "quantity": number, "restock"?: boolean}]
-- Owner and manager only. Sending the same return id twice is safe.
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
  select * into v_exist from public.returns where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'return_id', v_exist.id, 'return_number', v_exist.return_number,
                              'total', v_exist.total, 'refund_amount', v_exist.refund_amount);
  end if;

  select * into v_sale from public.sales where id = nullif(p_return ->> 'sale_id', '')::uuid for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'This sale was voided, so nothing can be returned.';
  end if;
  select * into v_exist from public.returns where id = v_id;
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
  v_number := 'RET-' || lpad(nextval('public.return_seq')::text, 6, '0');

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
      select track_stock into v_track from public.products where id = (l ->> 'product_id')::uuid;
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

revoke all on function private.plan_return(uuid, jsonb)   from public, anon, authenticated;
revoke all on function public.create_return(jsonb, jsonb) from public, anon;
grant execute on function public.create_return(jsonb, jsonb) to authenticated;

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

-- period_totals: the numbers for one period (shared by the dashboard for "this period" and "the one before").
-- Sales are counted on the day they happened; returns on the day the goods came back (so a return never rewrites
-- an earlier, already reported, period). "Net sales" and "tax" are after returns, "collected" is after refunds.
--   net sales = sales without tax, after discounts, minus returns
--   gross profit = net sales - cost of goods sold (cost of goods put back in stock is taken off again)
--   net profit   = gross profit - expenses
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
    from public.sales
   where status = 'completed' and occurred_at >= p_start and occurred_at < p_end;

  select coalesce(sum(si.quantity), 0) into v_units
    from public.sale_items si join public.sales s on s.id = si.sale_id
   where s.status = 'completed' and s.occurred_at >= p_start and s.occurred_at < p_end;

  select count(*) as cnt, coalesce(sum(subtotal), 0) as subtotal, coalesce(sum(discount_amount), 0) as disc,
         coalesce(sum(tax_amount), 0) as tax, coalesce(sum(total), 0) as total, coalesce(sum(net_amount), 0) as net,
         coalesce(sum(cogs), 0) as cogs, coalesce(sum(refund_amount), 0) as refunded
    into r from public.returns where occurred_at >= p_start and occurred_at < p_end;

  select coalesce(sum(ri.quantity), 0) into r_units
    from public.return_items ri join public.returns rt on rt.id = ri.return_id
   where rt.occurred_at >= p_start and rt.occurred_at < p_end;

  select coalesce(sum(pm.amount), 0) into v_collected
    from public.payments pm join public.sales s on s.id = pm.sale_id
   where s.status = 'completed' and pm.paid_at >= p_start and pm.paid_at < p_end;

  select coalesce(sum(amount), 0) into v_expenses
    from public.expenses
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

-- dash_lines: every item line sold in the period (+) and every item line returned in the period (-)
create or replace function private.dash_lines(p_start timestamptz, p_end timestamptz)
returns table (product_id uuid, name text, qty numeric, net numeric, profit numeric)
language sql
stable
security definer
set search_path = public
as $$
  select si.product_id, si.name, si.quantity, si.line_total - si.tax_amount,
         si.line_total - si.tax_amount - round(si.quantity * si.unit_cost, 2)
    from public.sale_items si join public.sales s on s.id = si.sale_id
   where s.status = 'completed' and s.occurred_at >= p_start and s.occurred_at < p_end
  union all
  select ri.product_id, ri.name, -ri.quantity, -(ri.total - ri.tax_amount), -(ri.total - ri.tax_amount - ri.cogs)
    from public.return_items ri join public.returns rt on rt.id = ri.return_id
   where rt.occurred_at >= p_start and rt.occurred_at < p_end
$$;
revoke all on function private.dash_lines(timestamptz, timestamptz) from public, anon, authenticated;

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
           'date', d.day, 'orders', coalesce(s.orders, 0),
           'net_sales', coalesce(s.net, 0) - coalesce(rt.net, 0),
           'gross_profit', (coalesce(s.net, 0) - coalesce(s.cogs, 0)) - (coalesce(rt.net, 0) - coalesce(rt.cogs, 0)),
           'expenses', coalesce(e.amount, 0))
         order by d.day), '[]'::jsonb)
    into v_series
    from (select g::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
    left join (select (occurred_at at time zone v_tz)::date as day, count(*) as orders,
                      sum(net_sales) as net, sum(cogs) as cogs
                 from public.sales
                where status = 'completed' and occurred_at >= v_start and occurred_at < v_end
                group by 1) s on s.day = d.day
    left join (select (occurred_at at time zone v_tz)::date as day, sum(net_amount) as net, sum(cogs) as cogs
                 from public.returns
                where occurred_at >= v_start and occurred_at < v_end
                group by 1) rt on rt.day = d.day
    left join (select expense_date as day, sum(amount) as amount
                 from public.expenses
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
            join public.products p on p.id = l.product_id
            left join public.categories c on c.id = p.category_id
           group by coalesce(c.name, 'No category')) t;

  select coalesce(jsonb_agg(t order by t.net_sales desc, t.name), '[]'::jsonb) into v_by_chan
    from (select x.name, sum(x.orders) as orders, sum(x.net) as net_sales
            from (select coalesce(ch.name, 'No channel') as name, 1 as orders, s.net_sales as net
                    from public.sales s left join public.sales_channels ch on ch.id = s.channel_id
                   where s.status = 'completed' and s.occurred_at >= v_start and s.occurred_at < v_end
                  union all
                  select coalesce(ch.name, 'No channel'), 0, -rt.net_amount
                    from public.returns rt join public.sales s on s.id = rt.sale_id
                    left join public.sales_channels ch on ch.id = s.channel_id
                   where rt.occurred_at >= v_start and rt.occurred_at < v_end) x
           group by x.name) t;

  select coalesce(jsonb_agg(t order by t.amount desc, t.name), '[]'::jsonb) into v_by_pay
    from (select x.name, sum(x.amount) as amount
            from (select coalesce(m.name, 'Unknown') as name, pm.amount
                    from public.payments pm
                    join public.sales s on s.id = pm.sale_id
                    left join public.payment_methods m on m.id = pm.method_id
                   where s.status = 'completed' and pm.paid_at >= v_start and pm.paid_at < v_end
                  union all
                  select coalesce(m.name, 'Unknown'), -rt.refund_amount
                    from public.returns rt left join public.payment_methods m on m.id = rt.refund_method_id
                   where rt.refund_amount > 0 and rt.occurred_at >= v_start and rt.occurred_at < v_end) x
           group by x.name) t;

  select coalesce(jsonb_agg(t order by t.amount desc, t.name), '[]'::jsonb) into v_exp_cat
    from (select coalesce(ec.name, 'No category') as name, sum(e.amount) as amount
            from public.expenses e left join public.expense_categories ec on ec.id = e.category_id
           where e.voided_at is null and e.expense_date between p_from and p_to
           group by coalesce(ec.name, 'No category')) t;

  -- receivables are "as of now", not "in the period"
  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(b.balance), 0)) into v_recv
    from (select s.total - coalesce(r.returned, 0) - (coalesce(p.paid, 0) - coalesce(r.refunded, 0)) as balance
            from public.sales s
            left join (select sale_id, sum(amount) as paid from public.payments group by sale_id) p on p.sale_id = s.id
            left join (select sale_id, sum(total) as returned, sum(refund_amount) as refunded from public.returns group by sale_id) r on r.sale_id = s.id
           where s.status = 'completed') b
   where b.balance > 0;

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

-- get_tax_report: tax collected between two dates (both included, business time zone). Voided sales are left out.
--   Returns are taken off on the day the goods came back, so tax collected = tax on sales - tax on returns.
--   "taxable" = sale lines that carried tax, "not taxable" = lines with no tax (exempt products, or tax switched off).
--   Amounts are net of tax, so taxable + not taxable + tax = total billed (after discounts and returns).
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
    into s from public.sales
   where status = 'completed' and occurred_at >= v_start and occurred_at < v_end;
  select count(*) as cnt, coalesce(sum(subtotal), 0) as gross, coalesce(sum(discount_amount), 0) as disc,
         coalesce(sum(tax_amount), 0) as tax, coalesce(sum(total), 0) as total, coalesce(sum(net_amount), 0) as net
    into r from public.returns
   where occurred_at >= v_start and occurred_at < v_end;

  select coalesce(sum(si.line_total - si.tax_amount) filter (where si.tax_amount > 0), 0) as tx,
         coalesce(sum(si.line_total - si.tax_amount) filter (where si.tax_amount = 0), 0) as ntx
    into st
    from public.sale_items si join public.sales sl on sl.id = si.sale_id
   where sl.status = 'completed' and sl.occurred_at >= v_start and sl.occurred_at < v_end;
  select coalesce(sum(ri.total - ri.tax_amount) filter (where osi.tax_amount > 0), 0) as tx,
         coalesce(sum(ri.total - ri.tax_amount) filter (where osi.tax_amount = 0), 0) as ntx
    into rt
    from public.return_items ri
    join public.returns rr on rr.id = ri.return_id
    join public.sale_items osi on osi.id = ri.sale_item_id
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
                    from public.sales sl join public.sale_items si on si.sale_id = sl.id
                   where sl.status = 'completed' and sl.occurred_at >= v_start and sl.occurred_at < v_end
                  union all
                  select coalesce(sl.tax_name, 'No tax'), sl.tax_rate, sl.tax_mode, 'return', sl.id,
                         -(ri.total - ri.tax_amount), -ri.tax_amount, osi.tax_amount > 0
                    from public.returns rr
                    join public.return_items ri on ri.return_id = rr.id
                    join public.sales sl on sl.id = rr.sale_id
                    join public.sale_items osi on osi.id = ri.sale_item_id
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
                 from public.sales
                where status = 'completed' and occurred_at >= v_start and occurred_at < v_end
                group by 1) x on x.day = d.day
    left join (select (occurred_at at time zone v_tz)::date as day, sum(net_amount) as net,
                      sum(tax_amount) as tax, sum(total) as billed
                 from public.returns
                where occurred_at >= v_start and occurred_at < v_end
                group by 1) y on y.day = d.day;

  select jsonb_build_object('orders', count(*), 'billed', coalesce(sum(total), 0), 'tax', coalesce(sum(tax_amount), 0))
    into v_void
    from public.sales
   where status = 'voided' and occurred_at >= v_start and occurred_at < v_end;

  return jsonb_build_object('range', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz),
                            'totals', v_tot, 'by_rate', v_rates, 'daily', v_days, 'voided', v_void);
end
$$;

revoke all on function public.get_tax_report(date, date) from public, anon;
grant execute on function public.get_tax_report(date, date) to authenticated;

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
