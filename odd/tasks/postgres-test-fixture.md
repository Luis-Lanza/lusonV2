# PostgreSQL test fixture

Build the audited ephemeral PostgreSQL fixture that `internal/testpg` already demands, so
`go test ./...` stops failing closed on every database-backed suite in this environment.
Test infrastructure only: no product code, no schema, no migration.

## Specs

S1. Un comando deja el entorno listo para que `go test ./...` corra de verdad: una base
    PostgreSQL efímera y auditada, descrita por un manifiesto, exportada como
    `LUSON_TEST_PG_MANIFEST`. Sin ese manifiesto la admisión sigue fallando cerrado: no se
    relaja `internal/testpg`.

S2. El fixture cumple el contrato que `internal/testpg` ya valida, sin cambiarlo: esquema y
    estado del manifiesto, `run_id`, el juego exacto de etiquetas, el DSN en el directorio
    privado con `0600` y uid 1000, la base y el rol admin, la red interna sin puertos
    publicados y el bind de `pgdata` con dueño 999 y `rw`/`rprivate`. Las variables `PG*`
    quedan sin definir.

S3. Es efímero y se limpia solo: al terminar borra su contenedor, su red y su manifiesto, y
    no deja volúmenes ni procesos. Un fallo en el medio no puede dejar un fixture vivo.

S4. No toca la base de desarrollo (`luson-dev-db`) ni sus datos, ni el volumen de ninguna
    otra base: son recursos distintos con nombres distintos.

S5. El costo de correrlo es acotado: levantar, correr los tests y bajar, sin pasos manuales
    intermedios y sin requerir `sudo`.

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1-S3 | worker `gentle-ai-worker` | pending |
| T2 | S1-S2 | worker `gentle-ai-worker` | pending |
| T3 | S4-S5 | pending | pending |

T3 queda pendiente de una decisión del usuario: si el mismo fixture se cablea en el CI de
GitHub o queda solo para local. No se implementa hasta que la respuesta exista.

## Log

L1 (usuario, verbatim): "entonces como hacemos?" y después "pushhea entonces opa", eligiendo
la opción "Pushear el fix revisado y arrancar el fixture".

L2 (contexto, verificado): `internal/testpg` falla cerrado por diseño (`t.Fatal("test
PostgreSQL admission rejected")`, nunca `t.Skip`) y exige un manifiesto cuya forma ya describe
(`schema:"luson.test-pg/v1"`, `status:"active"`, `scope:"transfer-requests/R01"`, `run_id`,
etiquetas fijas de harness, `dsn_file` bajo `~/.local/share/luson-transfer-tests-<run_id>/`,
`expected_uid:1000`, `expected_mode:"0600"`, `admin_database:"luson_test"`,
`admin_role:"luson_test"`, red interna sin puertos publicados, bind de `pgdata` con uid 999 y
`rw`/`rprivate`, y todas las `PG*` sin definir). El paquete no levanta docker: la vida del
fixture es de quien lo construye.

L3 (motivo): los dos defectos de la vertical de catálogo que solo encontró el review nativo
—una función reemplazada que perdió una inserción de realtime y un check desalineado con su
fan-out— los habría cazado un test PostgreSQL en segundos. Mientras el fixture no exista, la
red de seguridad de las migraciones depende del review y de la lectura humana.
