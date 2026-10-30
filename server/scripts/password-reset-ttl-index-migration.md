# Password reset queue TTL index migration plan

This is an operator controlled deployment procedure. The procedure's legacy
index removal is not run by the application or `indexes:report`. The
password-reset worker does call `PasswordResetEmailJob.createIndexes()` at
startup, which may create the new `completedAt` TTL index. Startup does not
verify or remove the old `createdAt` TTL index; its operator-controlled removal
remains a separate procedure. Do not run this procedure against production
until the target database and its index listing have been verified in the
approved change window.

## Expected indexes

The previous schema declared `{ createdAt: 1 }` with
`expireAfterSeconds: 86400` and no explicit name. MongoDB's generated name for
that key is `createdAt_1`. This old TTL definition would expire jobs 24 hours
after creation, including jobs still `pending` or `sending`.

The current schema declares `{ completedAt: 1 }` with
`expireAfterSeconds: 86400` and no explicit name. Its generated name is
`completedAt_1`. The TTL applies only where `completedAt` has a date value;
current open jobs have `completedAt: null`.

These names are derived from schema declarations and MongoDB's generated-name
rule, not verified production names. Before acting, use the target collection's
live `getIndexes()` output. Obtain the collection name from the running
application's `PasswordResetEmailJob.collection.collectionName` value or the
schema index report; do not assume a collection name or infer that an index with
a similar name has the expected key/options.

## Read-only preflight

The legacy TTL index remains active until explicitly removed and may delete
`pending` or `sending` jobs based on their `createdAt`, including while the new
index is being built. Protect open jobs before starting index work:

1. Stop queue producers so no new jobs can be enqueued.
2. Allow workers to drain all `pending` and `sending` jobs to terminal states,
   then stop all queue workers.
3. Keep queue producers and workers paused through index creation, verification,
   legacy-index removal, and post-migration verification.
4. On the explicitly selected target database, run this read-only check using
   the verified collection name:

   ```javascript
   db.getCollection("<verified PasswordResetEmailJob collection name>")
     .countDocuments({ status: { $in: ["pending", "sending"] } })
   ```

   Proceed only if the result is zero. If any open jobs remain, abort the
   migration. Do not proceed based on their age or whether they are younger than
   24 hours.

5. With queue writes still paused, run a read-only index listing:

   ```javascript
   db.getCollection("<verified PasswordResetEmailJob collection name>").getIndexes()
   ```

Record each candidate index's `name`, `key`, and `expireAfterSeconds`.

- Treat `createdAt_1` as the legacy index only if its key is exactly
  `{ createdAt: 1 }` and `expireAfterSeconds` is exactly `86400`.
- Treat `completedAt_1` as the new index only if its key is exactly
  `{ completedAt: 1 }` and `expireAfterSeconds` is exactly `86400`.
- If either name, key, or TTL option differs, stop and review the live
  definition. Do not remove an index by name alone.
- If the new index already exists with the expected definition, do not create
  another one. If it is absent, the operator may create it in the approved
  change window as shown below.

## Explicit migration sequence

1. Confirm the selected database and collection, and save the read-only
   preflight output for the change record.
2. If and only if the exact expected new index is absent, create it:

   ```javascript
   db.getCollection("<verified PasswordResetEmailJob collection name>")
     .createIndex({ completedAt: 1 }, { expireAfterSeconds: 86400 })
   ```

   The default index name should be `completedAt_1`. Verify the returned name
   and re-run `getIndexes()`. Do not continue unless the new index is present
   with the exact expected key and TTL option.
3. If and only if the exact expected old index is present, remove that exact
   index after step 2 has confirmed the new index:

   ```javascript
   db.getCollection("<verified PasswordResetEmailJob collection name>")
     .dropIndex("createdAt_1")
   ```

   If the live index has another name, stop and obtain review rather than
   substituting a guessed name. If the old index is absent, skip removal.
4. Re-run the read-only `getIndexes()` listing. Confirm that the exact
   `completedAt` TTL index remains with a 24-hour TTL and that the old
   `createdAt` TTL index is absent. Also run `npm run indexes:report` from the
   deployed application version as a schema consistency check. The report
   checks declared indexes; the `getIndexes()` listing is still required to
   confirm removal of this obsolete extra index. Resume queue producers and
   workers only after these post-migration checks succeed. If verification
   fails, keep queue writes paused and resolve the index state before resuming.

Index DDL does not synchronously delete documents as part of the create or drop
operation. However, creating a TTL index can make already-expired documents
eligible for asynchronous deletion by MongoDB's TTL monitor. That cleanup may
happen while the new `completedAt` index is being built or after it becomes
active. Before creating it, the operator must understand and explicitly approve
the expected retention cleanup of terminal jobs whose `completedAt` is older
than 24 hours. The zero-open-job preflight and paused queue writes protect
pending and sending jobs during the procedure. Manual queue cleanup also
restricts deletion to terminal statuses with an expired `completedAt`.

This plan must be executed only by an operator; this repository change does not
execute any of these database commands.
