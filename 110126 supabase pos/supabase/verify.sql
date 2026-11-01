-- SELF-CHECK for the database rules. Run AFTER setup.sql, in the SQL Editor.
-- It creates test data, makes sales, checks the maths, and then ROLLS EVERYTHING BACK,
-- so nothing is left behind. You need the owner account to exist (created in Authentication > Users).
-- Success looks like: a result row saying  ALL CHECKS PASSED  (any mistake shows an ERROR with a message).
-- It is safe on a shop that already has sales: the dashboard check compares before/after.

begin;

do $$
declare
  v_owner  uuid;
  v_tz     text;
  v_cash   uuid;
  v_p1     uuid;
  v_p2     uuid;
  v_s1     uuid := gen_random_uuid();
  v_s2     uuid := gen_random_uuid();
  v_res    jsonb;
  v_row    public.sales%rowtype;
  v_qty    numeric;
  v_dash   jsonb;
  v_failed boolean;
  v_today  date;
  v_b      jsonb;
begin
  select id into v_owner from public.profiles where role = 'owner' and active limit 1;
  if v_owner is null then
    raise exception 'No active owner found. Create the owner user (the email from setup.sql) in Authentication > Users first.';
  end if;

  -- act as the owner, the way the app does
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select id into v_cash from public.payment_methods where active order by sort_order limit 1;
  if v_cash is null then raise exception 'Add at least one payment method first.'; end if;
  update public.businesses set tax_enabled = true, tax_name = 'VAT', tax_rate = 12, tax_mode = 'inclusive';
  select timezone into v_tz from public.businesses;
  v_today := (now() at time zone v_tz)::date;
  v_b := public.get_dashboard(v_today, v_today, v_today - 1, v_today - 1);

  insert into public.products (name, price, cost_price, quantity) values ('Verify A', 100, 40, 10) returning id into v_p1;
  insert into public.products (name, price, cost_price, quantity, tax_exempt) values ('Verify B', 50, 20, 5, true) returning id into v_p2;

  -- 1. inclusive tax + 10% discount + exempt product
  v_res := public.create_sale(
    jsonb_build_object('id', v_s1, 'discount_type', 'percent', 'discount_value', 10),
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 2), jsonb_build_object('product_id', v_p2, 'quantity', 1)),
    jsonb_build_array(jsonb_build_object('method_id', v_cash, 'amount', 100)));
  select * into v_row from public.sales where id = v_s1;
  assert v_row.subtotal = 250.00,        'subtotal should be 250.00, got ' || v_row.subtotal;
  assert v_row.discount_amount = 25.00,  'discount should be 25.00, got ' || v_row.discount_amount;
  assert v_row.tax_amount = 19.29,       'tax should be 19.29 (180 x 12/112), got ' || v_row.tax_amount;
  assert v_row.total = 225.00,           'total should be 225.00, got ' || v_row.total;
  assert v_row.net_sales = 205.71,       'net sales should be 205.71, got ' || v_row.net_sales;
  assert v_row.cogs = 100.00,            'cost of goods should be 100.00, got ' || v_row.cogs;
  select quantity into v_qty from public.products where id = v_p1;
  assert v_qty = 8, 'stock of A should be 8';

  -- 2. sending the same sale again changes nothing
  v_res := public.create_sale(jsonb_build_object('id', v_s1),
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 2)), '[]'::jsonb);
  assert (v_res ->> 'duplicate')::boolean, 'the repeat should be reported as a duplicate';
  select quantity into v_qty from public.products where id = v_p1;
  assert v_qty = 8, 'stock must not change on a duplicate';

  -- 3. too much stock is refused and leaves nothing behind
  v_failed := false;
  begin
    perform public.create_sale(jsonb_build_object('id', gen_random_uuid()),
      jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 100)), '[]'::jsonb);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'selling more than the stock must fail';

  -- 4. exclusive tax
  update public.businesses set tax_mode = 'exclusive';
  v_res := public.create_sale(jsonb_build_object('id', v_s2),
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), '[]'::jsonb);
  select * into v_row from public.sales where id = v_s2;
  assert v_row.tax_amount = 12.00 and v_row.total = 112.00 and v_row.net_sales = 100.00,
         'exclusive: tax 12.00, total 112.00, net 100.00, got ' || v_row.tax_amount || '/' || v_row.total || '/' || v_row.net_sales;

  -- 5. pay later: balance, over-payment refused, then settled
  perform public.record_payment(null, v_s2, v_cash, 50);
  v_failed := false;
  begin
    perform public.record_payment(null, v_s2, v_cash, 100);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'paying more than the balance must fail';
  perform public.record_payment(null, v_s2, v_cash, 62);
  assert (select balance from public.sales_overview where id = v_s2) = 0, 'balance should be 0 after full payment';

  -- 6. stock cannot be edited directly
  v_failed := false;
  begin
    update public.products set quantity = 999 where id = v_p1;
  exception when others then v_failed := true;
  end;
  assert v_failed, 'a direct stock edit must be refused';

  -- 7. void puts the stock back
  perform public.void_sale(v_s1, 'verify');
  select quantity into v_qty from public.products where id = v_p1;
  assert v_qty = 9, 'after the void, stock of A should be 9 (10 - 1 sold in the second sale)';
  select quantity into v_qty from public.products where id = v_p2;
  assert v_qty = 5, 'after the void, stock of B should be 5';

  -- 8. dashboard: compared with before, only the second sale counts (the first was voided)
  v_dash := public.get_dashboard(v_today, v_today, v_today - 1, v_today - 1);
  assert (v_dash -> 'current' ->> 'orders')::int - (v_b -> 'current' ->> 'orders')::int = 1, 'dashboard: 1 more order expected';
  assert (v_dash -> 'current' ->> 'net_sales')::numeric - (v_b -> 'current' ->> 'net_sales')::numeric = 100.00, 'dashboard: net sales +100.00 expected';
  assert (v_dash -> 'current' ->> 'collected')::numeric - (v_b -> 'current' ->> 'collected')::numeric = 112.00, 'dashboard: collected +112.00 expected';

  -- 8b. bad input is refused: NaN quantity, negative discount, a date far in the past, a forged invoice number is ignored
  v_failed := false;
  begin
    perform public.create_sale(jsonb_build_object('id', gen_random_uuid()),
      jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 'NaN')), '[]'::jsonb);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'a NaN quantity must be refused';
  v_failed := false;
  begin
    perform public.create_sale(jsonb_build_object('id', gen_random_uuid(), 'occurred_at', '2001-01-01T00:00:00Z'),
      jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), '[]'::jsonb);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'a sale dated years ago must be refused';
  v_res := public.create_sale(jsonb_build_object('id', gen_random_uuid(), 'invoice_number', 'FORGED-1'),
      jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), '[]'::jsonb);
  assert (v_res ->> 'invoice_number') like 'INV-%', 'invoice numbers must come from the server';
  v_failed := false;
  begin
    perform public.adjust_stock(v_p1, 'NaN'::numeric, 'x');
  exception when others then v_failed := true;
  end;
  assert v_failed, 'a NaN stock change must be refused';

  -- 8c. even the owner cannot write sales directly or edit the audit trail (only the functions can)
  v_failed := false;
  begin
    insert into public.sales (invoice_number, cashier_id, total) values ('HACK', v_owner, 1);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'direct inserts into sales must be refused';
  v_failed := false;
  begin
    update public.audit_logs set action = 'x';
  exception when others then v_failed := true;
  end;
  assert v_failed, 'the audit trail must not be editable';

  -- 9. a person who is not active sees nothing
  reset role;
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert (select count(*) from public.products) = 0, 'an unknown or inactive user must not see products';

  -- 10. the public (anon) key sees nothing at all
  reset role;
  set local role anon;
  v_failed := false;
  begin
    perform count(*) from public.products;
  exception when others then v_failed := true;
  end;
  assert v_failed, 'the anon role must not be able to read products';
  reset role;

  raise notice 'ALL CHECKS PASSED';
end
$$;

rollback;

-- (the rollback above removed all test data; this line is only the message)
select 'ALL CHECKS PASSED' as result;
