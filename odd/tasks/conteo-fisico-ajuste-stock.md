# Conteo físico y ajuste de stock (Almacén)
Vertical nueva: corregir el stock del Almacén contra un conteo físico real. Solo el Almacén ajusta su propio stock; sin sucursales en esta vertical. Documento inmutable, aplicado atómico, corregido sólo por contra-asiento.
Feature branch: por crear desde `master` (275d236). Diseño: `design/stock-count/` (3 direcciones, elección pendiente).

## Specs
S1. Visual: implementar el artboard elegido de `design/stock-count/` en el stack real (React/Go/PostgreSQL), usando los tokens de `design/system.md` y el shell existente (sidebar 240px, header 56px, paleta vino). No copiar el HTML del artboard. Check: captura, historial y detalle consistentes con el artboard elegido en escritorio; sin pantallas inventadas fuera del alcance.
S2. Alcance: “Solo almacen puede hacer ajuste de stock de almacen! aun no hagamos de sucursales!”. Check: sólo la cuenta 1 con location 1 crea, lee, revierte y usa el catálogo de ajustes; cualquier otra cuenta recibe 403 y la base rechaza location ≠ 1, igual que el ingreso de stock.
S3. Flujo: “Documento de ajuste puntual”. Check: un documento con una o más líneas (variante + cantidad contada) se aplica completo o no se aplica; no existe sesión de conteo, cierre diferido ni borrador persistido en el servidor.
S4. Conteo ciego: “No, conteo ciego”. Check: la superficie de captura no muestra el stock esperado, la diferencia ni el stock de ninguna otra pantalla embebida; el cliente envía sólo cantidades contadas y nunca la diferencia; el payload de catálogo de la captura no contiene cantidades de stock; el servidor toma el esperado dentro de la transacción y deriva la diferencia. La diferencia se revela sólo después de aplicar, en el historial y el detalle.
S5. Trazabilidad: cada línea persiste el esperado al momento de aplicar y la cantidad contada; el documento persiste motivo, actor (cuenta) y fecha. Check: el detalle de un documento muestra esperado, contado y diferencia por línea, y sigue siendo legible cuando el stock actual ya cambió.
S6. Inmutabilidad y corrección: el documento aplicado no se edita ni se borra; se corrige con un contra-asiento único que invierte todas sus líneas y exige motivo. Check: un segundo contra-asiento sobre el mismo documento es rechazado; ambos documentos quedan visibles.
S7. Invariantes heredadas del ledger de stock: rechazo total si una línea es inválida, `existing` nunca por debajo de `reserved`, sin cambios a `reserved`, append-only por trigger, e invalidación realtime por la migración 004. Check: los intentos inválidos no escriben datos ni mueven contadores.
S8. Sin regresiones: ingresos al Almacén, transferencias, inventario y administración siguen funcionando igual; no se agrega ajuste para sucursales ni ajuste masivo fuera de lo que este documento diga.
S9. Verificación: migración probada contra PostgreSQL real, store y HTTP con tests, frontend con tests de modelo y componentes, typecheck y build, y verificación funcional de los flujos del artboard elegido.

## Tasks
T1 [S1] Escribir spec, documento y direcciones visuales; abrir el canvas y registrar el artboard elegido — route inline (diseño); done: 3 artboards en `design/stock-count/`, artboard elegido por el humano `03-history-first.html` (handoff in_progress), documento creado; commit pendiente.
T2 [S2,S3,S4,S5,S6,S7] Migración 022: tablas `stock_adjustments`/`stock_adjustment_lines`, triggers de admisión, aplicación con esperado persistido, contra-asiento único y pruebas de esquema — route inline (patrón de la 021 ya verificado); pending.
T3 [S2–S7] Paquete Go `internal/stockadjustments`: validación, store con `operation_key`, replay-vs-conflicto, lectura paginada y detalle, y tests TDD — route delegated (unidad de comportamiento pesada); pending.
T4 [S2,S3,S4] Contrato HTTP: `POST /api/stock-adjustments`, `GET /api/stock-adjustments`, `GET /api/stock-adjustments/{id}`, `POST /api/stock-adjustments/{id}/reverse`, catálogo sin stock para la captura, y documentación — route inline sí T3 está estable; pending.
T5 [S1,S4] Frontend: sección `#/ajustes`, captura ciega, historial, detalle con esperado/contado/diferencia y contra-asiento, con tests — route delegated si supera una unidad; pending.
T6 [S9] Verificación integrada: suites Go contra la fixture Postgres existente, Vitest, typecheck, build y prueba funcional del flujo — route independent verifier (riesgo 1/2/3) más checks del padre; pending.
T7 [S1–S9] Cierre: registrar evidencia, handoff del artboard y riesgos residuales — route inline; pending.

## Log
L1. Pedido original, verbatim:
“hagamos conteo fisico/ ajuste de stock entocnes pa! como lo planteamos? como hacemos la UI UX”
L2. Decisiones del humano, verbatim (cuestionario de alcance, flujo y conteo ciego):
- Alcance: “Solo almacen puede hacer ajuste de stock de almacen! aun no hagamos de sucursales!”
- Flujo: “Documento de ajuste puntual”
- Conteo ciego: “No, conteo ciego”
L3. Consecuencia derivada de S4 (no es alcance nuevo): el catálogo de la captura no puede reutilizar `/api/inventory`, porque ese payload incluye `existing`. La captura necesita un listado de catálogo sin cantidades.
L4. Housekeeping previo a esta vertical: el handoff de `design/stock-ingress/01-document-table.html` quedó marcado como implementado (estaba en `in_progress` aunque la vertical ya está mergeada en master).
L5. Handoff de implementación, verbatim (cuerpo del pedido):
“Implement the design artboard design/stock-count/03-history-first.html” — Title: “Historial primero”; Tradeoff: “Auditoría y contra-asientos siempre a la vista; cargar exige abrir un panel lateral y perder el contexto del historial.”
Chosen artboard: `design/stock-count/03-history-first.html` (the other artboards are alternatives). Branch: `feat/stock-adjustments`, created from master 275d236. El handoff no commitea nada por sí mismo.
