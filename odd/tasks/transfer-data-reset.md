# Transfer data reset

## Authorized scope
- User explicitly confirms this is disposable local test data, not production or real customer data. Use one backup and bounded transactional checks, without a production restore laboratory.
- Human selection: `authorize_transfer_purge_4_received_13_tables_backup_keep_stock`.
- Application database: `luson_dev` in exact DB container `b2d5ff7f921e233883a30713d122f736f6e2781122c1a9a2a36a7c85a0242884`; existing volume/network remain unchanged.
- Only running retained APP `1d3426eab75459d021272407a3d139e8131fdef1223be773650e25636e166a3b` may be briefly paused/resumed. Candidate `6d4c8f7942520fb570dce41c157ca7a0b66117c4ea97f2576bde614c7cf44be6` stays stopped; no frontend rollout.
- Delete exactly four received transfer roots and their 37 associated records in thirteen transfer tables. Fresh locked checks must match; otherwise stop before deletion.
- Preserve ALL inventory rows, physical existing and reserved quantities, accounts, sessions, catalog, variants, locations, migration state and true sequence state. No inventory DML or identity restart.
- Temporarily except only thirteen named statement-level TRUNCATE history guards, restore their original enabled state before commit; keep FK, check, row-history and inventory guards enabled. No CASCADE or blanket bypass.
- Advance only the three transfer revision rows once with transactional notifications; inventory revision remains unchanged.
- Full private application-database backup and archive readability/decompression/hash verification before mutation. This is not a full restore rehearsal or host-loss backup.
- All old UI/runtime/failure/verification artifacts and unrelated dirty files are read-only. No credential/key contents in tool output, no new authentication/business requests, no source changes or Git delivery authorized.

## Tasks
- [x] D1: Independent63 static review PASS for exact7347-byte SQL SHA `147974336a099fd7c9b1dd74d647ec188f9a8b6345b945dc034d4699fb91c2f1`. Parent fresh bindings and paused-state read-only guards passed; OLDpaused once/DBUP/candidateOFF. Full private158302-byte custom backup SHA `025f5ba29f0ad25736e51268c21b1768a6a487c440f0bd5153a095e812e1af33`, mode0600/root0700,23public table-data TOC entries, full archive read/decompression exit0 and unchanged hash. This is not a restore rehearsal. No purge yet.
- [x] D2: Exact reviewed SQL executed once; psql exit0 and post-COMMIT marker confirmed zero roots/thirteen empty tables (four roots/37related removed). All9unrelated table count/full-row digests, true sequence state and complete public-trigger signature matched before/after; guards restored, constraints resolved, inventory revision unchanged, three transfer revisions +1. No inventory DML, identity restart or broader purge. Private preservation/transaction-success receipts retained.
- [x] D3: Retained APP resumed once, exit0. Independent64 PASS-RESET-VERIFIED/exit0: all13transfer tables empty; all9unrelated table counts/full-row digests unchanged (inventory570/accounts3/catalog95/variants190/locations3/sessions/migrations); existing+reserved unchanged, true sequence unchanged, all13guardsO/fulltrigger signature unchanged/constraints valid/source functions exact/three transfer revisions +1/inventory revision same. OLD APP+DB up, candidate created/off/neverstarted. Backup158302bytes/SHA unchanged/modes0700/0600. Three trusted HTTPS requests root/oldJS/oldCSS returned200/correctMIME/hash/CA-hostname-leaf pins. No mutations by verifier.

## Evidence and preflight
- Read-only source/live schema checks: twelve migration checksums match; no inbound FK from outside the thirteen tables; guards enabled O, internal triggers enabled, constraints validated.
- Four roots all received; active allocation ownership, residual reservations and in-transit quantities zero. No reservation release or physical-stock reversal is needed.
- Preserved dataset snapshot: accounts3, catalog95, variants190, locations3, inventory570. True sequence state includes last_value and is_called; identifiers will not be reused.
- Current stable Docker bindings pass. A prior raw full-State comparison was false and its historical cause cannot be reconstructed; later complete stable-field checks pass. Mount-array order is demonstrably volatile; complete records and ordered configuration values are preserved.
- Proposed private run root: `/home/luis/.local/share/luson/dev-a3732a63/transfer-data-reset-01/`, exclusively created owner0700, backup0600. Never overwrite or adopt an existing path.
- Applicable verification is real before/after database invariants, backup validation and transaction failure handling. No application behavior change or meaningful application-unit-test RED is claimed.

## Proposed transaction (review required before execution)
Execute only after a verified full backup and exclusive application pause. The complete preservation snapshot stays server-side; only checksums/counts may be recorded. This batch deliberately performs no inventory update. Any error aborts the transaction.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $maintenance$
DECLARE
  targets text[] := ARRAY['transfer_requests','transfer_request_items','transfer_request_allocations','transfer_receipt_lines','transfer_receipt_exceptions','transfer_count_operations','transfer_count_proposals','transfer_count_decisions','transfer_count_applications','transfer_restitution_operations','transfer_restitution_proposals','transfer_restitution_decisions','transfer_restitution_applications'];
  guards text[] := ARRAY['protect_transfer_requests_truncate','protect_transfer_request_items_truncate','protect_transfer_allocations_truncate','protect_transfer_receipt_lines_truncate','protect_transfer_receipt_exceptions_truncate','protect_count_operations_truncate','protect_count_proposals_truncate','protect_count_decisions_truncate','protect_count_applications_truncate','protect_restitution_operations_truncate','protect_restitution_proposals_truncate','protect_restitution_decisions_truncate','protect_restitution_applications_truncate'];
  expected bigint[] := ARRAY[4,7,7,7,2,4,3,1,1,2,1,1,1];
  rels oid[];
  t text; i integer; n bigint; h text; locks text;
  before_data jsonb := '{}'::jsonb; after_data jsonb := '{}'::jsonb;
  before_seq jsonb; after_seq jsonb; before_rev jsonb; after_rev jsonb;
  before_triggers text; after_triggers text;
BEGIN
  IF current_database() <> 'luson_dev' THEN RAISE EXCEPTION 'wrong database'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()) THEN RAISE EXCEPTION 'other database clients'; END IF;
  SELECT count(*), string_agg(format('public.%I', tablename), ', ' ORDER BY tablename) INTO n, locks FROM pg_tables WHERE schemaname='public';
  IF n<>23 THEN RAISE EXCEPTION 'unexpected public table set'; END IF;
  EXECUTE 'LOCK TABLE ' || locks || ' IN ACCESS EXCLUSIVE MODE';
  SELECT array_agg(to_regclass(format('public.%I', x))::oid ORDER BY ord) INTO rels FROM unnest(targets) WITH ORDINALITY AS q(x,ord);
  IF array_position(rels,NULL) IS NOT NULL THEN RAISE EXCEPTION 'missing target'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype='f' AND confrelid=ANY(rels) AND NOT(conrelid=ANY(rels))) THEN RAISE EXCEPTION 'external incoming foreign key'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace p ON p.oid=c.connamespace WHERE p.nspname='public' AND NOT c.convalidated) THEN RAISE EXCEPTION 'unvalidated constraint'; END IF;
  FOR i IN 1..array_length(targets,1) LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',targets[i]) INTO n;
    IF n<>expected[i] THEN RAISE EXCEPTION 'approved transfer counts changed'; END IF;
    SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid=rels[i] AND tgname=guards[i] AND NOT tgisinternal AND tgenabled='O' AND (tgtype::integer & 32)=32 AND (tgtype::integer & 1)=0 AND tgfoid='public.protect_pending_request()'::regprocedure;
    IF n<>1 THEN RAISE EXCEPTION 'history guard mismatch'; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.transfer_requests WHERE status<>'received') THEN RAISE EXCEPTION 'transfer lifecycle changed'; END IF;
  IF EXISTS (SELECT 1 FROM public.transfer_request_allocations WHERE consumed_at IS NULL AND released_at IS NULL) THEN RAISE EXCEPTION 'active transfer reservation'; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_balances WHERE reserved<>0) THEN RAISE EXCEPTION 'reserved inventory changed'; END IF;
  SELECT md5(coalesce(string_agg(to_jsonb(q)::text,E'\n' ORDER BY q.tgrelid,q.tgname),'')) INTO before_triggers FROM (SELECT t.* FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace p ON p.oid=c.relnamespace WHERE p.nspname='public') q;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT(tablename=ANY(targets)) AND tablename<>'realtime_revisions' ORDER BY tablename LOOP
    EXECUTE format('SELECT count(*),md5(coalesce(string_agg(to_jsonb(q)::text,E''\n'' ORDER BY to_jsonb(q)::text COLLATE "C"),'''')) FROM public.%I q',t) INTO n,h;
    before_data := jsonb_set(before_data,ARRAY[t],jsonb_build_object('count',n,'md5',h));
  END LOOP;
  SELECT jsonb_build_array(last_value::text,is_called) INTO before_seq FROM public.transfer_requests_id_seq;
  SELECT jsonb_object_agg(scope,revision) INTO before_rev FROM public.realtime_revisions;
  IF (SELECT count(*) FROM public.realtime_revisions)<>4 OR (SELECT count(*) FROM public.realtime_revisions WHERE scope IN ('transfers:1','transfers:2','transfers:3') AND revision<9223372036854775807)<>3 THEN RAISE EXCEPTION 'revision set or exhaustion'; END IF;
  FOR i IN 1..array_length(targets,1) LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',targets[i],guards[i]);
  END LOOP;
  SELECT string_agg(format('public.%I',x),', ' ORDER BY ord) INTO locks FROM unnest(targets) WITH ORDINALITY AS q(x,ord);
  EXECUTE 'TRUNCATE TABLE ' || locks || ' CONTINUE IDENTITY RESTRICT';
  FOR i IN 1..array_length(targets,1) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',targets[i],guards[i]);
    EXECUTE format('SELECT count(*) FROM public.%I',targets[i]) INTO n;
    IF n<>0 THEN RAISE EXCEPTION 'target not empty'; END IF;
  END LOOP;
  UPDATE public.realtime_revisions SET revision=revision+1 WHERE scope IN ('transfers:1','transfers:2','transfers:3');
  PERFORM pg_catalog.pg_notify('luson_realtime','transfers:1');
  PERFORM pg_catalog.pg_notify('luson_realtime','transfers:2');
  PERFORM pg_catalog.pg_notify('luson_realtime','transfers:3');
  SET CONSTRAINTS ALL IMMEDIATE;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT(tablename=ANY(targets)) AND tablename<>'realtime_revisions' ORDER BY tablename LOOP
    EXECUTE format('SELECT count(*),md5(coalesce(string_agg(to_jsonb(q)::text,E''\n'' ORDER BY to_jsonb(q)::text COLLATE "C"),'''')) FROM public.%I q',t) INTO n,h;
    after_data := jsonb_set(after_data,ARRAY[t],jsonb_build_object('count',n,'md5',h));
  END LOOP;
  SELECT jsonb_build_array(last_value::text,is_called) INTO after_seq FROM public.transfer_requests_id_seq;
  SELECT jsonb_object_agg(scope,revision) INTO after_rev FROM public.realtime_revisions;
  SELECT md5(coalesce(string_agg(to_jsonb(q)::text,E'\n' ORDER BY q.tgrelid,q.tgname),'')) INTO after_triggers FROM (SELECT t.* FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace p ON p.oid=c.relnamespace WHERE p.nspname='public') q;
  IF before_data IS DISTINCT FROM after_data OR before_seq IS DISTINCT FROM after_seq OR before_triggers IS DISTINCT FROM after_triggers THEN RAISE EXCEPTION 'preservation invariant failed'; END IF;
  IF after_rev->'inventory' IS DISTINCT FROM before_rev->'inventory' OR (after_rev->>'transfers:1')::bigint<>(before_rev->>'transfers:1')::bigint+1 OR (after_rev->>'transfers:2')::bigint<>(before_rev->>'transfers:2')::bigint+1 OR (after_rev->>'transfers:3')::bigint<>(before_rev->>'transfers:3')::bigint+1 THEN RAISE EXCEPTION 'revision invariant failed'; END IF;
  RAISE NOTICE 'maintenance-preserved=%',jsonb_build_object('tables',before_data,'sequence',before_seq,'revision_before',before_rev,'revision_after',after_rev,'triggers_md5',before_triggers);
END;
$maintenance$;
COMMIT;
SELECT json_build_object('status','committed','transfer_roots',(SELECT count(*) FROM public.transfer_requests));
```

## Next action
Completed and independently verified. User may reload the application and create new transfers; do not replay old saved operations. IDs continue rather than being reused. Preserve the private backup and all earlier evidence. No further purge, frontend rollout or automated business operations. Verification covers this database reset, not a full restore rehearsal, browser OS trust or comprehensive old F10 source-tree rehash.
