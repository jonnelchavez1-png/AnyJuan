-- OPTIONAL demo catalog (from your earlier supabase_setup.sql): 26 grocery items in 5 categories.
-- Run AFTER setup.sql. Safe to run again: items with the same name are skipped.
-- Cost prices are left at 0 because the earlier file did not have them. Gross profit will look
-- like 100% until you enter real costs in Products.

begin;

insert into public.categories (name, sort_order)
select v.name, v.ord
from (values ('Drinks', 1), ('Snacks', 2), ('Noodles & Canned', 3), ('Pantry', 4), ('Personal Care', 5), ('Household', 6)) as v(name, ord)
where not exists (select 1 from public.categories c where lower(c.name) = lower(v.name));

insert into public.products (name, sku, category_id, price, quantity, reorder_level)
select v.name, v.sku, (select c.id from public.categories c where lower(c.name) = lower(v.category)), v.price, v.stock, 10
from (values
  ('Bottled Water 500ml',      'DRK-001', 'Drinks',             15,  48),
  ('Cola 290ml',               'DRK-002', 'Drinks',             20,  36),
  ('Orange Juice Drink 250ml', 'DRK-003', 'Drinks',             18,  36),
  ('3-in-1 Coffee Sachet',     'DRK-004', 'Drinks',              8, 100),
  ('Potato Chips 60g',         'SNK-001', 'Snacks',             30,  30),
  ('Cheese Puffs 25g',         'SNK-002', 'Snacks',             12,  40),
  ('Chocolate Bar 30g',        'SNK-003', 'Snacks',             20,  30),
  ('Cream Biscuits 10-pack',   'SNK-004', 'Snacks',             55,  20),
  ('Instant Pancit Canton',    'NDL-001', 'Noodles & Canned',   18,  60),
  ('Instant Cup Noodles',      'NDL-002', 'Noodles & Canned',   28,  30),
  ('Sardines in Tomato 155g',  'NDL-003', 'Noodles & Canned',   26,  48),
  ('Corned Beef 150g',         'NDL-004', 'Noodles & Canned',   50,  24),
  ('Tuna Flakes 140g',         'NDL-005', 'Noodles & Canned',   38,  24),
  ('Rice 1kg',                 'PAN-001', 'Pantry',             55,  50),
  ('Cooking Oil 1L',           'PAN-002', 'Pantry',            105,  12),
  ('Soy Sauce 200ml',          'PAN-003', 'Pantry',             18,  24),
  ('Vinegar 200ml',            'PAN-004', 'Pantry',             15,  24),
  ('Iodized Salt 500g',        'PAN-005', 'Pantry',             12,  20),
  ('White Sugar 1kg',          'PAN-006', 'Pantry',             72,  20),
  ('Egg (each)',               'PAN-007', 'Pantry',             10,  90),
  ('Bath Soap 90g',            'PER-001', 'Personal Care',      30,  36),
  ('Shampoo Sachet',           'PER-002', 'Personal Care',       6, 120),
  ('Toothpaste 25ml',          'PER-003', 'Personal Care',      28,  24),
  ('Laundry Powder Sachet',    'HOU-001', 'Household',          10,  80),
  ('Laundry Bar Soap',         'HOU-002', 'Household',          30,  30),
  ('Dishwashing Paste 250g',   'HOU-003', 'Household',          38,  20)
) as v(name, sku, category, price, stock)
where not exists (select 1 from public.products p where lower(p.name) = lower(v.name));

commit;

select count(*) as products from public.products;
