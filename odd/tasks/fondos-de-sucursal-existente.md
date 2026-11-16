# Fondos de una sucursal existente

El alta ya exige los dos montos, pero una sucursal que **ya existe** (A y B) no tiene ninguna puerta para
recibirlos: el fondo de compras sólo se puede cargar abriendo una rendición —que congela la sucursal justo
cuando querés habilitarla— y la caja operativa sólo por un aporte que registra la propia sucursal. Esta
vertical agrega esa puerta, y muestra los dos saldos en el mismo panel.

## Specs

- **S1** Desde **Administración**, el Almacén puede cargar los dos fondos de una sucursal que ya existe:
  **fondo de caja operativa** y **fondo de compras**. Texto del humano: «bien!, pero ahora si tengo 2
  sucursales ya creadas como lo son la A y la B esto no se puede hacer no?».
- **S2** Los dos montos son **obligatorios** y cada uno puede ser `0,00`, que significa «no cargo nada por
  acá». Es el mismo contrato que el alta (S1 de `fondos-iniciales-y-sin-negativos.md`).
- **S3** La carga se escribe como **movimientos firmados**, no como columnas: un `aporte` en el libro del
  cajón y un `aporte` en el libro del fondo, con el Almacén como autor. Nada se edita.
- **S4** Sólo el **Almacén** carga fondos, y sólo en una sucursal **viva**. Una cuenta de sucursal no puede
  cargarse plata a sí misma ni a otra.
- **S5** Con una rendición viva (la sucursal congelada) la carga se **rechaza**: meter plata en el cajón que
  se está contando rompería el conteo. El rechazo dice por qué.
- **S6** La carga **no congela** la sucursal: después de cargar, la sucursal sigue operando.
- **S7** El panel muestra, por sucursal, los dos saldos: el del cajón y el del fondo de compras, **leídos de
  los libros** con la misma aritmética que el acta y la tarjeta de hoy. Un solo número por caja, nunca uno
  recalculado en la pantalla.
- **S8** El saldo del cajón es el esperado de la sucursal (`apertura + ventas en efectivo + efecto firmado
  del libro`), el mismo que ve la sucursal en Caja y que pide la rendición. Si la sucursal tiene una rendición
  viva, el panel lo dice en vez de mostrar un número que está por cambiar.
- **S9** Cargar `0,00` en las dos cajas no escribe ningún movimiento y no es un error.
- **S10** Todo queda con dinero canónico y validado en el servidor, como el resto de la casa.

## Tasks

- **T1** Migración 054: función `load_branch_funds(branch, opening_cash, purchase_fund, actor)` con su marca
  de proveniencia propia (no reutiliza la del alta), que escribe los dos `aporte` sólo cuando el monto es
  positivo, exige al Almacén como actor y sucursal viva, y respeta la congelación. Pruebas de esquema,
  incluida la falsificación del marcador. — Spec: S3-S6, S9.
- **T2** Store y HTTP: `POST /api/admin/branches/{id}/funds` con los dos montos obligatorios, y la lectura de
  los dos saldos por sucursal en la respuesta de administración. Contrato en `apps/api/docs`. — Spec: S1-S4,
  S7-S10.
- **T3** Pantalla de administración: en la tarjeta de cada sucursal, los dos saldos y el formulario de carga
  con los dos montos obligatorios y la advertencia del `0,00`. Pruebas. — Spec: S1, S2, S7, S9.
- **T4** Documentación y verificación: contrato, `README` si corresponde, y verificación independiente de una
  unidad de riesgo (dinero y permiso). — Spec: S4, S8.

## Log

- **L1** Pedido original, verbatim: «bien!, pero ahora si tengo 2 sucursales ya creadas como lo son la A y la
  B esto no se puede hacer no?».
- **L2** Hallazgo que ordena la vertical: la creación está resuelta y probada, pero no tiene puerta para una
  sucursal existente. Los dos caminos que hoy existen son malos por motivos distintos: abrir una rendición
  para cargar el fondo **congela** la sucursal, y la caja operativa sólo acepta un aporte que registra la
  propia sucursal (es decir: la sucursal se declara plata a sí misma).
