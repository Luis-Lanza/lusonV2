-- preflight-warranty-open-claims.sql
--
-- One question, asked before migration 076 is applied and only of a database that
-- already holds warranty_cases (065 applied): does a serial carry more than one
-- open warranty claim?
--
-- Why it is asked first. 076 creates the unique partial index
-- warranty_cases_one_open_claim over the rows already stored, so a database with
-- two open claims of one serial refuses the migration -- and startup runs
-- bootstrap.Initialize -> db.Apply, so the server refuses to start until somebody
-- decides which of the two claims is real. That decision is a person's; this file
-- only reports the pairs that need it.
--
-- Read-only. No INSERT, no UPDATE, no DELETE, no temporary table, no function and
-- no DDL: one statement with two CTEs, so nothing this file does survives the
-- session and two consecutive runs print the same rows.
--
-- How it matches the index. The key is upper(btrim(serial_number)), the exact
-- expression 076 indexes, so ` abc/1 ` and `ABC/1` are one serial here too: that
-- is the pair that makes the index refuse the second row, so it must be the pair
-- reported here. The predicate is 076's own, `origin = 'warranty_claim'` and
-- `phase <> 'closed'`.
--
-- What it does not catch: a closed claim (out of the index by predicate), a claim
-- of another origin (stock_defect carries no serial at all, 065 forbids it), a
-- NULL serial (the index treats NULLs as distinct and 065 forbids it on a claim),
-- and any claim opened after this query runs. See scripts/README.md for what to do
-- with a serial that has two open claims.

WITH open_claims AS (
    -- The open claims 076 builds its index over, keyed exactly like the index.
    SELECT upper(btrim(w.serial_number)) AS normalized_serial,
           w.id                          AS case_id,
           w.case_number,
           w.phase,
           w.created_at,
           w.branch_location_id,
           w.sale_id,
           w.serial_number               AS serial_as_typed,
           w.declared_failure
    FROM warranty_cases w
    WHERE w.origin = 'warranty_claim'
      AND w.phase <> 'closed'
      AND w.serial_number IS NOT NULL
),
offending_serials AS (
    -- The keys the index would refuse: two or more open claims fold into one.
    SELECT o.normalized_serial
    FROM open_claims o
    GROUP BY o.normalized_serial
    HAVING count(*) > 1
)
SELECT o.normalized_serial,
       o.case_id,
       o.case_number,
       o.phase,
       o.created_at,
       o.branch_location_id,
       o.sale_id,
       o.serial_as_typed,
       o.declared_failure
FROM open_claims o
JOIN offending_serials s USING (normalized_serial)
UNION ALL
-- The single line a clean database prints: no offending serial, nothing to choose.
SELECT 'nothing to report: no serial has more than one open warranty claim',
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM offending_serials)
ORDER BY 1, 5, 2;
