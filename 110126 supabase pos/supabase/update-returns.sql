-- UPDATE: adds RETURNS AND REFUNDS (and makes the Dashboard, Tax report, balances and stock count them) to a shop
-- that already ran setup.sql. Paste this whole file into Supabase > SQL Editor > New query, then click Run.
-- It is safe to run twice. It adds new tables and replaces functions; your sales, products and expenses are not changed.
-- Success looks like a result row saying: Returns installed.

begin;

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

commit;

select 'Returns installed' as result;
