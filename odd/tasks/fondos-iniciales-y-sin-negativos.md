# Fondos iniciales y cajas sin negativos

Alta de sucursal con dos montos obligatorios — fondo de compras y fondo de caja operativa — para que la
sucursal no nazca en cero, y la regla de que **ninguna de las dos cajas puede quedar en negativo**. Requiere
darle al fondo de compras un libro propio, como ya lo tiene el cajón.

## Specs

- **S1** El alta de sucursal exige dos montos: **fondo de compras** y **fondo de caja operativa**. Los dos son
  obligatorios. Texto del humano: «en alta de sucursal esos dos montos deben ser obligatorios».
- **S2** La sucursal nace con esa plata: el cajón arranca con su monto y el fondo de compras con el suyo. Texto
  del humano: «entonces la sucursal no nace en 0» y «asi la sucursal nace con dinero ahi».
- **S3** Declarar `0,00` es una respuesta válida y explícita: la sucursal nace sin plata para gastar y el alta
  lo advierte. Lo que no es válido es no declarar.
- **S4** El monto del cajón entra como un movimiento `aporte` del libro del cajón, firmado por el admin que crea
  la sucursal. No se inventa una columna: es un movimiento más, como cualquier otro.
- **S5** El fondo de compras tiene su propio libro de movimientos firmados: `aporte` (el alta o el Almacén lo
  carga), `compra` (una compra en efectivo lo consume), `reposicion` (el cierre declara lo que queda) y
  `correccion`. Su saldo es la suma firmada, y la vista `purchase_fund_ledger` es el único lugar donde se lee.
  *Decisión de arquitectura*: se descartó una columna de saldo por sucursal porque sin historia no hay
  auditoría de quién puso y quién sacó, y porque "nunca negativo" tiene que ser una regla del sistema y no un
  número que alguien puede dejar mal.
- **S6** **Ninguna caja admite saldo negativo.** Se rechaza cualquier movimiento que deje el cajón o el fondo por
  debajo de cero, y el rechazo nombra el saldo actual y el monto pedido. Texto del humano: «y no debe
  permitirse salgo negativo en caja! ni en fondo de compras!».
- **S7** Un fondo no declarado es **cero**, no desconocido: se elimina la excepción de `044` («an unstated
  envelope is not zero») que hoy deja pasar una compra sin fondo. Una compra que exceda el saldo se rechaza.
- **S8** El tope se evalúa bajo el lock por sucursal (`340251`, el mismo de la rendición), así dos compras
  simultáneas no pueden pasarse entre las dos.
- **S9** El cierre declara el fondo contado y el que queda; el que queda se escribe como `reposicion` del libro.
  El acta sigue publicando los dos números, ahora derivados del libro.
- **S10** Un gasto o una recaudación que deje el cajón por debajo de cero se rechaza con la misma forma que una
  compra sin fondo: saldo actual y monto pedido a la vista.
- **S11** El panel de administración pide los dos montos en el alta, y después muestra el saldo de las dos cajas
  por sucursal, con el libro de cada una a un clic.
- **S12** Las sucursales que ya existen arrancan con el fondo que declaró su último cierre y el cajón con lo que
  quedó; cero si nunca cerraron. El alta es una sola transacción: o nacen la sucursal y sus dos movimientos, o
  no nace nada.
- **S13** Dinero como texto decimal canónico, validado en el servidor, igual que el resto de la casa.

## Tasks

- **T1** Migración 048: tabla `branch_fund_movements`, sus tipos, guardas de forma y de inmutabilidad, la vista
  `purchase_fund_ledger`, `create_branch(name, opening_cash, purchase_fund)` con los dos montos y el backfill de
  las sucursales existentes desde su último cierre. Pruebas de esquema. — Spec: S1-S5, S7, S12.
- **T2** Store: saldo de las dos cajas desde sus libros, rechazo por negativo en gasto y recaudación, y el alta
  con los dos montos. Pruebas de store. — Spec: S4, S6, S10, S12.
- **T3** Compras: la compra escribe su `compra` en el libro del fondo y el tope pasa a ser el saldo; se retira la
  excepción del fondo no declarado. Pruebas. — Spec: S6-S8.
- **T4** Cierre: el «queda» del fondo escribe su `reposicion`; el acta sigue publicando los dos números, ahora
  derivados. Pruebas. — Spec: S9.
- **T5** HTTP y administración: alta con los dos montos obligatorios, lectura de los saldos y del libro del
  fondo. Contrato en `apps/api/docs`. — Spec: S1, S11, S13.
- **T6** Pantalla de administración: dos campos obligatorios en el alta con la advertencia del `0,00`, y los
  saldos de las dos cajas por sucursal. Pruebas. — Spec: S3, S11.
- **T7** Métricas y Compras leen el saldo del fondo desde el libro; una sola aritmética. — Spec: S5.
- **T8** Documentación, verificación independiente y revisión nativa por unidad de riesgo. — Spec: S6, S9.

## Log

- **L1** Pedido original, verbatim: «mira propongo lo siguiente! / al crear una sucursal por primera desde el
  panel de administrador debe poder asignarle un monto al fondo de compras, asi la sucursal nace con dinero
  ahi! ademas tambien de asignar un fondo a la caja operativa. / entonces la sucursal no nace en 0. / y no debe
  permitirse salgo negativo en caja! ni en fondo de compras!».
- **L2** Corrección del humano, verbatim: «en alta de sucursal esos dos montos deben ser obligatorios». Cambia
  «debe poder asignarle» por obligatorio, y deja `0,00` como respuesta explícita (S3).
- **L3** Hallazgo que ordena la vertical: el cajón ya tiene libro (por eso un aporte inicial no inventa nada),
  pero el fondo de compras no: su saldo sólo existe pegado a una rendición cerrada, y por eso un fondo nunca
  declarado no es cero sino desconocido. Eso es lo que deja pasar una compra sin plata y lo que produjo el
  fondo en rojo. De ahí S5 y S7.
- **L4** Hallazgo de la implementación, que cambió el diseño: el aporte fundacional del cajón **no podía
  firmarlo el Almacén**, porque la admisión de 046 exige que firme una cuenta de esa sucursal y la sucursal
  todavía no existe cuando se crea. Se resolvió con el mismo recurso que la casa usa para el cierre: un
  marcador de proveniencia que sólo `create_branch_funded` puede poner, atado además a que la fila de la
  sucursal se haya escrito en esa misma transacción (el `pg_trigger_depth` no servía: una inserción desde una
  función corre en profundidad 1, igual que una del cliente).
- **L5** Hallazgo de la implementación: `pg_trigger_depth()` no distingue una función del cliente, medido y
  descartado como gate. Queda anotado porque es una trampa que va a reaparecer.
- **L6** El alta sin fondos no se podía retirar sin actualizar 25 tests de otras verticales que llamaban a
  `create_branch(text)` o posteaban el cuerpo viejo de una sola clave. Autorizado como consecuencia directa
  del retiro del seam, no como scope nuevo. Se restauraron además dos propiedades que se habían debilitado
  en silencio (la asignación de sucursal y el agotamiento del rango de ids ahora se prueban sobre la función
  que sobrevive, con su SQLSTATE propio).
- **L7** La compra paga con el fondo y el cierre lo asienta: `050` escribe la `compra` (y su `correccion` en
  un contrarregistro) desde la base, y `051` escribe la `reposicion` del cierre con la proveniencia del acta.
  Un `reposicion` puede ser negativo cuando el Almacén deja menos de lo que el libro tenía: el saldo sigue
  siendo la suma y el acta lo publica desde el libro, no desde la columna. S6 gana siempre: el saldo nunca
  queda negativo.
