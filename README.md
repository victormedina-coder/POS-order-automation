# POS Order Automation — Shopify → NetSuite

Servidor Node.js con interfaz web que exporta los pedidos POS de Shopify a un CSV
listo para importar en NetSuite. Reemplaza el Google Apps Script original. Incluye
catálogo de SKUs/sucursales en SQLite, autenticación con Google OAuth restringida por
dominio, y enriquecimiento opcional de la columna UUID vía la API de Facturama.

## Stack

- **Runtime:** Node.js 22 (usa `node:sqlite` nativo con `--experimental-sqlite`)
- **Framework:** Fastify 5
- **Base de datos:** SQLite (`node:sqlite`) — catálogo de items y sucursales
- **Auth:** Google OAuth 2.0 (`@fastify/oauth2`) con restricción por dominio
- **Sesiones:** `@fastify/session` + `@fastify/cookie` (cookie firmada)
- **Seguridad:** `@fastify/helmet` (CSP) + `@fastify/rate-limit`
- **Uploads:** `@fastify/multipart` + `csv-parse` (importación de catálogo)
- **Integraciones:** Shopify GraphQL Admin API · Facturama API (CFDI)
- **Deploy:** Railway

## Requisitos

- Node.js >= 22 < 23
- Credenciales de Google OAuth (Cloud Console)
- Access token de Shopify Admin API
- (Opcional) Credenciales de la API de Facturama

## Setup

```bash
npm install
cp .env.example .env   # y rellena las variables (ver abajo)
npm run dev            # servidor con --watch en http://localhost:3000
```

### Variables de entorno

```
# Shopify
SHOPIFY_STORE=
SHOPIFY_ACCESS_TOKEN=

# Auth
ALLOWED_DOMAIN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SESSION_SECRET=            # mínimo 32 caracteres (se valida al arrancar)

# Servidor
PORT=3000
BASE_URL=http://localhost:3000   # en prod: https://<tu-app>.up.railway.app
DATABASE_PATH=./data/catalog.db  # en Railway: /data/catalog.db

# Facturama (opcional — enriquece la columna UUID)
FACTURAMA_USER=
FACTURAMA_PASS=
FACTURAMA_BASE_URL=

# Solo desarrollo local — IGNORADO en producción
SKIP_AUTH=false
```

## Scripts

```bash
npm run dev                                                   # servidor con --watch
npm start                                                     # producción
npm run import-catalog -- --file items.csv --table items      # importar catálogo por CLI
npm run import-catalog -- --file sucursales.csv --table locations
npm run import-catalog -- --file pagos.csv --table payment_methods
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/pos-export` | Interfaz web |
| GET | `/pos-export/locations` | Sucursales para el selector |
| POST | `/pos-export/preview` | Vista previa de pedidos (paso "Consultar") |
| POST | `/pos-export/download` | Descarga del CSV (paso "Descargar") |
| GET | `/pos-export/uuids` | UUIDs de Facturama por fecha (opcional) |
| POST | `/catalog/import?table=` | Importa CSV al catálogo |
| GET | `/catalog/items` · `/locations` · `/payment-methods` | Lista el catálogo |
| DELETE | `/catalog/clear?table=` | Limpia una tabla del catálogo |
| GET | `/auth/google` · `/auth/callback` · `/auth/me` · `/auth/logout` | Flujo de autenticación |
| GET | `/health` | Healthcheck (sin auth) |

Los endpoints que modifican estado o exponen datos (`POST`/`DELETE`) requieren el
header `X-Requested-With: XMLHttpRequest` (defensa CSRF) y sesión autenticada.

## Catálogo

El catálogo vive en SQLite y se carga vía CSV (UI o CLI). Tres tablas:

| Tabla | Columnas esperadas | Alias aceptados (en el encabezado del CSV) |
|-------|--------------------|--------------------------------------------|
| `items` | `sku`, `internal_id` | `UPC Code`, `UPC` → sku |
| `locations` | `store_name`, `oracle_location`, `rep_id`, `shopify_location` | `Stores`/`Store`, `Oracle Location`, `Rep ID`, `Shopify Location` |
| `payment_methods` | `clave`, `payment_type` | `Payment Type` |

Los encabezados se normalizan (trim + minúsculas + espacios→`_`). Si las columnas no
coinciden con la tabla seleccionada, la importación devuelve un error claro en vez de
importar 0 filas en silencio.

## Reglas de negocio (export POS)

Una línea de pedido entra al CSV solo si cumple las 7 reglas heredadas del AppScript:

1. `sourceName === 'pos'`
2. `physicalLocation.name` coincide con `shopify_location` del catálogo (case-insensitive)
3. `displayFinancialStatus` ∈ `{PAID, PARTIALLY_REFUNDED, PARTIALLY_PAID}`
4. `cancelledAt === null`
5. `effectiveQty = qty − returnedQty` por línea (omitir si ≤ 0)
6. El SKU debe existir en el catálogo (si no, se omite la línea)
7. `netPrice = (unitPrice − totalDiscount/qty) / 1.16` con 6 decimales

### Columnas del CSV (en orden)

`Order Date, Order Number, Sales Rep ID, Internal ID, Net Price, Item Qty,
Payment Method UUID, Oracle Location, UUID, Price Level`

- `Order Date`: `DD/MM/YYYY` ajustado a CST (-06:00)
- `UUID`: se autocompleta desde Facturama por fecha de venta (si está configurado); si no, se llena manualmente
- `Price Level`: siempre `"Personalizado"`
- El BOM se agrega en el cliente al descargar

## Seguridad

- Google OAuth con validación de dominio en el callback (antes de crear la sesión)
- Regeneración de sesión al login, `SESSION_SECRET` validado al arrancar, expiración de 8h
- `SKIP_AUTH` solo funciona fuera de producción
- Helmet (CSP) + rate limiting + header CSRF en mutaciones
- Escape de salida en la UI, validación de uploads (5 MB máx., tipo CSV), sanitización
  de nombres de archivo y de fórmulas CSV
- Detrás del proxy de Railway: `trustProxy: true` (obligatorio para que la cookie
  `secure` persista; sin él, el login entra en loop)

## Deploy (Railway)

- Builder: nixpacks · Start: `npm start`
- Volume montado en `/data` (catálogo persistente) → `DATABASE_PATH=/data/catalog.db`
- Variables del dashboard: `NODE_ENV=production`, `SESSION_SECRET`, `BASE_URL=https://…`
  (sin espacios), `ALLOWED_DOMAIN`, credenciales de Shopify/Google/Facturama
- En Google Cloud Console, el redirect URI debe ser exactamente `{BASE_URL}/auth/callback`

## Estructura

```
src/
  app.js                  # bootstrap Fastify (plugins, seguridad, rutas)
  routes/                 # auth, posExport, catalogImport
  middleware/             # requireAuth, requireXhr (CSRF)
  services/               # shopify, posTransform, csvGenerator, catalog,
                          # catalogNormalize, facturama
  db/                     # client + schema SQLite
  ui/                     # posExport.html + posExport.js
scripts/importCatalog.js  # importación de catálogo por CLI
```
