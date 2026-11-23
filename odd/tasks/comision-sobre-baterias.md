# Comisión solo sobre baterías

La comisión de la sucursal pasa a calcularse sobre los renglones de baterías y no sobre toda la venta. La rendición y la tarjeta de Métricas tienen que multiplicar la misma base.

Base: `feat/metricas-minimal`.

## Specs

- **S1.** «la comision debe ser solamente de la venta de baterias, la venta de "otros productos" como agua acidulada no cuentan para la comision»
- **S2.** La base de la comisión es `sum(sale_lines.subtotal)` de los renglones cuya entrada de catálogo es `catalog_entries.kind = 'battery'`, en la misma ventana que hoy usa cada cuenta (la rendición: `period_start` a `cut_at`; la ventana viva: desde el corte).
- **S3.** `commission = round(base × tasa / 100, 2)`, con el mismo redondeo único y half-up que ya usa la rendición.
- **S4.** `Plata del período`, `sales_total` (acta) y `today.sold` siguen contando **todas** las ventas, baterías y otros productos. El cruce `sales.total == today.sold` de la ventana no cambia.
- **S5.** La rendición guarda la base que multiplicó en `branch_closings.commission_base` y calcula `commission_amount` sobre ella; la vista previa del Go y el acta usan la misma base.
- **S6.** `commission_base` es null en las actas registradas antes de esta regla. El cliente valida `commission_amount == round(base × tasa)` solo cuando la base está; sin base valida únicamente la forma.
- **S7.** Una sucursal que no vendió baterías devenga 0: la tarjeta dice `Sin comisión todavía` y el acta guarda `0.00`.
- **S8.** No se reescribe ningún acta: ninguna migración toca filas existentes ni recalcula comisiones históricas.

## Tasks

- [x] **T1** Migración `apps/api/migrations/064_commission_on_battery_sales.sql`: columna `commission_base numeric(12,2)` null, sin backfill; redefine `record_branch_closing_offer()` con la suma filtrada por `entry.kind = 'battery'` y `sales_total` sin cambios; trigger propio que congela la base con la oferta, porque 044 congela `commission_amount` pero no el número que multiplicó. Tests de esquema y de base viva. · S2, S4, S5, S6, S8
- [x] **T2** Métricas Go: `MetricsToday.CommissionBase`, suma filtrada por tipo en la ventana, `Commission(base, rate)`. Tests con batería + otro producto. · S2, S3, S4, S7
- [x] **T3** Rendiciones Go: la vista previa calcula la base filtrada y la publica; la lectura de un acta publica `commission_base` (null en las viejas). Tests. · S5, S6
- [x] **T4** `httpapi`: `commission_base` en `metricsTodayDTO` y en el acta; tests de claves fijas. · S3, S5, S6
- [x] **T5** Web: tipos e identidades en `metricsAPI.ts` y `closingsAPI.ts` (`commission == round(base × tasa)`, null tolerado). Tests. · S3, S6, S7
- [x] **T6** Suite completa Go y web, `vet`, `tsc`, build, servidores, commit y cierre del documento.
  - Go: `./migrations` 78s, `./internal/closings` 102s, `./internal/httpapi` 376s con Postgres efímero; `go vet ./...` limpio.
  - Web: `tsc --noEmit` limpio, suite completa **4570 pasados / 1 skip**.
  - Verificación independiente: S1-S8 cumplidas; observaciones aplicadas (CHECK en la columna, dos comentarios obsoletos) y una anotada: el despliegue de api y web tiene que ser atómico, porque el cliente exige la clave nueva y el servidor viejo no la publica.
  - Commits: `e1601ac` (migración), `7df15bf` (Go), `54755bb` (web).
  - Corte de rebanada: la rebanada de 064 cierra en `e1601ac`; el resto de la feature va en los dos commits siguientes.
  - Servidores locales: 8080 y 8081 con `index-BgV8314l.js`; la base de desarrollo quedó migrada a la versión 64.

## Log

- **L1.** «MMMM entiendiendo, la comision debe ser solamente de la venta de baterias, la venta de "otros productos" como agua acidulada no cuentan para la comision»
- **L2.** Decisión: las actas ya cerradas o propuestas conservan la comisión que registraron (S8); la regla rige para lo que se calcule desde ahora.
- **L3.** La base se congela con la oferta: el candado propio de 064 cierra el hueco que 044 deja abierto sobre `commission_base`; una acta anterior a la regla no puede ganar base después.
