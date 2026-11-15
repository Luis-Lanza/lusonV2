# Comisión por sucursal en el panel de administración

Configurar el porcentaje de comisión de cada sucursal desde el panel de administración del Almacén, y que la rendición avise antes de intentar proponer.

## Specs

- **S1** El humano pidió, textual: «Mira dentro de almacen/admin tenemos un panel de administracion en donde se puede crear/eliminar sucursales, ahi se debe poder agregar la comision de cada sucursal!».
- **S2** La pestaña **Sucursales** del panel muestra, para cada sucursal, su porcentaje de comisión. Una sucursal sin porcentaje dice `Sin configurar`, que es el mismo estado que bloquea su rendición.
- **S3** El porcentaje se escribe desde esa pestaña: acepta coma o punto, se canoniza a dos decimales y se rechaza fuera de `0`–`100`. Un valor inválido no se envía.
- **S4** Escribir el porcentaje queda auditado: el panel muestra quién lo fijó y cuándo, y el servidor guarda la cuenta actuante.
- **S5** La rendición de una sucursal sin porcentaje **no puede proponerse**, y la barra de la rendición lo dice **antes** de intentar: el botón queda deshabilitado y el motivo aparece en la lista de bloqueos, nunca como error del servidor después de apretar.
- **S6** Desde ese bloqueo se llega al panel con la pestaña Sucursales abierta (`#/administracion/sucursales`), y de vuelta a la rendición.
- **S7** Cambiar el porcentaje no altera ninguna rendición propuesta ni cerrada: la tasa se congela al proponer (comportamiento ya existente de 034/S6, que esta feature no toca).
- **S8** El diseño implementado de la pantalla (`design/access-management/01-directory.html`) se extiende con el porcentaje y su editor, para que el diseño no quede mintiendo.

## Tasks

- **T1** API: listar las comisiones configuradas y permitir que el panel escriba la que ya existe. Specs: S2–S4. Ruta: inline.
- **T2** Panel: porcentaje por sucursal con su editor. Specs: S2–S4. Ruta: inline.
- **T3** Barra de la rendición: bloqueo real del porcentaje faltante y enlace al panel. Specs: S5, S6. Ruta: inline.
- **T4** Diseño y documentación. Specs: S8. Ruta: inline.

## Log

- **L1** (verbatim) «Mira dentro de almacen/admin tenemos un panel de administracion en donde se puede crear/eliminar sucursales, ahi se debe poder agregar la comision de cada sucursal!» — precedido por «vamos!» que autoriza la implementación propuesta: el panel de sucursales, escritura por la ruta de comisión que ya existe, barra corregida y artboard extendido.
- **L2** Hallazgos que fijan el alcance: `branch_settings` ya existe con el porcentaje, la auditoría (`updated_by_account_id`, `updated_at`) y el CHECK `0`–`100`; `POST /api/closings/branches/{branch}/commission` ya lo escribe y ya está probado. Lo que falta es **leerlo en el panel** y **una pantalla que lo use**. La barra de la rendición no lo conoce: avisa que se puede proponer y el rechazo llega como `commission_rate_missing` después de apretar.
- **L3** Decisión de alcance: la comisión no toca la superficie `/api/admin/branches` (su JSON exacto está fijado por pruebas y no gana nada agregando un campo). Se lee por una ruta nueva de la superficie de rendiciones, `GET /api/closings/branches/commissions`, y se escribe con la ruta de comisión que ya existe.
- **L4** Implementado en cuatro unidades sobre `feat/closings-purchase-fund`: `8e2c718` la lectura de las comisiones configuradas por la superficie de rendiciones (`Store.Commissions` + `GET /api/closings/branches/commissions`), `ef842a6` el porcentaje y su editor en la pestaña Sucursales, `db9c750` el bloqueo real en la barra de la rendición con enlace `#/administracion/sucursales` (la pestaña también es una pantalla del hash, como el catálogo), `8d96eec` el trato visual de los dos bloques. Todas las pruebas en verde: Go `internal/closings` y `internal/httpapi` completos, web 3621 pasan y 1 skip preexistente, `tsc` y build limpios.
- **L5** El enlace de la barra va a la pestaña Sucursales con la fila del porcentaje, y el mensaje del bloqueo es la misma frase que devolvía el rechazo del servidor: el operador lee una sola cosa en los dos lugares, y el botón deja de ofrecerse cuando el servidor lo va a rechazar.
