-- Ejecuta esto en Supabase → SQL Editor

create table affiliates (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  email text,
  phone text,
  iban text,
  code text unique not null,
  type text default 'self' check (type in ('self','manual')),
  has_recurring boolean default false,
  reward_preference text default 'discount' check (reward_preference in ('discount','iban')),
  notes text,
  created_at timestamptz default now()
);

create table referred_customers (
  id uuid default gen_random_uuid() primary key,
  affiliate_id uuid references affiliates(id) on delete cascade,
  customer_email text not null,
  customer_name text,
  created_at timestamptz default now()
);

create table commissions (
  id uuid default gen_random_uuid() primary key,
  affiliate_id uuid references affiliates(id) on delete cascade,
  referred_customer_id uuid references referred_customers(id) on delete cascade,
  shopify_order_id text,
  order_amount numeric(10,2),
  commission_type text check (commission_type in ('flat','recurring')),
  commission_amount numeric(10,2),
  status text default 'pending' check (status in ('pending','paid')),
  paid_at timestamptz,
  created_at timestamptz default now()
);

-- Índices
create index on affiliates(code);
create index on referred_customers(customer_email);
create index on referred_customers(affiliate_id);
create index on commissions(affiliate_id);
create index on commissions(status);
