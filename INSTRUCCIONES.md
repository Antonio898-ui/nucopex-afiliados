# Nucopex Afiliados — Instrucciones de despliegue

## Resumen
- **Admin** → `/` (con contraseña)
- **Registro afiliados** → `/register` (público)
- **Portal afiliado** → `/portal` (con su código)

---

## PASO 1 — Crear base de datos en Supabase (gratis)

1. Ve a https://supabase.com → **Start your project** → crea cuenta
2. Crea un nuevo proyecto (elige región Europa)
3. Ve a **SQL Editor** y ejecuta todo el contenido de `setup.sql`
4. Ve a **Project Settings → API** y copia:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (no la anon key) → `SUPABASE_SERVICE_KEY`

---

## PASO 2 — Subir el código a GitHub

1. Ve a https://github.com → New repository → llámalo `nucopex-afiliados`
2. En tu Mac, abre Terminal en la carpeta `nucopex-afiliados`:
   ```bash
   cd "/Users/mac/Desktop/web nucopex/nucopex-afiliados"
   git init
   git add .
   git commit -m "Nucopex afiliados"
   git remote add origin https://github.com/TU_USUARIO/nucopex-afiliados.git
   git push -u origin main
   ```

---

## PASO 3 — Desplegar en Render (gratis)

1. Ve a https://render.com → crea cuenta con GitHub
2. **New → Web Service** → conecta el repo `nucopex-afiliados`
3. Configuración:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. En **Environment Variables** añade:
   | Variable | Valor |
   |---|---|
   | `SUPABASE_URL` | URL de Supabase |
   | `SUPABASE_SERVICE_KEY` | service_role key |
   | `SHOPIFY_WEBHOOK_SECRET` | (ver Paso 4) |
   | `ADMIN_PASSWORD` | contraseña que elijas |
   | `SITE_URL` | https://nucopex-afiliados.onrender.com |
5. Click **Deploy** — en ~2 minutos estará online

---

## PASO 4 — Configurar webhook en Shopify

1. En Shopify Admin → **Configuración → Notificaciones → Webhooks**
2. **Crear webhook**:
   - Evento: **Pago del pedido**
   - Formato: JSON
   - URL: `https://nucopex-afiliados.onrender.com/webhook/order`
3. Copia el **Secreto de firma** → ponlo como `SHOPIFY_WEBHOOK_SECRET` en Render

---

## PASO 5 — Instalar snippet de seguimiento en Shopify

1. Shopify Admin → **Tienda online → Temas → ··· → Editar código**
2. Abre `layout/theme.liquid`
3. Pega justo antes de `</body>`:

```html
<script>
(function() {
  var ref = new URLSearchParams(window.location.search).get('ref');
  if (ref) {
    ref = ref.toUpperCase().replace(/[^A-Z0-9]/g, '');
    document.cookie = 'nucopex_ref=' + ref + '; path=/; max-age=2592000; SameSite=Lax';
  }
  var stored = document.cookie.split('; ').reduce(function(acc, c) {
    var p = c.split('='); return p[0] === 'nucopex_ref' ? p[1] : acc;
  }, null);
  if (stored) {
    fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: { 'Afiliado': stored } })
    });
  }
})();
</script>
```

---

## Cómo funciona el día a día

### Auto-registrados (clientes normales)
- Se registran en `/register` → obtienen código → comparten enlace
- Cuando alguien compra con su enlace → reciben **15€ de descuento** en siguiente pedido
- Ven sus estadísticas en `/portal` con su código

### VIP (añadidos por ti desde admin)
- Los añades tú desde el panel admin con código personalizado
- Reciben **15€ por primera compra** + **1% de cada compra recurrente** del mismo cliente
- Eligen si cobrar por IBAN o descuento en tienda desde su portal

### Tú (admin)
- Entras en `/` con tu contraseña
- Ves todas las comisiones pendientes
- Marcas como pagadas cuando hagas la transferencia o generes el descuento en Shopify
