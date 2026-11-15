# Compras por período y saldo de materiales

Que la pantalla de Compras deje de mostrar el acumulado histórico como si fuera una posición actual: un filtro por período, y un saldo real de lo que queda físicamente en la sucursal.

## Specs

- **S1** Textual del humano, la queja que origina esto: «termine de hacer una rendicion de cuentas y todavia sale aqui que la sucursal tiene chatarra o baterias, cuando esos montos ya se rindieron cuentas». Y el pedido: «quiero que lo que se vea en compras se resetee a 0, porque luego del corte todo es transferido a almacen».
- **S2** La pantalla tiene un **selector de período** con estas opciones, y la de por defecto es la primera:
  - **Pendiente**: el saldo que queda en la sucursal ahora (S4).
  - **Rendición #N**: cada rendición cerrada de la sucursal, como período propio.
  - **En curso**: la rendición abierta, cuando existe.
  - **Todo el historial**: exactamente lo que la pantalla muestra hoy.
- **S3** Los tres números de cabecera y las tres pestañas respetan el período elegido, y una línea dice en palabras qué se está viendo: el período, si está cerrado o abierto, y su fecha de corte. Un total nunca se muestra sin decir a qué período pertenece.
- **S4** **Saldo** = comprado − entregado, por modelo (baterías usadas) y por material (cobre, aluminio, plomo, bronce). Lo entregado es lo **contado** en cada rendición **cerrada**. Consecuencias que esta regla tiene que cumplir:
  - Entregado todo: el saldo es cero y la pantalla se lee en cero.
  - Contado de menos: el resto **sigue apareciendo** como saldo. No desaparece.
  - Comprar de nuevo después del cierre: el saldo vuelve a subir desde cero.
- **S5** Un período es **una rendición**, nunca un mes calendario: los números de un período coinciden con la planilla de materiales del acta de ese cierre.
- **S6** Nada se borra: los documentos de compra siguen listados bajo «Todo el historial», y las rendiciones cerradas conservan su acta. El saldo y los períodos se **derivan** de hechos existentes (`purchases`, `purchase_used_lines`, `purchase_scrap_lines`, `branch_closings`, `closing_material_lines`), sin tabla nueva y sin marcar documentos.
- **S7** Una anulación (contra-documento) resta: el saldo y los totales la descuentan igual que hoy, sin caso especial.

## Tasks

- **T1** API: el listado de compras publica los períodos disponibles, el período elegido y los totales del período, con el saldo de la sucursal cuando el período es «pendiente». Specs: S2–S7. Ruta: writer.
- **T2** Pantalla: selector de período, línea de contexto y los números y pestañas siguiendo el filtro. Specs: S2, S3. Ruta: writer.
- **T3** Documentación y verificación. Specs: S6. Ruta: inline.

## Contrato decidido

`GET /api/purchases?period=<pending|all|<closing_id>>&page=&page_size=`

- Sin `period`, el servidor responde `all`: el comportamiento de hoy no cambia para un cliente viejo.
- La respuesta suma tres bloques a los actuales:
  - `periods`: `[{kind: 'pending'|'settlement'|'open'|'all', closing_id, from, to, label}]`, en orden: pendiente, rendiciones cerradas (más nueva primero), en curso si existe, todo.
  - `period`: el elegido, con el mismo shape.
  - `balance`: por modelo y por material, `{comprado, entregado, saldo}` de cada uno, derivado de todo el historial. Sólo tiene sentido en `pending`; en los otros períodos el servidor publica `null` y la pantalla no lo muestra.
- Los totales de cabecera y las líneas de las pestañas siguen la ventana del período elegido. En `pending` los totales son el **saldo**, no lo comprado en una ventana: es la única opción que responde «qué tengo ahora».
- Un `period` que no existe en esa sucursal es `invalid_request`, no una lista vacía.

## Log

- **L1** (verbatim) «aun no tengo claro como quiero proceder... porque quiero que lo que se vea en compras se resetee a 0, porque luego del corte todo es transferido a almacen entiendes mi punto? como poder haver esto sin perder informacion, aun no toques codigo».
- **L2** (verbatim) «podemos poner algun filtro no? como podria ser este filtro?» — y la respuesta que el humano aceptó con «ya hagamos eso haber»: filtro por período **y** saldo por modelo/material.
- **L3** Decisión de derivación: el reset **no** se implementa borrando ni marcando documentos. El saldo es `comprado − entregado`, con lo entregado tomado de las rendiciones cerradas: es la única forma de que lo contado de menos no desaparezca (que es el defecto que el humano reportó como «todavía sale que la sucursal tiene chatarra»).
- **L4** Se descartó el período por mes calendario: no coincide con ninguna acta, así que el número de la pantalla y el del documento nunca hablarían de lo mismo.
- **L5** Implementado en dos unidades (`990ff22` API, `dae74ce` pantalla) más el cierre del hueco de contrato: el listado publica `totals` del período elegido, calculados por las **mismas sentencias** que `/api/purchases/received`, para que las dos rutas nunca discrepen sobre el mismo historial. `/received` queda intacta: sigue siendo la lectura de todo el historial y no acepta período.
- **L6** Un tercer paso de la pantalla había dejado el hueco a la vista: para las rendiciones cerradas las tres cifras seguían siendo el acumulado, rotuladas «acumulado del historial». Con `totals` en el listado el rótulo desapareció y cada período tiene sus propios números (S3).
- **L7** Decisiones que el documento no fijaba y quedaron así: `from`/`to` de `pending` y `all` son `null` (ninguno es un tramo de tiempo); el id de la rendición en curso se resuelve como período `open`, porque `open` no es un token admitido en la consulta; el saldo de `pending` no publica dinero porque un saldo es material que la sucursal tiene, no plata que gastó, y por eso `money` es `null` sólo ahí.
- **L8** Verificación: web completa 3668 pasan y 1 skip; el único fallo de la corrida fue `TransferPending.test.tsx`, que pasa aislado con 257 pruebas — es el intermitente preexistente, no de este cambio. Go completa en curso al cerrar esta entrada; `tsc` limpio y `gofmt` sin salida.
