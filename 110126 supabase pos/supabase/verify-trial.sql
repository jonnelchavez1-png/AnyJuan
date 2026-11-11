-- =====================================================================================
-- AnyJuanPOS  -  verify-trial.sql   (run AFTER update-trial.sql)
--
-- A safety check you can run any time. It makes two pretend trial people, lets them use the POS (sell, return, stock,
-- Start Fresh, log out, expire) and proves that:
--   * your ORIGINAL rows, stock, invoice numbers and dashboard are exactly the same before and after
--   * a trial person never sees or changes original data, or another trial person's data
--   * logout / expiry delete every temporary row
-- EVERYTHING it does is undone at the end (rollback), so it leaves nothing behind.
-- HOW: Supabase > SQL Editor > New query > paste > Run. Success = a green "Success" and the notice  TRIAL CHECKS PASSED.
-- =====================================================================================
begin;

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub', u::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false);
  set role authenticated;
end $$;
create or replace function pg_temp.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
create or replace function pg_temp.fingerprint() returns text language plpgsql as $$
declare t text; r text := ''; c bigint;
begin
  foreach t in array array['categories','expense_categories','sales_channels','payment_methods','products','customers','sales','sale_items','payments','expenses','inventory_movements','audit_logs','returns','return_items','shifts','cash_movements']
  loop execute format('select count(*) from public.%I where workspace_id is null', t) into c; r := r || t || '=' || c || ';'; end loop;
  return r || 'stock=' || coalesce((select string_agg(id::text || ':' || quantity, ',' order by id) from public.products where workspace_id is null), '')
           || ';invoices=' || coalesce((select string_agg(invoice_number || ':' || total || ':' || status, ',' order by invoice_number) from public.sales where workspace_id is null), '')
           || ';business=' || (select name from public.businesses limit 1);
end $$;

do $$
declare
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); ow uuid; fp_before text; dash_before jsonb;
  r jsonb; ws1 uuid; ws1b uuid; p uuid; m uuid; sl uuid := gen_random_uuid(); orig_prod uuid; orig_sale uuid; n int; cust uuid; d jsonb; k int;
  d_from date := current_date - 400; d_to date := current_date;
begin
  select id into ow from public.profiles where role = 'owner' and active and account_type = 'standard' order by created_at limit 1;
  assert ow is not null, 'No normal owner account found: run setup.sql first.';
  assert to_regclass('public.trial_sessions') is not null, 'Run update-trial.sql first.';

  -- two pretend trial people
  insert into auth.users (id, email, raw_user_meta_data) values (t1, 'verify-trial-1@invalid.test', '{"name":"Verify One"}'), (t2, 'verify-trial-2@invalid.test', '{"name":"Verify Two"}');
  perform public.make_trial_user('verify-trial-1@invalid.test'); perform public.make_trial_user('verify-trial-2@invalid.test');

  -- the ORIGINAL business, as the owner sees it
  perform pg_temp.as_user(ow);
  fp_before := pg_temp.fingerprint();
  dash_before := public.get_dashboard(d_from, d_to, d_from - 401, d_from - 1);
  select id into orig_prod from public.products where workspace_id is null limit 1;
  select id into orig_sale from public.sales where workspace_id is null limit 1;

  -- ===== a normal user and a trial user cannot use each other's tools =====
  assert pg_temp.fails('select public.trial_begin()'), 'a normal owner cannot start a trial';
  assert pg_temp.fails('select public.trial_cleanup()'), 'only the server can run the sweep';
  assert pg_temp.fails('select public.make_trial_user(''x@y.z'')'), 'only you (SQL Editor) can make trial users';

  -- ===== trial person 1: default = a copy of the sample shop =====
  perform pg_temp.as_user(t1);
  r := public.trial_begin(); ws1 := (r->>'session_id')::uuid;
  assert r->>'mode' = 'sample', 'first login is the sample copy';
  assert (select count(*) from public.products) = (select count(*) from public.products where workspace_id = ws1), 'trial sees only its own products';
  assert (select count(*) from public.profiles) = 1, 'trial cannot see the real team';
  assert public.get_dashboard(d_from, d_to, d_from - 401, d_from - 1)->'current' = dash_before->'current', 'the copy shows the same dashboard as the original';
  update public.businesses set name = 'HACK'; get diagnostics n = row_count; assert n = 0, 'trial cannot rename the real business';
  update public.profiles set role = 'cashier' where id = ow; get diagnostics n = row_count; assert n = 0, 'trial cannot edit the team';
  assert (public.trial_set_business_name('My Trial Shop')->>'business_name') = 'My Trial Shop', 'trial can name its own shop';

  if orig_prod is not null then
    assert pg_temp.fails(format('select public.adjust_stock(%L, 5, ''x'')', orig_prod)), 'cannot change original stock';
  end if;
  if orig_sale is not null then
    assert pg_temp.fails(format('select public.void_sale(%L, ''x'')', orig_sale)), 'cannot void an original sale';
    assert pg_temp.fails(format('select public.record_payment(null, %L, (select id from public.payment_methods limit 1), 1)', orig_sale)), 'cannot pay an original sale';
  end if;

  -- trial works: new product, sale, return, stock, expense, drawer
  select id into m from public.payment_methods order by sort_order limit 1;
  assert m is not null, 'trial has payment methods';
  insert into public.categories (name) values ('Verify Category');
  insert into public.products (name, sku, price, cost_price, quantity) values ('Verify Item', 'VERIFY-1', 100, 40, 10) returning id into p;
  insert into public.customers (name) values ('Verify Customer') returning id into cust;
  if not exists (select 1 from public.shifts where closed_at is null) then perform public.open_shift('{"opening_cash":100}'::jsonb); end if;
  r := public.create_sale(jsonb_build_object('id', sl, 'customer_id', cust), jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 3)), '[]'::jsonb);
  assert (r->>'invoice_number') like 'TRL-INV-%', 'trial invoices are numbered TRL-INV-';
  perform public.record_payment(null, sl, m, (select total from public.sales where id = sl));
  assert (select quantity from public.products where id = p) = 7, 'trial stock went 10 -> 7';
  r := public.create_return(jsonb_build_object('sale_id', sl, 'reason', 'verify', 'refund_method_id', m), (select jsonb_agg(jsonb_build_object('sale_item_id', id, 'quantity', 1)) from public.sale_items where sale_id = sl));
  perform public.adjust_stock(p, 5, 'verify');
  assert (select quantity from public.products where id = p) = 13, 'trial stock 7 + 1 returned + 5 added = 13';
  insert into public.expenses (amount, expense_date, created_by) values (25, current_date, t1);
  assert (select count(*) from public.inventory_movements where product_id = p) >= 3, 'trial stock history exists';

  -- ===== trial person 2 sees nothing of person 1 =====
  perform pg_temp.as_user(t2);
  perform public.trial_begin();
  assert (select count(*) from public.products where name = 'Verify Item') = 0, 'T2 cannot see T1 products';
  assert pg_temp.fails(format('select public.adjust_stock(%L, 5, ''x'')', p)), 'T2 cannot change T1 stock';
  assert pg_temp.fails(format('select public.void_sale(%L, ''x'')', sl)), 'T2 cannot void T1 sale';

  -- ===== the ORIGINAL business did not move =====
  perform pg_temp.as_user(ow);
  assert pg_temp.fingerprint() = fp_before, 'ORIGINAL rows, stock, invoices and business name are unchanged while trials work';
  assert public.get_dashboard(d_from, d_to, d_from - 401, d_from - 1) = dash_before, 'ORIGINAL dashboard is unchanged';

  -- ===== Start Fresh =====
  perform pg_temp.as_user(t1);
  r := public.trial_start_fresh(); ws1b := (r->>'session_id')::uuid;
  assert ws1b <> ws1 and r->>'mode' = 'empty', 'Start Fresh makes a new empty workspace';
  assert (select count(*) from public.products) = 0 and (select count(*) from public.sales) = 0 and (select count(*) from public.customers) = 0
     and (select count(*) from public.expenses) = 0 and (select count(*) from public.shifts) = 0 and (select count(*) from public.inventory_movements) = 0, 'Start Fresh = empty shop';
  assert (select count(*) from public.payment_methods) >= 1, 'the small lists are copied so selling works';
  assert (public.get_dashboard(d_from, d_to, d_from - 401, d_from - 1)->'current'->>'orders')::int = 0, 'empty dashboard';
  reset role;
  assert (select count(*) from public.sales where workspace_id = ws1) = 0 and (select count(*) from public.products where workspace_id = ws1) = 0, 'the old workspace rows are gone';

  -- ===== logout deletes everything of T1 =====
  perform pg_temp.as_user(t1); perform public.trial_end();
  assert (select count(*) from public.products) = 0 and pg_temp.fails('insert into public.categories (name) values (''x'')'), 'after logout: nothing visible, nothing writable';
  assert pg_temp.fails('select public.trial_heartbeat()'), 'after logout the session is invalid';
  reset role;
  assert (select count(*) from public.payment_methods where workspace_id in (select id from public.trial_sessions where user_id = t1)) = 0, 'no T1 rows left';

  -- ===== log in again = a brand new default copy =====
  perform pg_temp.as_user(t1);
  r := public.trial_begin();
  assert r->>'mode' = 'sample' and (r->>'session_id')::uuid not in (ws1, ws1b) and r->>'business_name' is null, 'new login = new default copy';
  assert (select count(*) from public.products where name = 'Verify Item') = 0, 'nothing from the previous session';

  -- ===== abandoned session (browser closed): expires, sweep cleans =====
  reset role;
  update public.trial_sessions set expires_at = now() - interval '1 minute' where user_id = t1 and ended_at is null;
  perform pg_temp.as_user(t1);
  assert pg_temp.fails('select public.trial_heartbeat()'), 'expired session is refused';
  assert (select count(*) from public.products) = 0 and pg_temp.fails('select public.create_sale(jsonb_build_object(''id'', gen_random_uuid()), ''[]''::jsonb, ''[]''::jsonb)'), 'expired session cannot sell';
  reset role;
  assert public.trial_cleanup() >= 1, 'the sweep cleans expired sessions';

  -- ===== finish: clean everything, original still identical =====
  perform pg_temp.as_user(t1); perform public.trial_end(); perform pg_temp.as_user(t2); perform public.trial_end();
  reset role;
  k := 0;
  select count(*) into k from (
    select workspace_id from public.products union all select workspace_id from public.sales union all select workspace_id from public.sale_items union all select workspace_id from public.payments
    union all select workspace_id from public.expenses union all select workspace_id from public.inventory_movements union all select workspace_id from public.audit_logs union all select workspace_id from public.customers
    union all select workspace_id from public.categories union all select workspace_id from public.returns union all select workspace_id from public.return_items union all select workspace_id from public.shifts
    union all select workspace_id from public.cash_movements union all select workspace_id from public.payment_methods union all select workspace_id from public.sales_channels union all select workspace_id from public.expense_categories) q
   where workspace_id is not null;
  assert k = 0, 'no temporary rows remain anywhere (' || k || ' left)';
  perform pg_temp.as_user(ow);
  assert pg_temp.fingerprint() = fp_before, 'ORIGINAL data identical at the very end';
  reset role;
  raise notice 'TRIAL CHECKS PASSED';
end $$;

rollback;   -- undo everything this check did
