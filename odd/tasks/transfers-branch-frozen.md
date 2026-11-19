# Nombrar el congelamiento de sucursal en transfers

La base ya sabe que una sucursal con una liquidación abierta no opera y lo rechaza con `LC001`.
Transfers recibía ese rechazo y lo publicaba como `503 service_unavailable`: una caída de servicio
que nunca ocurrió. Esta vertical traduce el código, como ya lo hacen `closings` y `auth`.

## Specs

S1. **El store traduce `LC001` a un centinela del dominio.** Cuando PostgreSQL devuelve el SQLSTATE
`LC001` en una escritura de `transfer_requests`, el store de transfers devuelve
`transfers.ErrBranchFrozen`, no un error envuelto que caiga al `default`. La comparación es por
código (`*pgconn.PgError.Code == "LC001"`), igual que en `internal/closings`; no se compara el texto
del mensaje ni el nombre de la restricción.

S2. **El handler responde `409 branch_frozen`, nunca 503.** `transferFailure` gana
`case errors.Is(err, transfers.ErrBranchFrozen): failure(w, 409, "branch_frozen")`, con el mismo
código que ya usa `httpapi/closings.go` para la misma regla. El rechazo **no nombra la sucursal**:
la base no la nombra (el guard se dispara sobre el origen o el destino según el trigger) y agregar
un payload exigiría inventar una lectura extra que la regla no pide.

S3. **Los mapeos existentes no cambian.** `ErrInvalid` → 400 `invalid_request`, `ErrForbidden` → 403
`forbidden`, `ErrNotFound` → 404 `not_found`, `ErrInsufficientStock` → 409 `insufficient_stock`,
`ErrDecisionConflict` → 409 `decision_conflict`, `ErrRetryConflict` → 409 `retry_conflict`, y todo
error desconocido sigue siendo 503 `service_unavailable`. Se fija con un test de tabla, porque el
switch es compartido por todos los endpoints de transfers.

S4. **La web deja de presentarlo como caída.** Un `409 branch_frozen` muestra copy accionable
("la sucursal tiene una liquidación de cuenta abierta: cerrala antes de reintentar") en lugar de
"El servicio no está disponible". El botón de reintento se conserva: cerrar la liquidación es lo
que habilita el segundo intento.

S5. **Cobertura mínima y observable.** Un test de store fija `LC001` → `ErrBranchFrozen`; un test de
handler fija `ErrBranchFrozen` → 409 `branch_frozen` sobre `POST /api/transfers` y comprueba que no
se escribió ninguna fila en `transfer_requests`. Un test de tabla de `transferFailure` fija el resto
de los códigos de S3.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S1, S5 | parent: store de transfers traduce `LC001` + test unitario y de writes | `33fe9fa` |
| T2 | S2, S3, S5 | parent: `transferFailure` gana el caso + test de tabla | `33fe9fa` |
| T3 | S4 | parent: copy en la web para `branch_frozen` | `d3b6104` |
| T4 | S1-S5 | verificación independiente (contrato de errores compartido) | L5 (`mwnttycy-2-i0zz`) |
| T5 | S1, S3 | parent: cierra F2 (dispatch/recepción sin cobertura) y F4 (tabla sin `decision_conflict`) | `33fe9fa` |

## Log

L1. Pedido del humano, textual: «como como? que es el mapeo de LC001» y luego «bien mapealo entonces».

L2. Origen del hallazgo: un `POST /api/transfers` real contra Sucursal A devolvió 503 en la web y
`The branch has an open account settlement and cannot operate` (`LC001`) en el log de PostgreSQL.
El guard vive en `apps/api/migrations/035_branch_guards.sql:125` (`assert_branch_not_frozen`), lo
llama el trigger `admit_transfer_when_branches_operating` y se dispara sobre
`NEW.destination_location_id`.

L3. Decisión de alcance tomada acá y no por el humano: el rechazo no nombra la sucursal congelada,
porque ni la base ni el guard la nombran y el precedente de `closings` tampoco la nombra. Queda dicho
para que se pueda revertir con un pedido explícito.

L4. Alcance excluido a propósito: el 503 de Sucursal A en la base local no se toca (la liquidación
`branch_closings` id 1 sigue abierta); esta vertical sólo arregla la traducción del rechazo.

L5. Verificación independiente (sin bloqueantes, S1-S5 satisfechas), con cuatro hallazgos de cobertura.
Se cerraron dos dentro de la vertical: F2 — nada fallaba si `dispatch.go` o `receipt.go` volvían a
`fail(ctx)`, así que se agregó `internal/transfers/branch_frozen_write_test.go`, que congela el origen
antes de un despacho y el destino antes de una recepción, exige `ErrBranchFrozen` en ambos y comprueba
que la cabecera conserva `approved`/`in_transit`; y F4 — la tabla de mapeos omitía
`ErrDecisionConflict`, que S3/S5 piden fijar, agregado. El verificador probó por mutación que ningún
test nuevo pasa si se quita el mapeo.

L6. Fuera de esta vertical, con nombre y motivo, para que no se pierdan:

- F1 — la conciliación unificada sigue publicando `LC001` como 503: los guards de `035:490-502`
  cubren `transfer_count/restitution/dispatch/unified_operations`, su único escritor en producción es
  `transfer_unified_reconcile(...)` (`internal/transfers/unified_reconciliation_store.go:42`) y su
  traductor (`:92`) no tiene caso `LC001`, así que la web de conciliación tampoco admite
  `branch_frozen`. Misma mentira, otra superficie.
- F3 — despacho y recepción ya admiten `branch_frozen` en el transporte, pero sus componentes
  (`TransferDispatch.tsx:84`, `TransferReceipt.tsx:169`) caen al texto genérico "No se pudo confirmar
  el despacho/recepción", que presenta como incierto un rechazo que es definitivo. No hay todavía
  harness de esos textos en sus suites.

Ninguno de los dos entra sin una decisión del humano: los dos piden tocar otra superficie y F1 pide
abrir el traductor de otro paquete.

L7. Medido antes de partir los commits, sobre el árbol final: `make test-pg` **exit 0** sobre los 19
paquetes (fixture auditado, teardown limpio, 6m15s); suite web **4162 pasan, 1 skip preexistente**;
`tsc --noEmit` verde; `biome lint src` con 271 warnings preexistentes y **ninguno nuevo** en los
archivos tocados; `vite build` verde; `go vet` limpio sobre `internal/transfers` y `internal/httpapi`;
`gofmt -l apps/api` vacío. Las cuatro piezas quedaron probadas por mutación: quitar el caso `LC001`
del store, el caso del handler, `branch_frozen` de la whitelist web o el `mapWriteFailure` de
`dispatch.go` hace fallar un test distinto cada vez; el árbol de mutación se restauró y el estado
limpio se verificó por checksum antes de commitear.

L8. Entrega en dos commits de código sobre `d7986d1`, más este documento: `33fe9fa` (API) y
`d3b6104` (web). Carga de revisión: **192 líneas autoradas de código** en dos cortes temáticos, API y
web, más este documento; total de la rama, 290 líneas. Sin push y sin merge: sigue siendo decisión
del humano.

L9. Publicada: la rama subió con su upstream y entró a `master` como merge commit `c596e0f`. Después del
merge, sobre master: `go build ./...` verde y `gofmt -l apps/api` vacío. CI `verify` corre sobre el push
de master (`go`, `go-postgresql`, `frontend`).
