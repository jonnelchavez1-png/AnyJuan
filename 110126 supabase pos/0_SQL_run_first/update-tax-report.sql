-- UPDATE: adds the Tax report to a shop that already ran setup.sql.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run. It is safe to run twice and changes no data.

begin;

-- get_tax_report: tax collected between two dates (both included, business time zone). Voided sales are left out.
--   "taxable" = sale lines that carried tax, "not taxable" = lines with no tax (exempt products, or tax switched off).
--   Amounts are net of tax, so taxable + not taxable + tax = total billed (after discounts).
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

  select jsonb_build_object(
           'orders', count(*), 'gross_sales', coalesce(sum(subtotal), 0), 'discounts', coalesce(sum(discount_amount), 0),
           'tax_collected', coalesce(sum(tax_amount), 0), 'billed', coalesce(sum(total), 0), 'net_sales', coalesce(sum(net_sales), 0))
    into v_tot
    from public.sales
   where status = 'completed' and occurred_at >= v_start and occurred_at < v_end;

  v_tot := v_tot || (
    select jsonb_build_object(
             'taxable_sales',     coalesce(sum(si.line_total - si.tax_amount) filter (where si.tax_amount > 0), 0),
             'not_taxable_sales', coalesce(sum(si.line_total - si.tax_amount) filter (where si.tax_amount = 0), 0))
      from public.sale_items si join public.sales s on s.id = si.sale_id
     where s.status = 'completed' and s.occurred_at >= v_start and s.occurred_at < v_end);

  select coalesce(jsonb_agg(t order by t.tax_name, t.tax_rate), '[]'::jsonb) into v_rates
    from (select coalesce(s.tax_name, 'No tax') as tax_name, s.tax_rate, s.tax_mode,
                 count(distinct s.id) as orders,
                 coalesce(sum(si.line_total - si.tax_amount) filter (where si.tax_amount > 0), 0) as taxable_sales,
                 coalesce(sum(si.line_total - si.tax_amount) filter (where si.tax_amount = 0), 0) as not_taxable_sales,
                 coalesce(sum(si.tax_amount), 0) as tax
            from public.sales s join public.sale_items si on si.sale_id = s.id
           where s.status = 'completed' and s.occurred_at >= v_start and s.occurred_at < v_end
           group by coalesce(s.tax_name, 'No tax'), s.tax_rate, s.tax_mode) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date', d.day, 'orders', coalesce(x.orders, 0), 'net_sales', coalesce(x.net, 0),
           'tax', coalesce(x.tax, 0), 'billed', coalesce(x.billed, 0)) order by d.day), '[]'::jsonb)
    into v_days
    from (select g::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
    left join (select (occurred_at at time zone v_tz)::date as day, count(*) as orders, sum(net_sales) as net,
                      sum(tax_amount) as tax, sum(total) as billed
                 from public.sales
                where status = 'completed' and occurred_at >= v_start and occurred_at < v_end
                group by 1) x on x.day = d.day;

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
select 'Tax report installed' as result;
