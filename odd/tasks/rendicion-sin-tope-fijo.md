# Rendición sin tope fijo de líneas

Feature: `fix/closing-sheet-bound` · Base: `master` tras `test/e2e-all-flows` · Risk: item 1 (cambia el límite del esquema y de la lectura de la planilla)

Nace del cierre de la cobertura e2e: la planilla de una rendición escribe una línea por cada variante con existencia en la sucursal, pero la lectura corta en `MaxCountLines = 190` y responde `503 service_unavailable`. Con el catálogo real —271 variantes de batería y más de 260 productos— una sucursal con más de 190 variantes en stock no puede rendir cuentas nunca. Sucursal B está en 235 y Sucursal A llegó a 187: quedan tres líneas de margen.

## Specs

S1. La planilla no tiene tope propio. El cierre de una rendición se lee completo cuando la sucursal tiene cualquier cantidad de variantes con existencia. Check: una sucursal con más de 190 variantes en stock abre su rendición, la cuenta, la propone, la decide y la cierra; la planilla devuelve una línea por variante con existencia, sin recortes ni líneas inventadas.

S2. Un solo número, en un solo lugar. El límite de la planilla no puede volver a quedar desalineado con el catálogo. Check: el tope de la planilla se deriva de la cantidad de variantes del catálogo o del tamaño real de la planilla, nunca de una constante copiada a mano en otro archivo; si la base tiene un `CHECK` o un trigger con el número viejo, se cambia en la misma migración.

S3. El rechazo se mantiene donde corresponde. Los topes que protegen una entrada del operador —las líneas de un documento de ajuste, la cantidad contada de una línea, la observación y el motivo— siguen rechazando con su error de dominio, sin convertirse en un error de servicio. Check: un documento de ajuste con más líneas de las admitidas sigue siendo rechazado con su código, y la rendición de una sucursal grande ya no responde `503`.

## Tasks

T1 — Encontrar cada punto que aplica el 190: la constante Go, su uso al armar la planilla, cualquier restricción de la base y lo que digan `apps/api/docs/closings.md` y el test de esquema. Commit `docs(odd): map the closing sheet bound`.
T2 — Migración y constante alineadas al catálogo, con el contrato actualizado. Commit `fix(api): the closing sheet is bound by the catalogue, not by 190`.
T3 — Test que abre, cuenta y cierra una rendición sobre una sucursal con más de 190 variantes con existencia, y prueba que la planilla trae todas. Commit `test(api): a branch above 190 in-stock variants settles`.
T4 — Los specs de rendición vuelven a Sucursal B (o a la sucursal que elija el test) y el margen de Sucursal A deja de importar. Commit `test(e2e): the closing specs need no small branch`.

## Log

L1. User: "dale si dale con sucursal A pero eso debe quedar documentado que hay que hacer una migracion luego!"

L2. User, ante la pregunta de si encarar la migración ahora: "Ahora, como aparte" — se abre este feature en vez de dejarlo pendiente.

L3. Medición: Sucursal B 235 variantes con existencia, Sucursal A 187 (tres líneas de margen sobre el tope de 190), Almacén 353. El tope nunca se subió cuando la migración `028` borró el límite de 190 variantes del catálogo.
