-- VITICO Wholesale: database for Supabase (Postgres)
-- Run this once in a new Supabase project: SQL Editor > New query > paste > Run.
--
-- Design rules:
--   * Prices, stock, credit, wallet and Deal Drop allocations are only ever changed by the
--     functions in this file, inside one transaction, so two buyers can never take the same stock.
--   * Row level security decides who can read what. A customer only sees their own company.

create schema if not exists app;   -- internal functions, not reachable from the API

-- ============================================================ tables

create table public.settings (
  id int primary key default 1 check (id = 1),
  contract_breaks boolean not null default true,   -- quantity breaks also apply to contract prices
  contract_promo  boolean not null default true,   -- promotions also apply to contract prices
  promo_mode text not null default 'stack' check (promo_mode in ('stack','best')),
  bond_pct numeric not null default 5,
  rebate_pct numeric not null default 1,
  target_rate_pct numeric not null default 1.5,
  rep_floor_pct numeric not null default 5,
  commission_pct numeric not null default 1.5
);
insert into public.settings default values;

create table public.tiers (
  name text primary key,
  discount_pct numeric not null default 0 check (discount_pct >= 0),
  sort int not null default 0
);
insert into public.tiers values ('Standard',0,1),('Plus',2,2),('VIP',4,3),('Partner',6,4);

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  adj_pct numeric not null default 0,
  sort int not null default 0
);
insert into public.zones (name, adj_pct, sort) values
  ('Viti Levu',0,1),('Vanua Levu',3,2),('Outer islands',6,3),('Export, FOB Suva',0,4);

create table public.qty_breaks (
  id uuid primary key default gen_random_uuid(),
  min_qty int not null unique check (min_qty > 0),
  off_pct numeric not null default 0 check (off_pct >= 0)
);
insert into public.qty_breaks (min_qty, off_pct) values (1,0),(10,2),(50,4),(100,6);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  pack text not null default '',
  category text not null default 'Other',
  base_price numeric not null default 0 check (base_price >= 0),
  fccc_ref numeric,
  promo_pct numeric not null default 0 check (promo_pct >= 0),
  cbm numeric not null default 0,
  kg numeric not null default 0,
  stock int not null default 0 check (stock >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text not null default '',
  role text not null default 'customer' check (role in ('customer','rep','admin')),
  customer_id uuid,
  company_role text not null default 'Owner',
  can_approve boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tier text not null default 'Standard' references public.tiers(name) on update cascade,
  zone_id uuid references public.zones(id),
  credit_limit numeric not null default 0,
  balance numeric not null default 0,
  terms text not null default 'Net 30',
  rep_id uuid references public.profiles(id) on delete set null,
  quarter_target numeric not null default 0,
  spend numeric not null default 0,
  saved numeric not null default 0,
  wallet_available numeric not null default 0,
  wallet_pending numeric not null default 0,
  created_at timestamptz not null default now()
);
alter table public.profiles add constraint profiles_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete set null;

create table public.contract_prices (
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  price numeric not null check (price > 0),
  primary key (customer_id, product_id)
);

create sequence public.order_number_seq start 1001;
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default 'VW-' || nextval('public.order_number_seq'),
  customer_id uuid not null references public.customers(id),
  placed_by uuid,
  type text not null default 'Order',
  status text not null default 'Submitted',
  po_number text,
  info text,
  pay_method text,
  payment_status text,
  total numeric not null default 0,
  charged numeric not null default 0,       -- amount added to the customer's account balance
  wallet_used numeric not null default 0,
  rebate numeric not null default 0,
  rebate_released boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.orders (customer_id, created_at desc);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty int not null check (qty > 0),
  unit_price numeric not null default 0
);
create index on public.order_lines (order_id);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit_price numeric not null check (unit_price > 0),
  allocation int not null check (allocation > 0),
  remaining int not null check (remaining >= 0),
  max_per_customer int not null check (max_per_customer > 0),
  tiers text[],                              -- null means every tier can buy
  per text not null default 'carton',
  note text,
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table public.deal_lines (
  deal_id uuid not null references public.deals(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty int not null default 1 check (qty > 0),
  primary key (deal_id, product_id)
);
create table public.deal_reservations (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  order_id uuid references public.orders(id) on delete cascade,
  qty int not null check (qty > 0),
  bond numeric not null default 0,
  created_at timestamptz not null default now()
);

create table public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount numeric not null,
  description text not null,
  created_at timestamptz not null default now()
);

create table public.container_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  max_cbm numeric not null check (max_cbm > 0),
  max_kg numeric not null check (max_kg > 0),
  sort int not null default 0
);
insert into public.container_types (name, max_cbm, max_kg, sort) values ('20FT',33,28000,1),('40FT',67,26500,2);

create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
insert into public.destinations (name) values
  ('Nukuʻalofa, Tonga'),('Apia, Samoa'),('Port Vila, Vanuatu'),('Funafuti, Tuvalu'),('Tarawa, Kiribati');

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  contact text, email text, phone text,
  zone_id uuid references public.zones(id) on delete set null,
  note text,
  status text not null default 'Pending',
  created_at timestamptz not null default now()
);

create table public.price_requests (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid references public.profiles(id) on delete set null,
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  price numeric not null check (price > 0),
  normal_price numeric not null,
  reason text not null,
  status text not null default 'Pending',
  decided_by uuid,
  created_at timestamptz not null default now()
);

-- Filled by the accounting integration (Zoho Books) once it is connected.
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  number text not null,
  issued_on date not null default current_date,
  due_on date,
  amount numeric not null default 0,
  status text not null default 'Due',
  pdf_url text
);

-- ============================================================ who is asking

create function public.my_role() returns text
  language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() $$;

create function public.my_customer() returns uuid
  language sql stable security definer set search_path = public as
$$ select customer_id from profiles where id = auth.uid() $$;

create function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'admin' from profiles where id = auth.uid()), false) $$;

-- Admins see every customer, reps see the customers assigned to them, customers see their own company.
create function public.can_see_customer(c uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select c is not null and (
     public.is_admin()
     or c = public.my_customer()
     or exists (select 1 from customers x join profiles p on p.id = auth.uid()
                where x.id = c and x.rep_id = p.id and p.role = 'rep')) $$;

-- Every new login gets a profile. If they signed up through the trade account form,
-- their application is filed at the same time.
create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); z uuid;
begin
  insert into profiles (id, email, full_name) values (new.id, new.email, left(coalesce(m->>'full_name',''), 120));
  if coalesce(m->>'business_name','') <> '' then
    begin z := (m->>'zone_id')::uuid; exception when others then z := null; end;
    if z is not null and not exists (select 1 from zones where id = z) then z := null; end if;
    insert into applications (user_id, business_name, contact, email, phone, zone_id, note)
    values (new.id, left(m->>'business_name',160), left(m->>'full_name',120), new.email, left(m->>'phone',40), z, left(m->>'note',1000));
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================ pricing engine

-- The single place a price is worked out. Returns the unit price at p_qty, the steps that
-- led to it, and the price at every quantity break so screens can show the ladder.
create function app.price_calc(p_customer uuid, p_product uuid, p_qty int default 1, p_ignore_contract boolean default false)
  returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c customers; p products; s settings; z zones;
  v numeric; con numeric; t numeric; is_con boolean := false; use_b boolean; promo numeric;
  steps jsonb := '[]'::jsonb; ladder jsonb := '[]'::jsonb; b record; bo numeric; pm numeric; u numeric; cur numeric;
begin
  select * into c from customers where id = p_customer;
  if not found then raise exception 'Customer not found'; end if;
  select * into p from products where id = p_product;
  if not found then raise exception 'Product not found'; end if;
  select * into s from settings where id = 1;
  select * into z from zones where id = c.zone_id;

  if not p_ignore_contract then
    select price into con from contract_prices where customer_id = c.id and product_id = p.id;
  end if;
  if con is not null then                    -- a contract price replaces standard, tier and zone
    v := con; is_con := true;
    steps := steps || jsonb_build_object('label','Your contract price','value',round(v,2));
  else
    v := p.base_price;
    steps := steps || jsonb_build_object('label','Standard price','value',round(v,2));
    select discount_pct into t from tiers where name = c.tier;
    if coalesce(t,0) > 0 then
      v := v * (1 - t/100);
      steps := steps || jsonb_build_object('label', c.tier || ' tier −' || (t::float8)::text || '%', 'value', round(v,2));
    end if;
    if coalesce(z.adj_pct,0) <> 0 then
      v := v * (1 + z.adj_pct/100);
      steps := steps || jsonb_build_object('label', z.name || ' zone +' || (z.adj_pct::float8)::text || '%', 'value', round(v,2));
    end if;
  end if;

  use_b := (not is_con) or s.contract_breaks;
  promo := case when (not is_con) or s.contract_promo then p.promo_pct else 0 end;
  for b in
    select min_qty, off_pct from qty_breaks where use_b
    union all
    select 1, 0 where not use_b or not exists (select 1 from qty_breaks where min_qty = 1)
    order by 1
  loop
    bo := b.off_pct; pm := promo;
    if s.promo_mode = 'best' then
      if pm > bo then bo := 0; else pm := 0; end if;
    end if;
    u := round(v * (1 - bo/100) * (1 - pm/100), 2);
    ladder := ladder || jsonb_build_object('min', b.min_qty, 'unit', u, 'off', bo, 'promo', pm);
    if greatest(p_qty,1) >= b.min_qty then cur := u; end if;
  end loop;

  return jsonb_build_object('unit', cur, 'pre', round(v,2), 'contract', is_con, 'steps', steps, 'ladder', ladder,
    'ref', case when p.fccc_ref is not null then round(p.fccc_ref * (1 + coalesce(z.adj_pct,0)/100), 2) end);
end $$;

-- The catalogue with this customer's prices.
create function public.catalogue(p_customer uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare v uuid := coalesce(p_customer, public.my_customer());
begin
  if not public.can_see_customer(v) then raise exception 'You cannot see prices for this customer'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('pricing', app.price_calc(v, p.id, 1)) order by p.category, p.name), '[]'::jsonb)
          from products p where p.active);
end $$;

-- One price, for the admin price checker and the sales rep screen.
create function public.quote(p_customer uuid, p_product uuid, p_qty int default 1, p_ignore_contract boolean default false) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_see_customer(p_customer) then raise exception 'You cannot see prices for this customer'; end if;
  return app.price_calc(p_customer, p_product, p_qty, p_ignore_contract);
end $$;

-- ============================================================ ordering

-- p_items: [{"product_id": "...", "qty": 10}, ...]
-- p_opts:  {"po": "", "fulfilment": "", "notes": "", "pay": "account|mpaisa|bank", "use_wallet": false,
--           "container_type": "<id>", "destination": "..."}   (the last two make it a container order)
create function public.place_order(p_items jsonb, p_opts jsonb default '{}'::jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  c customers; s settings; p products; ct container_types; o orders; it record; pr jsonb;
  unit numeric; total numeric := 0; v_saved numeric := 0; cbm numeric := 0; kg numeric := 0;
  lines jsonb := '[]'::jsonb; l jsonb; v_use numeric := 0; due numeric; reb numeric;
  pay text := coalesce(nullif(p_opts->>'pay',''), 'account');
  is_cont boolean := coalesce(p_opts->>'container_type','') <> '';
begin
  if public.my_customer() is null then raise exception 'Your login is not linked to a customer account'; end if;
  if pay not in ('account','mpaisa','bank') then raise exception 'Unknown payment method'; end if;
  select * into c from customers where id = public.my_customer() for update;
  select * into s from settings where id = 1;

  for it in
    select (e->>'product_id')::uuid as pid, sum((e->>'qty')::int)::int as qty
    from jsonb_array_elements(p_items) e group by 1 having sum((e->>'qty')::int) > 0 order by 1
  loop
    select * into p from products where id = it.pid and active for update;
    if not found then raise exception 'A product in this order is no longer available'; end if;
    if p.stock < it.qty then raise exception 'Only % cartons of % are available', p.stock, p.name; end if;
    pr := app.price_calc(c.id, p.id, it.qty);
    unit := (pr->>'unit')::numeric;
    total := total + unit * it.qty;
    if pr->>'ref' is not null then v_saved := v_saved + greatest((pr->>'ref')::numeric - unit, 0) * it.qty; end if;
    cbm := cbm + p.cbm * it.qty; kg := kg + p.kg * it.qty;
    lines := lines || jsonb_build_object('pid', p.id, 'qty', it.qty, 'unit', unit);
    update products set stock = stock - it.qty where id = p.id;
  end loop;
  if jsonb_array_length(lines) = 0 then raise exception 'The order is empty'; end if;
  total := round(total, 2);

  if is_cont then
    select * into ct from container_types where id = (p_opts->>'container_type')::uuid;
    if not found then raise exception 'Unknown container type'; end if;
    if cbm > ct.max_cbm then raise exception 'This load is % CBM and a % holds %', round(cbm,2), ct.name, ct.max_cbm; end if;
    if kg > ct.max_kg then raise exception 'This load is % kg and a % carries %', round(kg), ct.name, ct.max_kg; end if;
    pay := 'account';
  elsif coalesce((p_opts->>'use_wallet')::boolean, false) then
    v_use := least(c.wallet_available, total);
  end if;
  due := total - v_use;
  if pay = 'account' and due > c.credit_limit - c.balance then
    raise exception 'This order is % over your available credit', round(due - (c.credit_limit - c.balance), 2);
  end if;
  reb := round(total * s.rebate_pct / 100, 2);

  insert into orders (customer_id, placed_by, type, status, po_number, info, pay_method, payment_status, total, charged, wallet_used, rebate)
  values (c.id, auth.uid(), case when is_cont then 'Container' else 'Order' end, 'Submitted',
    left(p_opts->>'po', 80),
    case when is_cont then ct.name || ' to ' || coalesce(p_opts->>'destination','') || '. ' || round(cbm,2) || ' CBM, ' || round(kg) || ' kg'
         else left(concat_ws('. ', nullif(p_opts->>'fulfilment',''), nullif(p_opts->>'notes','')), 1000) end,
    pay, case when due = 0 then 'Paid' when pay = 'account' then 'On account' else 'Awaiting payment' end,
    total, case when pay = 'account' then due else 0 end, v_use, reb)
  returning * into o;
  for l in select * from jsonb_array_elements(lines) loop
    insert into order_lines (order_id, product_id, qty, unit_price) values (o.id, (l->>'pid')::uuid, (l->>'qty')::int, (l->>'unit')::numeric);
  end loop;

  update customers set balance = balance + o.charged, wallet_available = wallet_available - v_use,
    wallet_pending = wallet_pending + reb, spend = spend + total, saved = saved + round(v_saved, 2)
  where id = c.id;
  if v_use > 0 then
    insert into wallet_ledger (customer_id, amount, description) values (c.id, -v_use, 'Used on order ' || o.number);
  end if;
  return jsonb_build_object('id', o.id, 'number', o.number, 'total', total);
end $$;

-- Secure a Deal Drop. The deal row is locked first, so competing buyers queue up and the
-- allocation can never be sold twice.
create function public.secure_deal(p_deal uuid, p_qty int, p_pay text default 'bank') returns jsonb
  language plpgsql security definer set search_path = public as $$
declare c customers; d deals; s settings; o orders; l record; taken int; tot numeric; bond numeric; reb numeric;
begin
  if public.my_customer() is null then raise exception 'Your login is not linked to a customer account'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Choose a quantity'; end if;
  if p_pay not in ('wallet','mpaisa','bank') then raise exception 'Unknown payment method'; end if;
  select * into d from deals where id = p_deal for update;
  if not found then raise exception 'Deal not found'; end if;
  if d.ends_at <= now() then raise exception 'This deal has ended'; end if;
  select * into c from customers where id = public.my_customer() for update;
  select * into s from settings where id = 1;
  if d.tiers is not null and not (c.tier = any (d.tiers)) then raise exception 'This deal is not open to your tier'; end if;
  if p_qty > d.remaining then raise exception 'Only % left', d.remaining; end if;
  select coalesce(sum(qty),0) into taken from deal_reservations where deal_id = d.id and customer_id = c.id;
  if taken + p_qty > d.max_per_customer then raise exception 'The limit is % per customer and you have already secured %', d.max_per_customer, taken; end if;

  tot := round(d.unit_price * p_qty, 2);
  bond := round(tot * s.bond_pct / 100, 2);
  reb := round(tot * s.rebate_pct / 100, 2);
  if p_pay = 'wallet' and c.wallet_available < bond then raise exception 'There is not enough in your rebate wallet for the bond'; end if;

  for l in select dl.product_id, dl.qty, p.name, p.stock from deal_lines dl join products p on p.id = dl.product_id
           where dl.deal_id = d.id order by dl.product_id for update of p loop
    if l.stock < l.qty * p_qty then raise exception 'Not enough stock of % for this deal', l.name; end if;
    update products set stock = stock - l.qty * p_qty where id = l.product_id;
  end loop;
  update deals set remaining = remaining - p_qty where id = d.id;

  insert into orders (customer_id, placed_by, type, status, info, pay_method, payment_status, total, wallet_used, rebate)
  values (c.id, auth.uid(), 'Deal Drop', 'Reserved', d.name || '. Security bond ' || bond, p_pay,
    case when p_pay = 'wallet' then 'Bond paid' else 'Awaiting bond payment' end, tot, case when p_pay = 'wallet' then bond else 0 end, reb)
  returning * into o;
  insert into order_lines (order_id, product_id, qty, unit_price)
    select o.id, product_id, qty * p_qty, 0 from deal_lines where deal_id = d.id;
  insert into deal_reservations (deal_id, customer_id, order_id, qty, bond) values (d.id, c.id, o.id, p_qty, bond);

  update customers set spend = spend + tot, wallet_pending = wallet_pending + reb,
    wallet_available = wallet_available - case when p_pay = 'wallet' then bond else 0 end where id = c.id;
  if p_pay = 'wallet' then
    insert into wallet_ledger (customer_id, amount, description) values (c.id, -bond, 'Deal Drop bond for ' || d.name);
  end if;
  return jsonb_build_object('id', o.id, 'number', o.number, 'total', tot, 'bond', bond);
end $$;

-- ============================================================ staff actions

create function public.set_order_status(p_order uuid, p_status text) returns void
  language plpgsql security definer set search_path = public as $$
declare o orders; r record;
begin
  if not public.is_admin() then raise exception 'Only an admin can change an order'; end if;
  if p_status not in ('Submitted','Confirmed','Processing','Ready','Dispatched','Completed','On hold','Partially fulfilled','Reserved','Cancelled') then
    raise exception 'Unknown status'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'Cancelled' then raise exception 'A cancelled order cannot be reopened'; end if;
  if o.status = p_status then return; end if;

  if p_status = 'Cancelled' then
    if o.status = 'Completed' then raise exception 'A completed order cannot be cancelled'; end if;
    update products p set stock = p.stock + x.qty
      from (select product_id, sum(qty) as qty from order_lines where order_id = o.id group by 1) x where p.id = x.product_id;
    update customers set balance = balance - o.charged, wallet_available = wallet_available + o.wallet_used,
      wallet_pending = greatest(wallet_pending - o.rebate, 0), spend = greatest(spend - o.total, 0) where id = o.customer_id;
    if o.wallet_used > 0 then
      insert into wallet_ledger (customer_id, amount, description) values (o.customer_id, o.wallet_used, 'Refund for cancelled order ' || o.number);
    end if;
    for r in select * from deal_reservations where order_id = o.id loop
      update deals set remaining = remaining + r.qty where id = r.deal_id;
    end loop;
    delete from deal_reservations where order_id = o.id;
  elsif p_status = 'Completed' and not o.rebate_released then
    update customers set wallet_pending = greatest(wallet_pending - o.rebate, 0), wallet_available = wallet_available + o.rebate where id = o.customer_id;
    if o.rebate > 0 then
      insert into wallet_ledger (customer_id, amount, description) values (o.customer_id, o.rebate, 'Rebate released for order ' || o.number);
    end if;
    update orders set rebate_released = true where id = o.id;
  end if;
  update orders set status = p_status where id = o.id;
end $$;

create function public.set_order_paid(p_order uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can confirm a payment'; end if;
  update orders set payment_status = case when type = 'Deal Drop' then 'Bond paid' else 'Paid' end
    where id = p_order and payment_status in ('Awaiting payment','Awaiting bond payment');
end $$;

create function public.adjust_wallet(p_customer uuid, p_amount numeric, p_description text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can adjust a wallet'; end if;
  if coalesce(p_amount,0) = 0 or coalesce(p_description,'') = '' then raise exception 'Enter an amount and a description'; end if;
  update customers set wallet_available = wallet_available + p_amount where id = p_customer;
  if not found then raise exception 'Customer not found'; end if;
  insert into wallet_ledger (customer_id, amount, description) values (p_customer, p_amount, left(p_description, 200));
end $$;

create function public.decide_application(p_id uuid, p_approve boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare a applications; cid uuid;
begin
  if not public.is_admin() then raise exception 'Only an admin can decide an application'; end if;
  select * into a from applications where id = p_id and status = 'Pending' for update;
  if not found then raise exception 'Application not found or already decided'; end if;
  if p_approve then
    insert into customers (name, zone_id, tier) values (a.business_name, a.zone_id, (select name from tiers order by sort, name limit 1))
      returning id into cid;
    update profiles set customer_id = cid, role = 'customer', company_role = 'Owner', can_approve = true where id = a.user_id;
  end if;
  update applications set status = case when p_approve then 'Approved' else 'Declined' end where id = a.id;
end $$;

create function public.create_deal(p_name text, p_lines jsonb, p_price numeric, p_allocation int, p_max int, p_hours numeric, p_tiers text[] default null, p_note text default null)
  returns uuid language plpgsql security definer set search_path = public as $$
declare did uuid; n int; units int;
begin
  if not public.is_admin() then raise exception 'Only an admin can create a deal'; end if;
  if coalesce(p_name,'') = '' or coalesce(p_hours,0) <= 0 then raise exception 'Enter a name and a running time'; end if;
  select count(*), coalesce(sum((e->>'qty')::int),0) into n, units from jsonb_array_elements(p_lines) e;
  if n = 0 then raise exception 'Add at least one product'; end if;
  insert into deals (name, unit_price, allocation, remaining, max_per_customer, tiers, per, note, ends_at)
  values (p_name, p_price, p_allocation, p_allocation, p_max, case when cardinality(p_tiers) > 0 then p_tiers end,
          case when units > 1 then 'combo' else 'carton' end, p_note, now() + make_interval(secs => p_hours * 3600))
  returning id into did;
  insert into deal_lines (deal_id, product_id, qty)
    select did, (e->>'product_id')::uuid, sum((e->>'qty')::int) from jsonb_array_elements(p_lines) e group by 2;
  return did;
end $$;

-- A rep offers one customer a special price. Within the rep's limit it applies immediately;
-- below it, the request waits for an admin.
create function public.request_price(p_customer uuid, p_product uuid, p_price numeric, p_reason text) returns text
  language plpgsql security definer set search_path = public as $$
declare s settings; n numeric; st text;
begin
  if public.my_role() not in ('rep','admin') or not public.can_see_customer(p_customer) then
    raise exception 'This customer is not assigned to you'; end if;
  if coalesce(p_price,0) <= 0 or coalesce(trim(p_reason),'') = '' then raise exception 'Enter a price and a reason'; end if;
  select * into s from settings where id = 1;
  n := (app.price_calc(p_customer, p_product, 1, true)->>'unit')::numeric;
  st := case when p_price >= round(n * (1 - s.rep_floor_pct/100), 2) then 'Applied' else 'Pending' end;
  insert into price_requests (rep_id, customer_id, product_id, price, normal_price, reason, status)
    values (auth.uid(), p_customer, p_product, p_price, n, left(trim(p_reason), 500), st);
  if st = 'Applied' then
    insert into contract_prices (customer_id, product_id, price) values (p_customer, p_product, p_price)
      on conflict (customer_id, product_id) do update set price = excluded.price;
  end if;
  return st;
end $$;

create function public.decide_price_request(p_id uuid, p_approve boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare r price_requests;
begin
  if not public.is_admin() then raise exception 'Only an admin can decide a price request'; end if;
  select * into r from price_requests where id = p_id and status = 'Pending' for update;
  if not found then raise exception 'Request not found or already decided'; end if;
  if p_approve then
    insert into contract_prices (customer_id, product_id, price) values (r.customer_id, r.product_id, r.price)
      on conflict (customer_id, product_id) do update set price = excluded.price;
  end if;
  update price_requests set status = case when p_approve then 'Approved' else 'Declined' end, decided_by = auth.uid() where id = r.id;
end $$;

-- ============================================================ row level security

alter table public.settings          enable row level security;
alter table public.tiers             enable row level security;
alter table public.zones             enable row level security;
alter table public.qty_breaks        enable row level security;
alter table public.products          enable row level security;
alter table public.profiles          enable row level security;
alter table public.customers         enable row level security;
alter table public.contract_prices   enable row level security;
alter table public.orders            enable row level security;
alter table public.order_lines       enable row level security;
alter table public.deals             enable row level security;
alter table public.deal_lines        enable row level security;
alter table public.deal_reservations enable row level security;
alter table public.wallet_ledger     enable row level security;
alter table public.container_types   enable row level security;
alter table public.destinations      enable row level security;
alter table public.applications      enable row level security;
alter table public.price_requests    enable row level security;
alter table public.invoices          enable row level security;

-- Reference data: any logged-in user reads, only admins change.
create policy read_all  on public.settings        for select to authenticated using (true);
create policy admin_all on public.settings        for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_all  on public.tiers           for select to authenticated using (true);
create policy admin_all on public.tiers           for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_all  on public.zones           for select to anon, authenticated using (true);   -- the sign-up form lists zones
create policy admin_all on public.zones           for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_all  on public.qty_breaks      for select to authenticated using (true);
create policy admin_all on public.qty_breaks      for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_all  on public.container_types for select to authenticated using (true);
create policy admin_all on public.container_types for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_all  on public.destinations    for select to authenticated using (true);
create policy admin_all on public.destinations    for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_all  on public.deals           for select to authenticated using (true);
create policy admin_all on public.deals           for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_all  on public.deal_lines      for select to authenticated using (true);
create policy admin_all on public.deal_lines      for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_active on public.products      for select to authenticated using (active or public.my_role() in ('admin','rep'));
create policy admin_all on public.products        for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- People: yourself, your company colleagues, the sales reps, and for a rep the people at their customers.
create policy read_profiles on public.profiles for select to authenticated using (
  id = auth.uid() or public.is_admin() or role = 'rep'
  or (customer_id is not null and (customer_id = public.my_customer() or public.can_see_customer(customer_id))));
create policy admin_update on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Company data: only that company, its rep, and admins.
create policy read_own  on public.customers         for select to authenticated using (public.can_see_customer(id));
create policy admin_all on public.customers         for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_own  on public.contract_prices   for select to authenticated using (public.can_see_customer(customer_id));
create policy admin_all on public.contract_prices   for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_own  on public.orders            for select to authenticated using (public.can_see_customer(customer_id));
create policy read_own  on public.order_lines       for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id and public.can_see_customer(o.customer_id)));
create policy read_own  on public.deal_reservations for select to authenticated using (public.can_see_customer(customer_id));
create policy read_own  on public.wallet_ledger     for select to authenticated using (public.can_see_customer(customer_id));
create policy read_own  on public.invoices          for select to authenticated using (public.can_see_customer(customer_id));
create policy admin_all on public.invoices          for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy read_own  on public.applications      for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy read_own  on public.price_requests    for select to authenticated using (rep_id = auth.uid() or public.is_admin());

-- ============================================================ API access

grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon;
grant select on public.zones to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on schema app from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;
