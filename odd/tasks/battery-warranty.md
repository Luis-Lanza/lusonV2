# Garantías y reparaciones de baterías

Feature: `feat/battery-warranty` · Base: `8e3d39b` (master) · Risk: item 1 (migraciones nuevas y cambio en el sembrado de `closing_material_lines`) y item 3 (contrato del sembrado de usadas que ya consumen las rendiciones)

Entrega: una rama de feature con un commit por tarea, revisión por slice. Slice 0 —documento, sincronización del sistema de diseño y artboards— en `35efdc0` y `c9a6178`. Slice 1 —T2, la migración y su schema test— en `57d69b6`: 1 187 líneas de SQL y prueba de esquema que se revisan solas, sin código Go. Los slices 2 a 8 empiezan en T3.

Una batería fuera de servicio —devuelta por un cliente con garantía o hallada fallada en stock— entra en un caso que sigue su viaje hasta la sucursal, el Almacén, la fábrica y la vuelta, con el préstamo de una usada al cliente para que nunca quede sin batería.

## Specs

S1. Dos puertas de entrada, un solo caso. User, L1: "que pasa si la sucursal vende una bateria fallda y viene a reclamar con su garantia" y L2: "la sucursal puede enterarse que una bateria esta arruinada antes de venderse, talvez la probo y se da cuenta que esta fallada, entonces debe enviarse a almacen tambien". Un caso nace por `warranty_claim` (identificado por el número de serie de una unidad vendida) o por `stock_defect` (identificado por modelo y cantidad del stock de una sucursal). Check: cada entrada escribe su caso con su origen; un caso de garantía sin venta y un caso de stock sin cantidad disponible son rechazados sin escribir nada.

S2. La entrada de garantía se verifica contra la venta. User, L1: "viene a reclamar con su garantia". El serial debe existir en `sale_units`, pertenecer a una venta, y el plazo de la unidad debe estar vigente al momento del reclamo; una unidad con `warranty_months` nulo no tiene cobertura. Check: un serial inexistente, un plazo vencido y una unidad sin garantía son rechazados con códigos distintos, sin escribir el caso.

S3. El plazo no se reinicia. User, L8: "sigue con la venta original". Cuando fábrica entrega una unidad nueva en reemplazo, el plazo sigue siendo el de la venta original y la entrega queda atada a esa venta. Check: el caso resuelto por reemplazo no crea ni modifica `sale_units` y el plazo mostrado sigue siendo el calculado desde la venta original.

S4. El cliente nunca queda sin batería. User, L4: "al cliente se le otorga una bateria usada para que pueda ir andando hasta que se revise su garantia". Un caso `warranty_claim` registra al menos un préstamo antes de poder salir de la sucursal. Check: un caso de garantía sin préstamo no puede pasar a tránsito, y la entrega del préstamo queda en el historial del caso.

S5. El préstamo identifica modelo y cantidad, nunca serial. User, L5: "Si las baterias usadas tienen numero de serie, pero no solemos anotarlas al prestarlas ni anotarlas en el sistema". El préstamo guarda código de modelo y cantidad; el serial es opcional, de texto libre, y nunca es identidad ni llave. Check: dos préstamos del mismo modelo y cantidad son válidos e independientes; un préstamo sin modelo es rechazado.

S6. El préstamo sale de cualquier ubicación. User, L5: "El prestamos sale donde haya la bateria que el cliente necesita, algunos casos la sucursal otros casos almacen, otros casos otras sucursales". El préstamo registra su ubicación de origen sin mover stock entre ubicaciones y sin crear una transferencia. Check: se aceptan como origen la sucursal del caso, el Almacén y otra sucursal, y ninguna de las tres escribe filas de transferencia ni cambia `inventory_balances`.

S7. Un caso admite varios préstamos. User, L5: "4. MMMMM dame opciones para este caso" (resuelto: mismo caso, préstamo escalado). Si una usada prestada falla, se marca ese préstamo como `failed` y se agrega otro al mismo caso, sin abrir un caso nuevo. Check: el caso conserva N préstamos con su desenlace propio y nunca existe un segundo caso para el mismo cliente por el mismo reclamo.

S8. Comprobante de préstamo. User, L4: "al cliente se le otorga una bateria usada para que pueda ir andando". La entrega emite un comprobante de una página con el número de caso, el número de garantía de la venta, el serial de la batería reclamada, el modelo y cantidad prestados, la fecha y las condiciones del canje. Check: el comprobante se descarga desde el caso con nombre de archivo estable y muestra los valores persistidos, sin recalcular nada.

S9. El viaje. User, L1: "se la envia a almacen, almacen la envia a fabrica y si esta todo OK se devcuelve arreglada, y se la devuelve al cliente". El caso recorre sucursal, tránsito, Almacén, fábrica y vuelta, con hito, actor y fecha en cada tramo, y un número de legajo de fábrica transcrito a mano. Check: cada transición escribe un evento append-only con actor y fecha; una transición no permitida desde el estado actual es rechazada sin escribir.

S10. Compuerta del Almacén antes de fábrica. "almacen la envia a fabrica" no es automático. El Almacén verifica y puede rechazar antes del envío. Check: el rechazo previo deja el caso en su estado terminal de devolución con motivo obligatorio y no registra envío a fábrica ni legajo.

S11. Veredicto y matriz de resolución. User, L4: "en caso de que la fabrica rechace la garantia, el cliente se queda con la bateria usada y la bateria daniana que viene de fabrica se queda como stock de baterias usadas". El veredicto (`repaired`, `replaced`, `unrepairable`, `not_covered`, `lost`) y el destino de cada unidad son campos distintos: la misma resolución mueve la reportada, el préstamo y —en origen `stock_defect`— el stock. Check: `not_covered` deja el préstamo con el cliente y la unidad dañada en el pool de usadas; `replaced` de un `stock_defect` ingresa la unidad nueva al stock de la sucursal; `replaced` de un `warranty_claim` no toca `inventory_balances`.

S12. Sin dinero en el circuito. User, L4: "aqui nadie pierde". Ningún caso cobra, reintegra ni registra movimientos de caja. Check: no se agregan motivos de caja ni movimientos de caja por esta vertical y la caja de la sucursal no cambia por abrir o cerrar un caso.

S13. La batería que espera al cliente no es stock vendible. Una unidad devuelta por fábrica y destinada a un cliente queda en custodia del caso, fuera de `inventory_balances`. Check: el punto de venta no puede venderla, y el conteo físico y la conciliación la muestran como "en custodia por garantía" en línea separada.

S14. Aviso obligatorio y liberación por decisión. User, L8: "correcto lo que dice tu recomendacion nomas", sobre L6: el aviso lo registra la sucursal que recibe la unidad y la liberación la autoriza el Almacén. Liberar una unidad a stock exige aviso registrado, actor y motivo. Check: sin aviso el caso no ofrece liberación; con aviso, la liberación escribe el evento y la unidad pasa a stock vendible una sola vez.

S15. Sin plazo fijo de abandono. User, L5: "Aqui es indeterminado los dias". El sistema no cierra un caso solo: ordena por antigüedad desde el aviso y escala visibilidad. Check: ninguna transición se dispara por fecha y un caso con aviso antiguo sigue abierto hasta que una persona lo resuelva.

S16. El hallazgo en stock da de baja el stock. User, L2: "debe enviarse a almacen tambien" y, ante la disyuntiva, L16: "dale". Un `stock_defect` descuenta la cantidad de `inventory_balances` de la sucursal en la misma transacción del alta, con motivo propio que la rendición reconoce como legítimo. Es la única escritura de stock que una cuenta de sucursal puede hacer, y está acotada a esa alta: la excepción a `LS005` nombra el origen `stock_defect`, el local del actor y nada más. Check: la cantidad baja en la misma transacción del alta; el saldo nunca queda por debajo de lo reservado; el motivo y el actor quedan en la evidencia; un origen `warranty_claim` no puede escribir stock; y el cierre no imputa faltante a la sucursal por esa unidad.

S17. El pool de usadas alimenta la rendición. User, L6: "si tenemos el historial de compras de baterias usadas... por ahi no podrian ir los tiros?". El esperado de usadas de `closing_material_lines` pasa a ser compras de la ventana más devueltas de fábrica no cubiertas, menos préstamos otorgados, menos liquidaciones a chatarra. Check: un préstamo otorgado en la ventana reduce el esperado; una devuelta no cubierta lo aumenta; los cierres ya creados conservan su `expected_quantity` grabado.

S18. Sin inventario de usadas. User, L5: "no tenemos un inventario de baterias usadas, y no se hasta que punto es necesario" y L6: "no tenemos inventario como tal de baterias usadas". No se crea tabla de stock, ni saldo, ni conteo propio de usadas. Check: no existe ninguna tabla nueva de existencias de usadas y el pool se deriva por flujo.

S19. Dueño único del caso. User, L8: "la sucural le debe la respuesta al cliente y el almaen solo mueve la bateria". La sucursal es dueña del caso y de la relación con el cliente; el Almacén ejecuta hitos sobre el mismo caso sin poder cerrarlo ni cambiar su origen. Check: un actor del Almacén no puede registrar la entrega al cliente; un actor de la sucursal no puede autorizar la liberación a stock.

S20. Numeración por sucursal. El caso tiene un número propio por sucursal, independiente de la numeración de garantías. Check: dos sucursales no comparten numeración y el número aparece en el comprobante y en el historial.

S21. Sin regresiones. Ventas, precios, mínimos, comisiones, transferencias, ingresos al Almacén, compras, chatarra y administración siguen igual. Check: las suites existentes y el typecheck y build del frontend pasan; el sembrado de usadas se prueba contra PostgreSQL real.

S22. Verificación. Migraciones probadas contra PostgreSQL real, stores y HTTP con tests, frontend con tests de modelo y componentes, typecheck y build, PDF del comprobante validado estructuralmente, y verificación funcional del artboard elegido.

S23. Vocabulario congelado, para que la migración, el backend y el frontend se construyan por separado. `origin`: `warranty_claim` | `stock_defect`. `phase`: `received` | `in_transit` | `at_warehouse` | `at_factory` | `resolved` | `closed`. `verdict`: nulo o `repaired` | `replaced` | `unrepairable` | `not_covered` | `lost` | `refused_at_warehouse`. Destino por unidad: nulo o `customer` | `stock` | `scrap` | `retained_by_factory`. Desenlace del préstamo: `open` | `returned` | `kept_by_customer` | `failed` | `lost`. Los códigos de error de esta vertical usan el prefijo `LW`, que este repositorio no usa, y nunca repiten un número. Check: un valor fuera de esas listas es rechazado por la base y no por la aplicación solamente.

S24. Stock real de usadas por local y por modelo, derivado de los hechos ya registrados. User, L30: "entonces debemos manejar mejor el stock de baterias usadas... stock de baterias usadas de cada sucursal y de almacen". No se guarda un saldo: se calcula. Sucursal = compradas + devueltas de fábrica + préstamos devueltos − entregadas en rendiciones cerradas − préstamos otorgados. Almacén = entregadas por las sucursales en rendiciones cerradas + devueltas de fábrica − préstamos otorgados. Check: el número de una sucursal sin compras y sin devoluciones es cero; una rendición cerrada suma al Almacén y resta a la sucursal por el mismo importe; un préstamo devuelto vuelve al local que lo recibió.

S25. El préstamo valida el origen. User, L29: "pero como me dejo prestar si aqui hay 0? no entiendo". Un préstamo cuyo local de origen no tiene stock del modelo pedido es rechazado con un código propio y no escribe nada. Check: con stock cero el préstamo se rechaza; con stock uno se acepta y el stock del origen baja en uno; dos préstamos sobre una sola unidad no pueden convivir.

S26. La usada se identifica sólo por modelo. User, L30: "Solo por modelo esta bien. porque por el modelo se puede estimar la capacidad por ejemplo NS60ZL es de 60AH". El modelo es texto, comparado sin distinguir mayúsculas y sin espacios sobrantes, igual que en las compras. Check: `ns60zl` y ` NS60ZL ` son el mismo modelo a los ojos del stock.

S27. Las devueltas de fábrica no cubiertas entran al Almacén, que es quien las envió y quien las recibe de vuelta. Check: resolver un caso como `not_covered` con destino al pool suma al stock del Almacén y no al de la sucursal del caso.

S28. Fuera de alcance, por decisión del usuario: la venta de chatarra y todo movimiento de dinero por material. User, L31: "AUn no dejemos, la venta de chatarra por parte de almacen para otra vertical." Check: no se agrega documento de venta, ni fondo, ni caja, ni movimiento de dinero por material.

S29. Sin regresiones sobre lo entregado. Check: el esperado de la rendición (`066`) sigue cuadrando con el stock nuevo cuando la sucursal entrega todo en el cierre; las suites de compras, cierres y garantías pasan.

## Tasks

T1 [S1–S22] Documento y direcciones visuales, canvas abierto y artboard elegido — route inline (diseño); done: `design/battery-warranty/` con manifest y artboards.
T2 [S1,S2,S5,S6,S7,S9,S11,S14,S20] Migración: caso, eventos append-only, préstamos, numeración por sucursal y guardas — route delegated (worker); done: `apps/api/migrations/065_warranty_cases.sql` y `warranty_cases_schema_test.go`, commit `57d69b6`; 4/4 en PostgreSQL real y el paquete de migraciones completo en verde.
T3 [S12,S17,S18] Migración del sembrado de usadas en `closing_material_lines`, con cierres históricos intactos — route delegated (worker); done en `808aa9d` (`066_closing_materials_used_pool.sql` y su schema test, con el esperado firmado y `apps/api/docs/closings.md` actualizado); el término "menos liquidaciones a chatarra" queda fuera porque el repositorio no registra ese hecho.
T4 [S1,S2,S11,S16] Paquete Go del caso: validación de serial y plazo, alta de las dos entradas, transiciones y matriz de resolución — route delegated; done en `ab35f2f` (`internal/warrantycase`, la entrada de garantía) y `d47b5b9` (la matriz del hallazgo, `069`).
T5 [S3,S8,S14,S19,S20] Store y HTTP: rutas del caso, comprobante PDF y guardas de actor — route delegated; done en `7eefb0e` (once rutas, `068`, montadas en `cmd/server`), `1f1e5c5` (comprobante) y `e1fa4e6` (contrato de esquema).
T6 [S4,S5,S6,S7] UI sucursal: registrar el canje, elegir el préstamo y emitir el comprobante — route delegated; done en `0aa2b70`, sobre el artboard elegido `design/battery-warranty/02-bandeja-de-casos.html` (handoff `implemented`).
T7 [S9,S10,S13,S14,S15] UI Almacén: mesa de casos, legajo, custodia y liberación — route delegated; done en `85f0b87` (mesa de fábrica, gated por lado).
T8 [S12,S15,S17,S18] Colas de trabajo y lectura del pool de usadas — route delegated; done en `808aa9d` y `ed52be8` (`066`, el pool firmado) y en las colas por fase de ambas pantallas; la cifra del pool no se publica todavía en la mesa del Almacén.
T9 [S21,S22] Verificación integral y cierre con evidencia — route inline; done: `go build ./...`, `go vet ./...` y `go test ./...` completos sobre fixture limpio (todo `ok` tras `e1fa4e6`), más `typecheck`, `build` y la suite del frontend (4 653 tests).

## Log

L1. User: "pa, ahora tengo que hacer lo siguiente.
que pasa si la sucursal vende una bateria fallda y viene a reclamar con su garantia. 
actualmente no gestionamos esto, pero como podemos gestionarlo?
Generalmente en el negocio, si una bateria llega fallada, se la envia a almacen, almacen la envia a fabrica y si esta todo OK se devcuelve arreglada, y se la devuelve al cliente. 

como gestionamos esto pa? exploremos como podemos hacer"

L2. User: "es algo complejo, porque tambien la sucursal puede enterarse que una bateria esta arruinada antes de venderse, talvez la probo y se da cuenta que esta fallada, entonces debe enviarse a almacen tambien."

L3. User: "ayudame a pensar como seria el flujo, porque la bateria tambien puede volver al comprado, como no volver si la fabrica vio que no lo cubre la garantia"

L4. User: "¿La sucursal cobra el arreglo cuando no está cubierto?: aqui nadie pierde, porque al cliente se le otorga una bateria usada para que pueda ir andando hasta que se revise su garantia, cuando vuelve la bateria nueva se le entrega al cliente (ojo hay casos en que el cliente nunca vuelve a reclamar su bateria nueva y se queda con la usada porque le funciona bien, entonces aqui tenemos un problema de decision no?), en caso de que la fabrica rechace la garantia, el cliente se queda con la bateria usada y la bateria daniana que viene de fabrica se queda como stock de baterias usadas. 

Vamos entendiendo?"

L5. User: "esto no es problema ni perdida, porque al fin y al cabo las baterias usadas se utlizaran luego como chatarra, etc entonces no es perdida.
 
1.Si las baterias usadas tienen numero de serie, pero no solemos anotarlas al prestarlas ni anotarlas en el sistema
2.El prestamos sale donde haya la bateria que el cliente necesita, algunos casos la sucursal otros casos almacen, otros casos otras sucursales. 
3. Aqui es indeterminado los dias
4. MMMMM dame opciones para este caso. 

Tambien debes tener en cuenta que no tenemos un inventario de baterias usadas, y no se hasta que punto es necesario"

L6. User: "no tenemos inventario como tal de baterias usadas. 
Pero si tenemos el historial de compras de baterias usadas. Entiendes? por ahi no podrian ir los tiros?"

L7. User: "dame una descripcion completa de lo que te estoy pidiendo. De lo que llevara esta vertical de momento, aun no hagas codigo
quiero tener claro que cubre esta vertical"

L8. User: "1.la sucural le debe la respuesta al cliente y el almaen solo mueve la bateria. 
2/ sigue con la venta original
3. correcto lo que dice tu recomendacion nomas

con esto creamos una rama y comenzmaos, tambien con los mocksups. pero todo en una rama nueva, quiero ver como va funcionar"

L9. Exploración (evidencia, no requerimiento): `purchase_used_lines` registra usadas por unidades de código de modelo, sin marca, polaridad, serial ni proveedor (`apps/api/migrations/032_purchases.sql:75-84`, `:72-73`). `closing_material_lines` ya compara esperado contra contado por modelo, con el esperado sembrado solo desde las compras de la ventana (`apps/api/migrations/045_closing_materials.sql:70-77`, `:120-133`). Nada de usadas entra en `inventory_balances` (`045:31-34`).

L10. Diseño: `design/battery-warranty/` con cinco artboards — `01-mostrador-canje.html` (el canje en una pantalla), `02-bandeja-de-casos.html` (cola primero, detalle al costado), `03-riel-de-etapas.html` (riel de fases y las tres unidades del caso), `04-comprobante-prestamo.html` (A4 que el cliente se lleva) y `05-mesa-almacen.html` (mesa de fábrica). El artboard elegido para implementar queda pendiente de la revisión del usuario; los otros son alternativas.

L11. Sistema de diseño: `design/system.md` re-sincronizado el 2026-11-23 sobre las 17 hojas (3 313 líneas). El token layer no cambió: 6 custom properties, 69 colores, 16 tamaños, 10 radios, 10 sombras. `system.html` no requirió cambios.

L12. User: "okey me parece bien, entonconces comencemos pa". Artboard elegido: `02-bandeja-de-casos.html` — cola primero con el detalle al costado, que era la recomendación. Los otros cuatro quedan como alternativas. Handoff de implementación abierto; el registro del canje entra como acción desde la bandeja.

L13. Arranque del slice 1: T2, la migración del caso, sus eventos append-only y sus préstamos, delegada. Se congeló el vocabulario en S23 para que backend y frontend avancen por separado.

L14. T2 cerrada y commiteada (`57d69b6`). Evidencia del worker, que condiciona T4:

- (a) `stock_adjustments` exige una razón libre de 1 a 500 caracteres (`022:15`) pero es sólo del Almacén: `022:44-45` rechaza toda sucursal con `LS005`, y `stock_entries` hace lo mismo (`021:38`). No existe ningún catálogo de motivos de stock en el repositorio, y ningún motivo existente sirve para "batería que sale de la sucursal a reparación".
- (b) Los únicos documentos que hoy escriben `inventory_balances` son `stock_entries`, `stock_adjustments`, las transferencias y las ventas (`021:96`, `022:106`, `007:72`, `008:183`, `025:143`). El caso no toca ninguno.
- (c) Brechas que quedan para T4/T5: el grafo de transiciones (S9 hoy sólo exige que la fase cambie dentro del vocabulario congelado), la unicidad del reclamo por serial (se permite un caso nuevo si una batería ya reparada vuelve a fallar; lo que no se repite es el reclamo, y eso lo resuelve el store), y la compuerta aviso→liberación con el reparto de actores de S14/S19.
- (d) El número persistido es `C-<location>-<correlativo>`; la forma con letra del mockup es una etiqueta de sucursal que la base no posee. La UI imprime el número persistido.
- (e) TDD: la migración se escribió antes que su test, así que no hay RED observado en el primer paso. Sí hubo dos fallos reales durante el ciclo —un `RAISE` con `DETAIL` nulo y un código de error esperado distinto— corregidos y verificados en el fixture.

L15. T3 commiteada (`808aa9d`): el esperado de usadas ahora es firmado — compras de la ventana, más las unidades que fábrica devuelve como no cubiertas, menos los préstamos otorgados; sólo un total positivo se vuelve línea. Los cierres ya creados conservan la cantidad que congelaron (probado) y el bloque de chatarra quedó idéntico a `047` (comparado término por término). Dos hallazgos:

- No existe ningún documento que liquide chatarra ni que convierta una usada en chatarra. S17 nombra "menos liquidaciones a chatarra" como término y no hay hecho que leer, así que se cae del alcance: la conversión es una brecha previa a esta vertical y el cierre la absorbe como diferencia. Si el negocio la quiere, es un documento nuevo y otro slice.
- `warranty_case_loans.fate` no llevaba fecha, así que una usada devuelta en el canje quedaba restada del pool para siempre. Como el canje exitoso devuelve siempre el préstamo, el pool habría quedado corto de forma permanente. Se corrige en el mismo slice.

L16. Decisión sobre la baja de stock. Pregunta: hoy `stock_entries` y `stock_adjustments` rechazan a toda sucursal con `LS005` y no existe ningún motivo de stock, así que una unidad fallada en góndola no tiene por dónde descontarse. Opciones presentadas: (1) la sucursal la da de baja al registrar el caso, (2) la sucursal registra y el Almacén confirma, (3) transferencia normal al Almacén y baja allá. User: "dale" — opción 1. Se acota como la única escritura de stock de una cuenta de sucursal, limitada al alta de un `stock_defect` en su propio local, con motivo, actor y evento como evidencia. Corregido S16 en consecuencia.

L17. T4 en dos mitades commiteadas: la entrada de garantía en Go (`ab35f2f`, `internal/warrantycase`) y la baja de stock del hallazgo en góndola (`08ea1ce`, migración `067`). La baja quedó como la única escritura de stock de una cuenta de sucursal, con `LW016` (no tiene esa cantidad), `LW017` (dejaría el saldo bajo lo reservado) y `LW018` (el motivo queda congelado).

L18. Evidencia del worker sobre el cierre, que decide el resto:
- El cierre de sucursal **no deriva el stock de documentos**: lo lee en vivo de `inventory_balances.existing` al abrir (`035:137-147`) y vuelve a leerlo antes de cerrar (`035:373-378`, `LC018`). Una baja registrada antes de abrir ya está dentro del esperado, así que no imputa faltante. Probado.
- **Defecto encontrado**: la unidad dada de baja sigue físicamente en la sucursal hasta que sale, y el caso no escribe transferencia. Si el operario la cuenta, el cierre aplica la cantidad contada (`035:382-385`) y la unidad **resucita en stock**: la baja se borra sola. Se corrige publicando por línea de conteo cuántas unidades de la variante están en un caso y no en stock, derivado en lectura, sin tocar el esperado ni la aritmética del cierre, y sin decidir política.
- Ventana documentada y no absorbida: una baja registrada con la rendición abierta hace que el cierre **se niegue a cerrar** (`LC018`) hasta que alguien concilie. Es ruidoso, no silencioso, y se deja así a propósito.

L19. Custodia publicada en la lectura (`cdd42da`): cada línea de conteo lleva `held_in_case_quantity`, derivado en lectura, con las unidades de su variante que un caso `stock_defect` tiene en la sucursal y que ya no están en el balance. No toca el esperado, ni el sembrado, ni la aritmética del cierre. Tres pruebas: aparece, es cero sin caso, y el cierre sin caso aplica exactamente lo contado.

L20. Dos residuos que quedan anotados y no se absorben callados:
- El número todavía **no viaja por el cable**: el DTO vive en `httpapi/closings.go`, fuera de la superficie de esa unidad. Se engancha en T5, con las rutas del caso.
- Una variante cuya stock entero se dio de baja **no tiene fila de balance**, así que la hoja no siembra línea y el número no tiene dónde publicarse. Si el operario agrega esa variante a mano y la cuenta, el cierre la aplica y la unidad vuelve. Requiere un acto deliberado sobre una variante que el sistema dice que no existe, no un descuido; se deja documentado en lugar de inventar política.

L21. T5 detenida por el worker con tres hallazgos correctos: el store expone seis operaciones y no tiene `List`, `OpenStockDefect`, `RegisterNotice`, `DeliverExchange` ni `AuthorizeRelease`; `065:360-365` rechaza un evento cuya fase iguale la actual (`LW006`), así que el aviso y la liberación no pueden colgarse del historial de fases; y ningún handler de `httpapi` toca SQL, así que la persistencia no puede vivir en el transporte. Resolución del orquestador, sin decisión nueva del usuario:
- Las operaciones faltantes van al store (`internal/warrantycase/`), nunca a `httpapi`.
- Nuevo `068`: `warranty_case_events.kind` con `phase | notice | release`, y `LW006` pasa a exigir que un evento de fase cambie la fase y que un aviso o una liberación no la cambien. Un solo historial, sin fases nuevas.
- La liberación **sí escribe el balance**: S14 ya dice que la unidad liberada pasa a stock vendible, y es el espejo exacto de la baja de `067`. Son las dos únicas escrituras de stock de la vertical, y las dos son el caso cruzando la frontera entre stock y custodia. La instrucción previa de "no mover stock fuera de la puerta de baja" era mía y estaba de más.

L22. Comprobante en PDF (`1f1e5c5`): una A4 desde datos persistidos, con las condiciones del canje y el número persistido del caso. Sin migración: todo lo que imprime ya existía.

L23. Pantalla de sucursal (`0aa2b70`): bandeja con filtros por fase y origen, detalle con línea de tiempo, custodia y préstamos, alta del canje con búsqueda por serial, comprobante descargable, aviso y entrega. Verificado acá: 61 tests de los archivos nuevos y de navegación, typecheck y build en verde.

L24. Brecha aceptada y no tapada: la fila de la bandeja no lleva el nombre del cliente ni el instante del aviso, porque el contrato publica sólo la cabecera del caso. El artboard los mostraba por fila y ahora viven en el detalle. Va como seguimiento: sumar la referencia de la venta a la fila cuesta un join en el store, el DTO, el documento y el decodificador estricto del frontend; no bloquea el circuito y no se hace en este slice para no abrir el contrato a mitad de camino.

L25. Pantalla del Almacén (`85f0b87`): mesa de fábrica con las cuatro preguntas del escritorio, la bandeja por fase, el detalle con línea de tiempo y custodia, y sólo los actos que el contrato le da al Almacén. La sección quedó con acceso por lado: una cuenta de sucursal no ve el escritorio y una del Almacén no ve la bandeja de sucursal.

L26. Incidente de proceso, corregido: un `git add -A` mío mezcló el fix del contrato de esquema con la pantalla del Almacén que estaba en vuelo en ese momento. Se separó en `e1fa4e6` (API) y `85f0b87` (frontend) reordenando la rama antes de publicarla. La lección: con workers en background, `git add` por ruta, nunca `-A`.

L27. Verificación integral sobre fixture limpio desde cero, con la rama ya ordenada:
- `go build ./...` y `go vet ./...` sin salida; `go test -count=1 ./...` con todos los paquetes en `ok`, incluidos `httpapi`, `closings`, `migrations`, `transfers` y `warrantycase`.
- La corrida completa encontró un único fallo que ninguna unidad vio: `internal/bootstrap` congela la lista exacta de tablas del dominio y las tres nuevas no estaban. Corregido en `e1fa4e6`.
- Frontend: `typecheck` en 0, `build` en 0, y 4 653 tests pasando sobre 93 archivos (1 skipped).
- Los tests de `TransferPending` y `AccountAdministration` son inestables por carga y ya lo eran en la base: el worker lo probó copiando la base y fallando 2 de 5 corridas sin este cambio.

L28. Estado final: el circuito completo funciona de punta a punta y está verificado. Queda afuera, por decisión y anotado: el nombre del cliente en la fila de la bandeja, el desenlace de `refused_at_warehouse` en un hallazgo de góndola, el documento de conversión de usadas a chatarra, la cifra del pool en la mesa del Almacén, y el aviso previo a la liberación cuando el caso ya está cerrado.

L29. User, ante la pantalla de Compras con saldo 0: "pero como me dejo prestar si aqui hay 0? no entiendo". Diagnóstico: el préstamo declaraba el origen sin validarlo; la sucursal tenía 0 compradas y el sistema lo aceptó igual. El saldo que ya existe es compradas menos entregadas al Almacén, y como la sucursal entrega todo en cada cierre, su saldo normal es 0 y el stock vive en el Almacén, que no registra nada.

L30. User: "entonces debemos manejar mejor el stock de baterias usadas. como hacemos esto? stock de baterias usadas de cada sucursal y de almacen". Respuestas del usuario a las tres preguntas de diseño: (1) la chatarra se vende; (2) "Osea siempre es chatarra solo que la diferenciamos como bateria usada para que no sea como aluminio cobre etc" — la usada es la misma corriente de salida, contada por unidad y modelo en vez de por kilo; (3) "Solo por modelo esta bien. porque por el modelo se puede estimar la capacidad por ejemplo NS60ZL es de 60AH".

L31. User: "AUn no dejemos, la venta de chatarra por parte de almacen para otra vertical. 1. esto aun no va en esta vertical 2. AUN NO 3. AUN NO". Alcance de esta vertical: el stock de usadas por local y modelo, la validación del origen del préstamo y la pantalla del Almacén. La venta de material, sus dos tipos de línea, el fondo de materiales del Almacén y todo movimiento de dinero por material quedan para otra vertical.
