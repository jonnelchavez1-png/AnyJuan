-- UPDATE: adds OFFLINE SELLING support to the database (sales made with no internet are uploaded later).
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run. It is safe to run twice.
-- It ADDS two small tables and three functions, and replaces create_sale with a version that behaves EXACTLY the same
-- for normal (online) sales. Nothing that exists today is removed. Success looks like: Offline selling installed.
-- (Run update-returns.sql and update-drawer.sql first if you have not yet.)

begin;

do $$
begin
  if to_regclass('public.returns') is null then
    raise exception 'Please run update-returns.sql first, then run this file again.';
  end if;
end $$;

-- OFFLINE SALES ------------------------------------------------------------------------------------------
-- A sale made on a device with no internet is kept on that device and uploaded later through the SAME create_sale
-- function (with "offline": true). These tables only record that it happened and what the owner should check.
create table if not exists public.sale_offline (
  sale_id     uuid primary key references public.sales (id),
  client_time timestamptz not null,                       -- the time the device said the sale happened
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references public.profiles (id)
);
create table if not exists public.sale_reviews (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references public.sales (id),
  kind          text not null check (kind in ('stock', 'price', 'tax', 'discount', 'old', 'inactive')),
  note          text not null,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references public.profiles (id),
  resolved_note text,
  unique (sale_id, kind)
);
create index if not exists sale_reviews_open_idx on public.sale_reviews (created_at) where resolved_at is null;
alter table public.sale_offline enable row level security;
alter table public.sale_reviews enable row level security;
drop policy if exists sale_offline_read on public.sale_offline;
create policy sale_offline_read on public.sale_offline for select to authenticated using (private.has_role('owner', 'manager', 'accountant'));
drop policy if exists sale_reviews_read on public.sale_reviews;
create policy sale_reviews_read on public.sale_reviews for select to authenticated using (private.has_role('owner', 'manager'));
revoke all on public.sale_offline, public.sale_reviews from anon, authenticated;
grant select on public.sale_offline, public.sale_reviews to authenticated;

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
  select * into v_exist from public.sales where id = v_id;
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
  join public.products p on p.id = x.product_id and (p.active or v_off);
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
  if v_bad is not null and not v_off then
    raise exception 'Not enough stock for %', v_bad;
  end if;
  if v_off then
    -- the customer already walked away with the goods: record the sale, take stock down to zero, and flag it for a recount
    select string_agg(format('%s: sold %s, only %s was in the system', si.name, si.quantity, p.quantity), '; ' order by si.line_no)
      into v_bad
      from public.sale_items si join public.products p on p.id = si.product_id
     where si.sale_id = v_id and p.track_stock and p.quantity < si.quantity;
    if v_bad is not null then
      v_flags := v_flags || jsonb_build_object('stock', v_bad || '. Stock was set to 0: please recount.');
    end if;
    select string_agg(format('%s: sold at %s, price now %s', si.name, si.unit_price, p.price), '; ' order by si.line_no)
      into v_bad
      from public.sale_items si join public.products p on p.id = si.product_id
     where si.sale_id = v_id and si.unit_price <> p.price;
    if v_bad is not null then
      v_flags := v_flags || jsonb_build_object('price', v_bad);
    end if;
    if exists (select 1 from public.sale_items si join public.products p on p.id = si.product_id where si.sale_id = v_id and not p.active) then
      v_flags := v_flags || jsonb_build_object('inactive', 'A product on this sale was switched off before the sale was uploaded.');
    end if;
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
    select quantity into v_before from public.products where id = r.product_id;
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

-- server_time: the app asks this when it is online, to know how far the device clock is off (offline sales are stamped with it).
create or replace function public.server_time()
returns timestamptz language sql stable security definer set search_path = public as $$ select now() $$;

-- get_sale_reviews: offline sales that need a person to look at them (stock, price, tax or discount differed when uploaded).
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
      from public.sale_reviews r
      join public.sales s on s.id = r.sale_id
      left join public.sale_offline o on o.sale_id = r.sale_id
      left join public.profiles pr on pr.id = s.cashier_id
     where p_include_resolved or r.resolved_at is null), '[]'::jsonb);
end $$;

-- resolve_sale_review: "I checked this". Never changes the sale itself.
create or replace function public.resolve_sale_review(p_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.sale_reviews%rowtype;
begin
  if auth.uid() is null or not private.has_role('owner', 'manager') then
    raise exception 'You are not allowed to do that.';
  end if;
  update public.sale_reviews set resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, auth.uid()),
         resolved_note = coalesce(resolved_note, nullif(trim(p_note), ''))
   where id = p_id returning * into v_row;
  if not found then raise exception 'That item was not found.'; end if;
  insert into public.audit_logs (action, entity, entity_id, actor_id, details)
  values ('resolve', 'sale_reviews', p_id::text, auth.uid(), jsonb_build_object('sale_id', v_row.sale_id, 'kind', v_row.kind, 'note', p_note));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.server_time()                      from public, anon;
revoke all on function public.get_sale_reviews(boolean)          from public, anon;
revoke all on function public.resolve_sale_review(uuid, text)    from public, anon;
grant execute on function public.server_time()                   to authenticated;
grant execute on function public.get_sale_reviews(boolean)       to authenticated;
grant execute on function public.resolve_sale_review(uuid, text) to authenticated;

commit;

select 'Offline selling installed' as result;
