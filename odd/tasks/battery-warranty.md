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

S30. El préstamo de una usada sólo se registra con un modelo de la lista cerrada, sin escape. La lista son los modelos que ya existen en los flujos de usadas de la instalación: compras de usadas, conteos de una rendición cerrada y devoluciones de fábrica al pool. Los préstamos no alimentan la lista, así que un modelo no puede entrar al sistema por el camino del préstamo. Un modelo que no está en la lista se rechaza con `LW034` y no crea ningún modelo. El stock en el origen (`LW033`) es otra pregunta y se sigue exigiendo: primera la existencia, después la disponibilidad.

S31. La unidad de un caso cuyo destino es `stock` **y cuyo veredicto es `repaired` o `replaced`** no se entrega a un cliente: entra al stock vendible por la liberación. La entrega de un caso así se rechaza con `LW035` (`409 unit_belongs_to_stock`), porque el acto de la entrega afirma que la unidad salió con el cliente y ninguna pantalla puede afirmar un hecho que no pasó. Un caso de destino `stock` cierra con el aviso registrado y la liberación autorizada por el Almacén (S14), no con la entrega. Y el desenlace del préstamo en la entrega arranca sin responder: ninguna pantalla elige por el mostrador un dato que mueve el stock del pool, porque un desenlace decidido es final (`LW012`) y no se reescribe.

S32. Un caso no termina con un préstamo sin desenlace. La liberación de una unidad de destino `stock` se rechaza con `LW036` (`409 loan_fate_open`) mientras el caso tenga un préstamo en `open`, porque el stock del pool se deriva de ese hecho: cerrar sin él deja una unidad contada para siempre en el lugar equivocado. La entrega ya resuelve los préstamos abiertos (S23); la liberación no decide por la sucursal, la obliga a decidir. `release_case_unit_to_stock` no toca el desenlace y no debe decidirlo: sólo se niega a cerrar mientras falte.

S33. El desenlace no se ofrece como formulario permanente. El detalle del caso muestra el estado de cada préstamo —`sin decidir · se pide al cerrar el caso`— y el desenlace se registra por el hecho que ocurrió, no por un desplegable: `La usada falló`, `El cliente la devolvió`, `El cliente se la quedó`, `Se perdió`. Cada uno pide confirmación, porque un desenlace decidido es final (`LW012`) y no se reescribe. No hay desplegable vacío ni botón habilitado sin elección: la opción no puede venir ofrecida.

S34. El orden de las acciones sigue la dependencia: primero lo que falta, después lo que desbloquea. El préstamo de la usada va antes que `Sale de la sucursal`, que depende de él. Y la confirmación de que un caso se abrió por un serial no se pinta como alerta: una buena noticia no usa el color de un problema.

S35. Los flujos de la vertical se prueban de punta a punta en un navegador real con Playwright, contra el servidor local y una base descartable. Cubre: (1) el reclamo por serial abre el caso con los datos de la venta, sin tipear cliente ni fecha; (2) sin préstamo registrado la sucursal no puede enviar el caso al Almacén; (3) el modelo del préstamo se elige de una lista cerrada y sin modelo el préstamo no se registra; (4) el desenlace no se ofrece como campo: se declara por el hecho ocurrido y exige confirmación; (5) un caso de destino `stock` no ofrece la entrega, y la liberación se niega con `LW036` mientras el préstamo siga sin desenlace; (6) decidido el desenlace, la liberación cierra el caso y la unidad entra al stock vendible una sola vez. S35 sigue con dos puertas que el arnés todavía no recorre. (7) El hallazgo en góndola: la sucursal registra el caso de una unidad que falló en su propio stock; el acto que la da de baja la saca del stock vendible, y con veredicto `repaired` o `replaced` la unidad vuelve al stock de la sucursal una sola vez. La prueba recorre el alta, la baja y la reposición en el navegador y verifica el stock antes y después de cada acto. (8) La entrega al cliente: un caso resuelto de destino `customer` se cierra entregando el canje, ese acto pide el desenlace del préstamo y arranca sin responder, el caso queda como entregado al cliente, y sin desenlace no hay entrega.

Lo que el flujo no ejercita —la venta que da el serial y la usada del pool— se arregla por el API, no por la pantalla, para que la prueba sea determinista y se pueda repetir sobre una base recién sembrada.

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

T10 [S30] Lista cerrada de modelos del préstamo: guarda `LW034`, la lista que se ofrece y las dos pantallas sin texto libre — route inline el servidor y delegada la pantalla; done: `0a02eca` (072, `used_battery_models()`, `LW034`, el mapeo HTTP y los tests sobre PostgreSQL real) y `073f7a2` (los dos formularios eligen de la lista del origen, sin input de modelo en toda la app); frontend 4 697 tests, typecheck y build en 0.

T11 [S31] El destino manda: la entrega no cierra un caso de destino `stock`, la liberación sí, y el desenlace del préstamo arranca sin responder — route delegated (dos workers, servidor y pantalla); done: `0712891` (073, `LW035` en las dos direcciones, la liberación cierra y vende la unidad una vez, la regla llaveada por destino y veredicto) y `9b6032a` (el desenlace arranca sin responder y la entrega no se ofrece para stock); Go completo sobre PostgreSQL real, `vet` y `build` en 0, frontend 4 701 tests, typecheck y build en 0. Ajustes autorizados en dos tests de esquema: el fixture `repaired`→`not_covered` de `068` (probaba el pool de usadas, no la unidad vendible) y la exención de reescritura en el de `069`.

T12 [S32] La liberación no cierra un caso con un préstamo sin desenlace: `LW036`, el mapeo HTTP y los tests sobre PostgreSQL real — route delegated (servidor); done: `b86c838` (074 reescribe la liberación de 073 con una sola guarda nueva, condicionada a la liberación que cierra el caso y juzgada después de `LW025`; no escribe `warranty_case_loans`, sólo se niega; `ErrCaseHasOpenLoan` distinto de `ErrLoanFateOpen`, `409 loan_fate_open` separado del `400 loan_fate_required`). Verde sobre PostgreSQL real: `migrations` 126 s, `warrantycase` 15 s, `httpapi` 271 s, `vet` y `build` en 0. Ajuste autorizado fuera de la superficie del worker: en `store_unit_destined_to_stock_test.go` el test de la liberación de 073 decidía que el desenlace quedaba `open`; ahora la sucursal lo decide antes y la aserción que importa —la liberación no lo reescribe— se mide sobre el valor decidido.

T13 [S33, S34] El desenlace se registra por el hecho y no por un desplegable, el préstamo va antes que el envío y la confirmación deja de parecer una alerta — route delegated (pantalla); done: `e08a924` (el formulario permanente y su `<select>` desaparecen; cada préstamo abierto dice `Desenlace: sin decidir · se pide al cerrar el caso` y los cuatro hechos se registran por acción con confirmación, porque `LW012` hace final la decisión; el bloque del préstamo pasa arriba de `Sale de la sucursal`; la confirmación del caso abierto deja el recuadro tintado por uno neutro y conserva `role="status"`; el `409 loan_fate_open` del cliente entra con su mensaje). Suite web completa 4 712 tests, typecheck y build en 0.

T14 [S35] Los flujos de la vertical de punta a punta con Playwright sobre el servidor local — route delegated (e2e); done: `8ea0cf1` (configuración propia en `apps/web/playwright.config.ts` y directorio `apps/web/e2e/warranty/`, separado del arnés de costura que ya vivía en `e2e/`; una sesión por rol guardada fuera del árbol porque el servidor limita los inicios de sesión por IP; los datos de armado van por API y nunca por pantalla; cada spec crea su propia venta con serial único y su propio modelo de usada, así que ninguno depende de otro). Cuatro flujos en verde: el reclamo por serial, la compuerta del envío, la lista cerrada de modelos y el desenlace por hecho con su confirmación.

T15 [S31] La mesa del Almacén ofrece la liberación del caso de destino `stock` que cierra el caso, en espejo de `warranty_case_unit_bound_for_stock` — route delegated (pantalla); done: `d335ef5` (el predicado del Almacén espeja el par del servidor; el lector deriva la fase del último evento —la regla que el servidor ya aplicaba, en vez de una más estricta que nunca prometió— y así acepta la liberación que cierra; el rótulo del cierre sigue al acto que lo cerró; la custodia queda con una sola autoridad y las dos pantallas leen la misma cifra). Los ocho e2e en verde contra la app real sin nada marcado como fallo esperado, suite web 4 718 tests, typecheck y build en 0.

T16 [S31, S34] La sucursal nombra el cierre por su acto y la custodia con la misma autoridad que el Almacén — route delegated (pantalla); done en `6e4f48a`: la pestaña del detalle consume `warrantyPhaseShortLabel` y el bloque de custodia usa `warrantyUnitBoundForStock`, sin copia estática que valga para los dos desenlaces. La copia del caso de destino al cliente queda palabra por palabra. **La fila de la bandeja sigue diciendo `Entregada`**: la fila es sólo cabecera por contrato, sin veredicto, destino ni historia, así que ninguna autoridad del modelo la responde; se resuelve publicando el acto de cierre en el DTO de la fila, y eso espera decisión.

T17 [S35] El arnés de e2e entra en un gate de tipos, porque una prueba que nadie tipa se pudre callada — route delegated (configuración); done: `52364e8` (`tsconfig.e2e.json` cubre `playwright.config.ts` y `e2e/warranty/**`; `typecheck` corre los dos proyectos y `build` lo invoca, así que el camino del operador también revisa el arnés). El gate se probó con una sonda a propósito: el config viejo la dejaba pasar en 0 y el nuevo la rechaza en 1.

T18 [S31] La sucursal deja de reafirmar el par destino+veredicto por el destino solo: consume la autoridad del modelo y ofrece la entrega donde el servidor la acepta — route delegated (pantalla); done en `6e4f48a`: `unitBelongsToStock` desaparece y la entrega y el bloque del acto de cierre consumen `warrantyUnitBoundForStock`; un reclamo `not_covered` con destino `stock` vuelve a ofrecer la entrega que el servidor acepta, y el par `replaced`+`stock` conserva la dirección contraria.

T19 [S35 (7), (8)] El hallazgo en góndola y la entrega al cliente recorridos en el navegador — route delegated (e2e); done: `9cfbe72` (el alta del hallazgo **es** la baja y se registra en la pantalla de la sucursal; el veredicto se registra en la mesa del Almacén y es el acto que repone; el viaje no mueve nada y la reposición ocurre una sola vez, con la segunda resolución rechazada. La entrega al cliente pide el desenlace, arranca sin responder, y sin él el servidor rechaza con `400` sin escribir: el caso sigue `resolved` y el préstamo `open`. Con desenlace, el caso cierra rotulado `Entregada al cliente` y nunca `Cerrada por liberación`, sin mover stock). Suite e2e 11 tests en verde, `typecheck` en 0. Sin rojo previo a propósito: la cobertura es el entregable, no hay conducta nueva que hacer fallar.

T20 [S34] La frase de la baja concuerda con la cantidad y se escribe en un solo lugar: la confirmación del alta dice «1 unidad dada de baja», no «1 unidad dadas de baja» — route delegated (pantalla); done: `warrantyUnitsWrittenOff(quantity)` en el modelo devuelve la frase entera y las dos pantallas la consumen; prueba en rojo sobre el texto visible de cada pantalla antes del arreglo. Suite web 4 727 tests, `typecheck` en 0, e2e 11 en verde contra `index-BI54QoHp.js`.

T21 [S34] La fila de la bandeja publica el acto que cerró el caso: el DTO de la fila lo lleva y las dos bandejas rotulan por él — route delegated (servidor y pantalla); done: `closed_by` aditivo derivado del último evento en `caseColumns` y `ClosedActOf` como regla única, contrastado contra la historia en `warrantyCaseRecord` (un documento que se contradice es inválido, nunca se adivina); `warrantyRowPhaseLabel` y `warrantyEventLabel` rotulan las dos bandejas y las dos líneas de tiempo; una fila sin acto dice `Cerrada` y no afirma ninguno. Suite web 4 733, Go `warrantycase`+`httpapi` en verde, vet y build en 0, e2e 11 en verde con binario y bundle reconstruidos juntos (`index-dxpBF4cB.js`).

T22 [S31] La custodia del Almacén decide por el par destino+veredicto, no por el destino solo — route delegated (pantalla); done: `custodyAbsentNote(value)` parte la frase mentirosa en tres verdaderas (unidad de stock reparada o reemplazada, no cubierta intacta, otro veredicto honesto); prueba en rojo sobre el caso alcanzable `repaired`+`stock` sin tramo de resolución. Suite web 4 728 pass / 1 skip, `typecheck` 0.

T23 [S36, S36.1, S36.2, S36.3] El ajuste de stock se generaliza al local de la sesión y se conecta la guarda de sucursal congelada: servidor (migración 075, paquete `stockadjustments`, httpapi, tests reescritos) — route delegated; done: la ubicación sale de la sesión en las seis capas, `LS005` pasa a exigir integridad, `assert_branch_not_frozen()` queda conectada a `stock_adjustments` (409 `branch_frozen`), otro local es 404 y no 503, y una clave de operación gastada por otro local es 409. Tests reescritos, ninguno borrado. Go `stockadjustments`+`httpapi`+`migrations` en verde (48/319/235), vet y build en 0; 075 verificada aplicada en la base viva (trigger `admit_frozen_branch_stock_adjustment` presente, `LS005` sin la regla del Almacén); e2e 11 en verde contra el binario nuevo. T25 [S36] La pantalla del ajuste deja de exigir el local 1 y le da a la sucursal su acto — route delegated; pending.

T24 [S35] La entrega: cinco PRs encadenados según el plan de este documento — route inline; pending.

S36. La sucursal corrige su propio stock vendible con un acto explícito, porque hoy el ajuste existe sólo para el Almacén (`LS005`) y una diferencia real no tiene ninguna salida: la única forma de arreglarla es falsear una transferencia o un ajuste del Almacén, que afirman un recorrido que no ocurrió. El acto exige un motivo escrito, declara lo esperado contra lo contado, mueve una sola variante y queda registrado con su autor y su local, igual que la corrección de una rendición. El Almacén conserva el suyo sin cambios, y un local no corrige el stock de otro: cada uno corrige lo que cuenta.

S36.1 [decisión del humano, opción A] Es **un solo documento**, el que ya existe: se generaliza el ajuste en vez de abrir un acto aparte, para no tener dos caminos escribiendo el mismo balance ni la misma regla escrita dos veces. La ubicación deja de estar fijada en el código y sale de la sesión del que ajusta; el trigger deja de exigir el Almacén y pasa a exigir integridad (el local existe, la reversa es del mismo local), y la autoridad la ejerce el servidor: la sesión sólo ajusta su propio local.

S36.2 [la guarda que hoy falta] `035_branch_guards.sql` omite a propósito `stock_adjustments` de `assert_branch_not_frozen()` porque "una guarda acá nunca podría dispararse". Deja de ser cierto con S36.1: con una rendición abierta, una sucursal congelada movería su propio stock por fuera del corte ya contado. La misma migración que abre el documento **conecta esa guarda**.

S36.2.1 [corrección] El comentario de `035` **no se puede reescribir**: las migraciones aplicadas están selladas por checksum y el arranque rechaza cualquier byte cambiado. La corrección vive en la cabecera de `075`, que cita la premisa muerta y explica por qué la guarda ahora corresponde. Lo que S36.2 pedía se cumple en el fondo; el mecanismo es otro porque el archivo viejo es inmutable.

S36.3 Los tests que hoy fijan la regla contraria (sucursal rechazada con `LS005`, actores de otros locales con `ErrForbidden`) se **reescriben** como parte de la spec, no se borran: pasan a probar que cada local ajusta lo suyo, que ninguno ajusta lo ajeno, y que la sucursal congelada no ajusta.

## Entrega

La rama `feat/battery-warranty` no se entrega como un solo PR: al cerrar T13 medía 21 128 líneas autorizadas en 34 commits (8 042 `apps/api/internal`, 6 390 `apps/web/src`, 5 009 `apps/api/migrations`, 493 `apps/api/docs`, el resto diseño y este documento). Eso no se revisa. Se entrega como PRs encadenados, cada uno contra el anterior, en este orden de dependencia:

1. **El caso y el préstamo** — migraciones 065–066, el núcleo de `warrantycase`, `httpapi`, la pantalla de casos con su comprobante y los mockups. El reclamo existe, la usada se presta, el caso se mueve entre etapas.
2. **El viaje y la resolución** — 067–069: baja por hallazgo, aviso y liberación, matriz del hallazgo, reposición, y la pantalla del Almacén.
3. **El stock de usadas** — 071: `used_battery_stock()`, `LW033`, la pantalla de Stock de usadas y lo que la rendición muestra de ella.
4. **Las reglas finas** — 072–074 y la pantalla del desenlace por hecho: lista cerrada (`LW034`), el destino manda (`LW035`) y el caso no cierra con un préstamo sin desenlace (`LW036`).

Regla de corte: cada commit es de una tarea y va por ruta, nunca `git add -A`; el corte de cada PR se anota acá con su rango de commits cuando se abre. El PR 4 termina en `b86c838`, con `e08a924` (la pantalla del desenlace) como penúltimo. Un quinto PR, sobre el cuarto, lleva el arnés e2e y el arreglo que él destapó: `8ea0cf1` y `d335ef5`. Push, apertura de PR y merge son decisiones del usuario, no del agente.

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

L32. User, ante la pantalla de Stock de usadas que muestra una fila `Sucursal A · CAR · 0 unidades`: "porque me dejo crear un modelo de bateria llamado CAR, si no existe? me explicas". Diagnóstico: el modelo del préstamo se valida por forma (`^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$` en `065`, `CanonicalModel` en Go) y nunca por existencia, porque el pool de usadas vive fuera del catálogo y el sistema aprende los modelos de sus propios hechos. `CAR` es una marca del catálogo escrita en el campo del modelo. Decisión del usuario, entre tres opciones: "correcto B. solo lista cerrada" — sin texto libre y sin alta de modelos nuevos desde el préstamo.

L33. User: "que pasa si la bateria usada se entrego al cliente y este ya no volvio por su bateria nueva. Entonces, la bateria que volvio de fabrica vuelve a stock vendible, y no se recupera la bateria usada. existe este caso?" Sí existe (S23: `kept_by_customer` + destino `stock` son campos distintos). Al revisar el movimiento real del usuario aparecieron tres defectos: el desenlace de la entrega venía pre-elegido como `returned` y contradijo la nota "se quedó la batería usada" (el Almacén muestra 5 `BT70L` disponibles y tiene 4), el caso de destino `stock` se cerró con la entrega sin aviso ni liberación, y la unidad reparada quedó fuera de todo stock.

L34. User, ante la propuesta de los tres arreglos: "dale arranca". Alcance autorizado: (1) el desenlace arranca sin responder; (2) con destino `stock` no se ofrece la entrega, se ofrece la liberación; (3) un caso de destino `stock` no cierra sin aviso y liberación. La reparación de la fila ya escrita (`returned` → `kept_by_customer` en el préstamo del caso 8) queda para después, con autorización aparte.

L35. Reparación de los datos del caso 8: el usuario autorizó el `UPDATE` del desenlace (`returned` → `kept_by_customer`; Almacén `BT70L` 5 → 4, verificado con `used_battery_stock()`). La segunda reparación no se pudo hacer como se recomendó: `admit_stock_adjustment()` rechaza todo ajuste cuya ubicación no sea el Almacén (`LS005`), así que una sucursal no tiene acto para corregir su stock vendible. Ante eso el usuario ofreció descartar la base: "si te estas haciendo bola con los datos que hay actualmente. entonces no importa podemos borrar la DB porque no son datos de produccion, son datos falsos". Se respaldó (`/tmp/luson-before-reset.sql.gz`) y se recreó el entorno: catálogo de 190 variantes, tres cuentas nuevas, cero casos. El hueco de la corrección de stock de sucursal queda anotado, sin decidir.

L36. User: "el sistema puede seguir sin prestar una bateria?" Hoy no: sin préstamo el caso no sale de la sucursal, así que una sucursal sin usadas no puede procesar reclamos y un cliente que no quiere la usada no tiene camino. Recomendación: el préstamo debería ser opcional pero declarado (`no se prestó` con motivo), del mismo modo que el desenlace arranca sin responder. El usuario no decidió: queda abierto, no es parte de S32–S34.

L37. User: "pero que pasa si lo respongo ahora?" y después "pero si no se debe responder ahora, no me deberia ni aparecer esa opcion...". El riesgo de responder temprano es `LW012` (el desenlace decidido es final) sobre un hecho que todavía no ocurrió; el defecto de la pantalla es ofrecer el formulario en la etapa en la que es imposible saberlo. De ahí S33: el desenlace existe, pero se ofrece como hecho, no como campo.

L38. User: "dale eso hagamos entonces". Autorizado el lote de cinco: `LW036` (el único defecto), el desenlace por hecho, el orden de las acciones de la sucursal, el botón sin elección y el color de la confirmación.

L39. User: "bien pa. ahora quiero que reinicies la db y crees que tus credenciales, luego utilizando plawrigth quiero que testees los flujos de las garantias". Base reiniciada y resembrada (190 variantes, cero casos) con cuentas propias del agente: `bot_almacen`, `bot_sucursal_a`, `bot_sucursal_b`, claves `Bot.Almacen.2026`, `Bot.SucursalA.2026` y `Bot.SucursalB.2026`, con `must_change_password` apagado para que la prueba sea repetible. El primer intento de provisionar lo rechazó `auth.ValidCredentials`: la clave de una cuenta medía 10 bytes y el mínimo es 12.

L40. Estado del arnés de e2e: `@playwright/test` 1.62.1 ya estaba en `apps/web/package.json` pero no había configuración ni navegadores; `apps/web/e2e/` contiene pruebas de costura de otra índole (`.mjs`, namespaces y compose), no flujos de UI. Chromium quedó instalado y los flujos nuevos viven en su propio directorio, con su propia configuración, para no tocar ese arnés.

L41. Primera corrida de e2e, ocho pruebas: S35 (1)-(4) en verde y **un defecto real en S35 (5)-(6)**. `warehouseWarrantyModel.ts:104` define `warehouseReleaseSubject` como reclamo con destino `customer`, así que un caso de destino `stock` con veredicto `repaired`/`replaced` —el que `073` cierra por liberación— nunca recibe el formulario de liberación en la mesa del Almacén: la pantalla publica "Sin movimiento" y "no tiene ninguna unidad que liberar". Como la sucursal ya no ofrece la entrega (S31), ese caso **no puede cerrarse por ninguna vía** y `LW036` es inalcanzable desde la pantalla. El servidor está correcto: con el préstamo abierto responde `409 loan_fate_open` y, decidido el desenlace, cierra y suma la unidad una sola vez (verificado por HTTP). El defecto es sólo la lectura de la pantalla y completa S31, que ya estaba autorizada: T15.

L42. La corrida de e2e encontró el defecto que ninguna otra prueba vio —la mesa del Almacén no ofrecía la liberación del caso de destino `stock`— y al arreglarlo aparecieron dos más del mismo acto: el lector rechazaba la fase que la liberación publica, y la custodia tenía dos autoridades. Los tres quedaron en `d335ef5` y la corrida final da ocho de ocho en verde, sin nada marcado como fallo esperado. Queda anotado y sin tocar: `WarrantyCases.tsx` conserva tres textos con el vocabulario viejo (el rótulo del caso cerrado en la bandeja y en el detalle, y la copia del bloque de custodia), visibles ahora que esa pantalla muestra la custodia; y el directorio `apps/web/e2e/` no entra en ningún gate de tipos ni de lint.

L43. User: "dale seguimos". Autorizado el lote que la corrida dejó suelto: T16 (los tres textos de la sucursal que todavía hablan del cierre por entrega y de una custodia que no es la suya) y T17 (el arnés de e2e bajo un gate de tipos).

L44. T16 y T17: el gate de tipos del arnés quedó (`tsconfig.e2e.json`, enganchado al `typecheck` que corre `build`, y probado con una sonda deliberada que el gate viejo dejaba pasar). La pestaña del detalle y el bloque de custodia ya nombran el cierre por su acto, pero **la fila de la bandeja sigue diciendo `Entregada`** para un caso cerrado por liberación: la fila es sólo cabecera por contrato, sin veredicto, destino ni historia, así que ninguna de las dos autoridades del modelo la puede responder. Queda sin decidir entre publicar el acto de cierre en la fila (campo aditivo en el DTO del servidor, verdad por fila) o aceptar un `Cerrada` neutro (se pierde `Entregada al cliente`, que hoy es verdad). Y apareció un defecto de conducta: `unitBelongsToStock` (`WarrantyCases.tsx:109`) reafirma S31 por el destino solo, así que para un reclamo `not_covered` con destino `stock` —el que va al pool de usadas por `LW025`— la sucursal esconde la entrega que el servidor acepta y anuncia una liberación que el servidor rechaza: el caso queda sin salida. S31 estaba escrita con la misma imprecisión y se corrigió al par, que es la decisión ya tomada; el arreglo de la pantalla es T18.

L45. T16, T17 y T18 en `52364e8` y `6e4f48a`. Suite web 4 723 tests, `typecheck` (app y arnés) en 0, y los ocho e2e en verde contra el bundle recién construido y servido (`index-B_ycf2r2.js`). Quedan anotados dos restos de la misma regla escrita dos veces, ninguno de los dos arreglado: `warehouseWarrantyModel.ts:207` decide la frase de custodia por el destino solo —es alcanzable en un caso `repaired`+`stock` que todavía no está resuelto, donde afirmaría que la fábrica no cubrió la unidad, que es falso—, y la nota del formulario de aviso promete una liberación que el aviso no habilita en un caso no cubierto. La fila de la bandeja sigue esperando la decisión entre publicar el acto de cierre o aceptar un `Cerrada` neutro.

L46. User: "perfecto hagamos eso", después de la respuesta que listó las dos puertas sin navegador encima. Se extiende S35 con (7) el hallazgo en góndola y (8) la entrega al cliente, y se abre T19 para recorrerlas.

L47. T19 en `9cfbe72`: once pruebas de navegador en verde y las dos puertas de la vertical recorridas. Queda anotado un defecto de copia chico que la corrida dejó a la vista: la confirmación del alta dice «1 unidad dadas de baja» para cantidad 1, por concordancia en `WarrantyCases.tsx`. No rompe nada y no está cubierto por ningún test.

L48. Encontrado al revisar la copia de T19: la confirmación del alta del hallazgo dice «1 unidad dadas de baja» para cantidad 1 en las dos pantallas, porque la frase concatena un helper `units()` —duplicado en `WarrantyCases.tsx:102` y `WarehouseWarrantyCases.tsx:67`— con un participio fijo. T20.

L49. User: "hagamos las 4 pa". Autorizado el cierre de la vertical: T21 (la fila de la bandeja publica el acto de cierre, con el campo aditivo que era la opción recomendada), T22 (la custodia del Almacén por el par), T23 (el acto de corrección de stock de la sucursal, S36) y T24 (la entrega: los cinco PRs encadenados).

L50. User: "A". Autorizado generalizar el documento del ajuste (S36.1), conectar la guarda de sucursal congelada que `035` omite a propósito (S36.2) y reescribir los tests que fijan la regla contraria (S36.3). Es la rebanada más grande de la vertical y la única que toca la integridad del cierre.

L51. Hallazgo de T23: las migraciones aplicadas son inmutables (checksum en `internal/db.readApplied`), así que S36.2 no se podía cumplir al pie de la letra — se corrige como S36.2.1. Un comentario equivocado en una migración vieja sólo se puede contradecir desde la nueva.
