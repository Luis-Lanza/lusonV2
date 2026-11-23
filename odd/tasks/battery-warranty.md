# Garantías y reparaciones de baterías

Feature: `feat/battery-warranty` · Base: `8e3d39b` (master) · Risk: item 1 (migraciones nuevas y cambio en el sembrado de `closing_material_lines`) y item 3 (contrato del sembrado de usadas que ya consumen las rendiciones)

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

S16. El hallazgo en stock da de baja el stock. User, L2: "debe enviarse a almacen tambien". Un `stock_defect` descuenta la cantidad de `inventory_balances` de la sucursal al registrarse, con motivo propio que la rendición reconoce como legítimo. Check: la cantidad baja en la misma transacción del alta; el motivo queda en la evidencia; el cierre no imputa faltante a la sucursal por esa unidad.

S17. El pool de usadas alimenta la rendición. User, L6: "si tenemos el historial de compras de baterias usadas... por ahi no podrian ir los tiros?". El esperado de usadas de `closing_material_lines` pasa a ser compras de la ventana más devueltas de fábrica no cubiertas, menos préstamos otorgados, menos liquidaciones a chatarra. Check: un préstamo otorgado en la ventana reduce el esperado; una devuelta no cubierta lo aumenta; los cierres ya creados conservan su `expected_quantity` grabado.

S18. Sin inventario de usadas. User, L5: "no tenemos un inventario de baterias usadas, y no se hasta que punto es necesario" y L6: "no tenemos inventario como tal de baterias usadas". No se crea tabla de stock, ni saldo, ni conteo propio de usadas. Check: no existe ninguna tabla nueva de existencias de usadas y el pool se deriva por flujo.

S19. Dueño único del caso. User, L8: "la sucural le debe la respuesta al cliente y el almaen solo mueve la bateria". La sucursal es dueña del caso y de la relación con el cliente; el Almacén ejecuta hitos sobre el mismo caso sin poder cerrarlo ni cambiar su origen. Check: un actor del Almacén no puede registrar la entrega al cliente; un actor de la sucursal no puede autorizar la liberación a stock.

S20. Numeración por sucursal. El caso tiene un número propio por sucursal, independiente de la numeración de garantías. Check: dos sucursales no comparten numeración y el número aparece en el comprobante y en el historial.

S21. Sin regresiones. Ventas, precios, mínimos, comisiones, transferencias, ingresos al Almacén, compras, chatarra y administración siguen igual. Check: las suites existentes y el typecheck y build del frontend pasan; el sembrado de usadas se prueba contra PostgreSQL real.

S22. Verificación. Migraciones probadas contra PostgreSQL real, stores y HTTP con tests, frontend con tests de modelo y componentes, typecheck y build, PDF del comprobante validado estructuralmente, y verificación funcional del artboard elegido.

## Tasks

T1 [S1–S22] Documento y direcciones visuales, canvas abierto y artboard elegido — route inline (diseño); done: `design/battery-warranty/` con manifest y artboards.
T2 [S1,S2,S5,S6,S7,S9,S11,S14,S20] Migración: caso, eventos append-only, préstamos, numeración por sucursal y guardas — route delegated; pendiente.
T3 [S16,S17] Migración del sembrado de usadas en `closing_material_lines`, con cierres históricos intactos — route delegated; pendiente; riesgo item 1 y 3.
T4 [S1,S2,S11,S16] Paquete Go del caso: validación de serial y plazo, alta de las dos entradas, transiciones y matriz de resolución — route delegated; pendiente.
T5 [S3,S8,S14,S19,S20] Store y HTTP: rutas del caso, comprobante PDF y guardas de actor — route delegated; pendiente.
T6 [S4,S5,S6,S7] UI sucursal: registrar el canje, elegir el préstamo y emitir el comprobante — route delegated; pendiente.
T7 [S9,S10,S13,S14,S15] UI Almacén: mesa de casos, legajo, custodia y liberación — route delegated; pendiente.
T8 [S12,S15,S17,S18] Colas de trabajo y lectura del pool de usadas — route delegated; pendiente.
T9 [S21,S22] Verificación integral y cierre con evidencia — route inline; pendiente.

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
