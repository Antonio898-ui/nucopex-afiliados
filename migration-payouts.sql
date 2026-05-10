-- Ejecuta esto en Supabase → SQL Editor (una sola vez)
-- Añade columnas para rastrear los reembolsos automáticos

alter table commissions add column if not exists paid_via_order_id text;
alter table commissions add column if not exists shopify_refund_id text;

create index if not exists commissions_paid_via_order_id_idx on commissions(paid_via_order_id);
