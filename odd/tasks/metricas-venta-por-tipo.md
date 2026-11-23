# Métricas: la venta por tipo de producto

La pantalla tiene que mostrar el dinero vendido en baterías, el de otros productos y el total de todas las ventas, juntos y separados.

Base: `feat/metricas-minimal`.

## Specs

- **S1.** «ahora en algun lugar de aqui debe aparecer el dinero de las ventas por baterias y el dinero de las ventas de otros productos por separado. y tambien uno general de todas las ventas»
- **S2.** `sales.batteries` es `sum(sale_lines.subtotal)` de los renglones con `catalog_entries.kind = 'battery'` en la ventana del período elegido, leído de las ventas mismas y no del acta, para que exista también en una rendición cerrada y en todo el historial.
- **S3.** `Otros productos` es `total − batteries`, restado por el cliente. Una respuesta con `batteries > total` se rechaza entera.
- **S4.** La pantalla muestra las tres lecturas juntas en un bloque `Qué se vendió`: `Baterías`, `Otros productos` y `Total`, con los tokens existentes y sin colores ni sombras nuevos.
- **S5.** Una ausencia se dice con palabras: una sucursal sin ventas de baterías lee `Baterías · Sin ventas`, nunca `Bs 0,00`.
- **S6.** El bloque vive bajo `Cómo se cobró`, en la columna izquierda del pie, y apila en pantallas angostas.

## Tasks

- [x] **T1** Go: `MetricsSales.Batteries`, suma filtrada por tipo en la ventana del período (también para rendiciones y para el historial), validación y cruce `batteries <= total`. Tests. · S2, S3
- [x] **T2** `httpapi`: publicar `sales.batteries`; tests de claves. · S2
- [x] **T3** Web: `metricsAPI` con `batteries` validado y `otros` derivado; `Metrics.tsx` con el bloque `Qué se vendió` y su CSS. Tests. · S3, S4, S5, S6
- [ ] **T4** Suites, `tsc`, build, servidores y commit.

## Log

- **L1.** «ahora en algun lugar de aqui debe aparecer el dinero de las ventas por baterias y el dinero de las ventas de otros productos por separado. y tambien uno general de todas las ventas»
