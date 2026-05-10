const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');

const app = express();

// Raw body for webhook signature verification (must be before express.json)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ADMIN_PASSWORD       = process.env.ADMIN_PASSWORD;
const SHOPIFY_SECRET       = process.env.SHOPIFY_WEBHOOK_SECRET;
const SITE_URL             = process.env.SITE_URL || 'http://localhost:3000';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;          // p.ej. nucopex.myshopify.com
const SHOPIFY_ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;           // shpat_xxx (Custom App con write_orders)
const KLAVIYO_API_KEY      = process.env.KLAVIYO_API_KEY;               // opcional, para notificar al afiliado
const SHOPIFY_API_VERSION  = '2024-10';

// ── Middleware ────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalize(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function uniqueCode(base) {
  base = normalize(base.split(' ')[0]).slice(0, 8);
  for (let i = 0; i <= 99; i++) {
    const code = i === 0 ? base : `${base}${i}`;
    const { data } = await supabase.from('affiliates').select('id').eq('code', code).maybeSingle();
    if (!data) return code;
  }
  return base + Date.now().toString().slice(-4);
}

// ── Páginas ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  // Si llega un ?ref=X (link de afiliado mal copiado), redirigir a la tienda
  const ref = req.query.ref;
  if (ref) {
    const clean = String(ref).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean) return res.redirect(302, `https://nucopex.com/?ref=${clean}`);
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/register', (_, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/portal',   (_, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));

// ── API: Auto-registro ────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Nombre y email son obligatorios' });

  const code = await uniqueCode(name);
  const { data, error } = await supabase.from('affiliates').insert({
    name: name.trim(), email: email.trim().toLowerCase(),
    phone: phone?.trim() || null, code,
    type: 'self', has_recurring: false, reward_preference: 'discount',
  }).select().maybeSingle();

  if (error) return res.status(500).json({ error: 'Error al registrar. Inténtalo de nuevo.' });
  res.json({ code: data.code, name: data.name, link: `https://nucopex.com/?ref=${data.code}` });
});

// ── API: Admin — Afiliados ────────────────────────────────────────────────────
app.get('/api/admin/affiliates', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('affiliates')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Enrich with commission counts
  const ids = data.map(a => a.id);
  const { data: commissions } = await supabase
    .from('commissions').select('affiliate_id, commission_amount, status').in('affiliate_id', ids);
  const { data: customers } = await supabase
    .from('referred_customers').select('affiliate_id').in('affiliate_id', ids);

  const enriched = data.map(a => {
    const ac = commissions.filter(c => c.affiliate_id === a.id);
    const pending = ac.filter(c => c.status === 'pending');
    const paid    = ac.filter(c => c.status === 'paid');
    return {
      ...a,
      customers_count: customers.filter(c => c.affiliate_id === a.id).length,
      pending_count:   pending.length,
      pending_amount:  pending.reduce((s, c) => s + Number(c.commission_amount), 0),
      paid_count:      paid.length,
      paid_amount:     paid.reduce((s, c) => s + Number(c.commission_amount), 0),
    };
  });
  res.json(enriched);
});

app.post('/api/admin/affiliates', adminAuth, async (req, res) => {
  const { name, email, phone, iban, code, has_recurring, reward_preference, notes } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Nombre y código son obligatorios' });

  const finalCode = normalize(code).slice(0, 12);
  const { data: existing } = await supabase.from('affiliates').select('id').eq('code', finalCode).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Ese código ya existe' });

  const { data, error } = await supabase.from('affiliates').insert({
    name: name.trim(), email: email?.trim().toLowerCase() || null,
    phone: phone?.trim() || null, iban: iban?.trim() || null,
    code: finalCode, type: 'manual',
    has_recurring: !!has_recurring,
    reward_preference: reward_preference || 'discount',
    notes: notes?.trim() || null,
  }).select().maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/affiliates/:id', adminAuth, async (req, res) => {
  const allowed = ['name','email','phone','iban','has_recurring','reward_preference','notes'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const { data, error } = await supabase.from('affiliates').update(updates).eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/affiliates/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('affiliates').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── API: Admin — Comisiones ───────────────────────────────────────────────────
app.get('/api/admin/commissions', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('commissions')
    .select(`*, affiliates(name, code, iban, reward_preference), referred_customers(customer_name, customer_email)`)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/commissions/:id', adminAuth, async (req, res) => {
  const { status } = req.body;
  const update = { status };
  if (status === 'paid')    update.paid_at = new Date().toISOString();
  if (status === 'pending') update.paid_at = null;
  const { data, error } = await supabase.from('commissions').update(update).eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── API: Admin — Stats ────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [{ data: affiliates }, { data: commissions }, { data: customers }] = await Promise.all([
    supabase.from('affiliates').select('id, type'),
    supabase.from('commissions').select('commission_amount, status'),
    supabase.from('referred_customers').select('id'),
  ]);
  const pending = commissions.filter(c => c.status === 'pending');
  const paid    = commissions.filter(c => c.status === 'paid');
  res.json({
    total:          affiliates.length,
    self:           affiliates.filter(a => a.type === 'self').length,
    manual:         affiliates.filter(a => a.type === 'manual').length,
    customers:      customers.length,
    pending_count:  pending.length,
    pending_amount: pending.reduce((s, c) => s + Number(c.commission_amount), 0),
    paid_count:     paid.length,
    paid_amount:    paid.reduce((s, c) => s + Number(c.commission_amount), 0),
  });
});

// ── API: Portal del afiliado ──────────────────────────────────────────────────
app.get('/api/portal/:code', async (req, res) => {
  const code = normalize(req.params.code);
  const { data: affiliate } = await supabase
    .from('affiliates').select('id,name,code,type,has_recurring,reward_preference,email,phone')
    .eq('code', code).maybeSingle();
  if (!affiliate) return res.status(404).json({ error: 'Código no encontrado' });

  const { data: customers } = await supabase
    .from('referred_customers').select('*').eq('affiliate_id', affiliate.id).order('created_at', { ascending: false });
  const { data: commissions } = await supabase
    .from('commissions').select('*').eq('affiliate_id', affiliate.id).order('created_at', { ascending: false });

  const pending = commissions.filter(c => c.status === 'pending');
  const paid    = commissions.filter(c => c.status === 'paid');

  res.json({
    affiliate,
    stats: {
      customers:      customers.length,
      total_earned:   commissions.reduce((s, c) => s + Number(c.commission_amount), 0),
      pending_amount: pending.reduce((s, c) => s + Number(c.commission_amount), 0),
      paid_amount:    paid.reduce((s, c) => s + Number(c.commission_amount), 0),
    },
    customers,
    commissions,
  });
});

// Update reward preference from portal
app.patch('/api/portal/:code/preference', async (req, res) => {
  const code = normalize(req.params.code);
  const { reward_preference } = req.body;
  if (!['discount','iban'].includes(reward_preference)) return res.status(400).json({ error: 'Preferencia inválida' });

  const { data: affiliate } = await supabase.from('affiliates').select('id,type').eq('code', code).maybeSingle();
  if (!affiliate) return res.status(404).json({ error: 'Código no encontrado' });
  if (affiliate.type !== 'manual') return res.status(403).json({ error: 'Solo afiliados VIP pueden elegir' });

  await supabase.from('affiliates').update({ reward_preference }).eq('id', affiliate.id);
  res.json({ ok: true });
});

// ── Helpers: Shopify Admin API ────────────────────────────────────────────────
async function shopifyAdmin(method, path, body) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    throw new Error('Shopify Admin API no configurado (faltan SHOPIFY_STORE_DOMAIN o SHOPIFY_ADMIN_TOKEN)');
  }
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Shopify ${method} ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function refundOrder(orderId, amount, note) {
  const { transactions } = await shopifyAdmin('GET', `/orders/${orderId}/transactions.json`);
  const parent = transactions?.find(t =>
    (t.kind === 'sale' || t.kind === 'capture') && t.status === 'success'
  );
  if (!parent) throw new Error(`No hay transacción capturada en pedido ${orderId}`);

  const { refund } = await shopifyAdmin('POST', `/orders/${orderId}/refunds.json`, {
    refund: {
      note,
      notify: true,
      transactions: [{
        kind:      'refund',
        gateway:   parent.gateway,
        amount:    amount.toFixed(2),
        parent_id: parent.id,
      }],
    },
  });
  return refund;
}

// ── Helpers: Klaviyo (opcional) ──────────────────────────────────────────────
async function trackKlaviyoEvent(email, metricName, properties) {
  if (!KLAVIYO_API_KEY || !email) return;
  try {
    await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type':  'application/json',
        'revision':      '2024-10-15',
      },
      body: JSON.stringify({
        data: {
          type: 'event',
          attributes: {
            properties,
            metric:  { data: { type: 'metric',  attributes: { name: metricName } } },
            profile: { data: { type: 'profile', attributes: { properties: { email } } } },
          },
        },
      }),
    });
  } catch (e) { console.error('Klaviyo event error:', e.message); }
}

// ── Lógica: pago automático de comisiones pendientes ──────────────────────────
async function processAffiliatePayout(order) {
  const customerEmail = order.email?.toLowerCase()?.trim();
  const orderId       = order.id?.toString();
  const orderAmount   = parseFloat(order.total_price || 0);
  if (!customerEmail || !orderId || orderAmount <= 0) return;

  // 1) ¿Este pedido ya pagó comisiones antes? (idempotencia ante reintentos de Shopify)
  const { data: alreadyPaid } = await supabase
    .from('commissions').select('id').eq('paid_via_order_id', orderId).limit(1);
  if (alreadyPaid?.length) return;

  // 2) ¿El cliente del pedido es un afiliado?
  const { data: affiliate } = await supabase
    .from('affiliates').select('*').eq('email', customerEmail).maybeSingle();
  if (!affiliate) return;

  // 3) Solo auto-reembolso si su preferencia es 'discount' (los de IBAN se pagan manual)
  if (affiliate.reward_preference !== 'discount') return;

  // 4) ¿Tiene comisiones pendientes?
  const { data: pending } = await supabase
    .from('commissions').select('*')
    .eq('affiliate_id', affiliate.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (!pending?.length) return;

  // 5) Calcular cuánto se puede reembolsar (sin pasarse del importe del pedido)
  const totalOwed   = pending.reduce((s, c) => s + Number(c.commission_amount), 0);
  const refundAmount = Math.min(totalOwed, orderAmount);
  if (refundAmount <= 0) return;

  // 6) Reembolsar en Shopify
  let refund;
  try {
    refund = await refundOrder(
      orderId,
      refundAmount,
      `Comisión de afiliado ${affiliate.code} (${pending.length} venta${pending.length > 1 ? 's' : ''})`
    );
  } catch (e) {
    console.error(`Refund FAIL afiliado=${affiliate.code} order=${orderId}:`, e.message);
    return;
  }

  // 7) Marcar como pagadas las comisiones que entren en el reembolso (FIFO)
  let remaining = refundAmount;
  const paidIds = [];
  let paidTotal = 0;
  for (const c of pending) {
    const amt = Number(c.commission_amount);
    if (amt <= remaining + 0.001) {
      paidIds.push(c.id);
      remaining -= amt;
      paidTotal += amt;
    }
  }
  if (paidIds.length) {
    await supabase.from('commissions').update({
      status:            'paid',
      paid_at:           new Date().toISOString(),
      paid_via_order_id: orderId,
      shopify_refund_id: refund.id?.toString() || null,
    }).in('id', paidIds);
  }

  console.log(`Payout OK afiliado=${affiliate.code} reembolso=${paidTotal}€ pedido=${orderId}`);

  // 8) Notificar al afiliado (opcional, vía Klaviyo)
  await trackKlaviyoEvent(affiliate.email, 'Comisión Pagada', {
    affiliate_code: affiliate.code,
    affiliate_name: affiliate.name,
    refund_amount:  paidTotal,
    order_id:       orderId,
    commissions_paid: paidIds.length,
  });
}

// ── Lógica: registrar nueva comisión por referido ─────────────────────────────
async function trackReferralCommission(order) {
  const customerEmail = order.email?.toLowerCase()?.trim();
  const orderAmount   = parseFloat(order.total_price || 0);
  const orderId       = order.id?.toString();
  const customerName  = [
    order.billing_address?.first_name,
    order.billing_address?.last_name,
  ].filter(Boolean).join(' ') || order.email;

  if (!customerEmail || !orderId) return;

  // ¿Ya registramos comisión por este pedido?
  const { data: dup } = await supabase
    .from('commissions').select('id').eq('shopify_order_id', orderId).maybeSingle();
  if (dup) return;

  // ¿Ya es cliente referido por alguien?
  const { data: existingRef } = await supabase
    .from('referred_customers')
    .select('*, affiliates(*)')
    .eq('customer_email', customerEmail)
    .maybeSingle();

  if (existingRef) {
    const affiliate = existingRef.affiliates;
    if (affiliate.has_recurring) {
      const commission = Math.round(orderAmount * 0.01 * 100) / 100;
      await supabase.from('commissions').insert({
        affiliate_id:         affiliate.id,
        referred_customer_id: existingRef.id,
        shopify_order_id:     orderId,
        order_amount:         orderAmount,
        commission_type:      'recurring',
        commission_amount:    commission,
        status:               'pending',
      });
    }
    return;
  }

  // Cliente nuevo — buscar código de afiliado en el pedido
  const refAttr = order.note_attributes?.find(a => a.name === 'Afiliado');
  const refCode = refAttr?.value ? normalize(refAttr.value) : null;
  if (!refCode) return;

  const { data: affiliate } = await supabase
    .from('affiliates').select('*').eq('code', refCode).maybeSingle();
  if (!affiliate) return;

  const { data: newRef } = await supabase.from('referred_customers').insert({
    affiliate_id:   affiliate.id,
    customer_email: customerEmail,
    customer_name:  customerName,
  }).select().maybeSingle();

  await supabase.from('commissions').insert({
    affiliate_id:         affiliate.id,
    referred_customer_id: newRef.id,
    shopify_order_id:     orderId,
    order_amount:         orderAmount,
    commission_type:      'flat',
    commission_amount:    15,
    status:               'pending',
  });
}

// ── Webhook Shopify: pedido pagado ────────────────────────────────────────────
app.post('/webhook/order', async (req, res) => {
  // Verify HMAC signature
  if (SHOPIFY_SECRET) {
    const hmac   = req.headers['x-shopify-hmac-sha256'];
    const digest = crypto.createHmac('sha256', SHOPIFY_SECRET).update(req.body).digest('base64');
    if (hmac !== digest) return res.status(401).send('Invalid signature');
  }

  let order;
  try { order = JSON.parse(req.body); } catch { return res.sendStatus(400); }

  // Responder rápido a Shopify; procesamos en segundo plano
  res.sendStatus(200);

  await Promise.all([
    trackReferralCommission(order).catch(e => console.error('Referral error:', e.message)),
    processAffiliatePayout(order).catch(e => console.error('Payout error:', e.message)),
  ]);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nucopex Afiliados → http://localhost:${PORT}`));
