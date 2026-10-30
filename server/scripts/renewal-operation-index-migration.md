# Renewal operation indexes

The contract, renewal, and activity schemas declare partial unique indexes for
operation IDs. The server connects with `autoIndex: false`; adding these
declarations does not create the indexes. Build them through an explicit,
operator-controlled deployment operation. After connecting to MongoDB, the
application performs a read-only check of these three exact index definitions.
Renewal writes and Admin recovery remain disabled with HTTP 503 until all three
definitions match. Renewal GET endpoints and unrelated application features
remain available. A missing, mismatched, or unreadable index check never creates
or repairs an index. This readiness check runs at startup; this document's
preflight and explicit index-build steps remain operator-controlled and are not
run by the application.

## Preflight

First inspect the live index lists for the `contracts`, `renewals`, and
`activitylogs` collections. The schema-declared operation index names are
`operationMarker.operationId_1` on contracts and `operationId_1` on each of the
other collections. Confirm no same-name index exists with a different key,
uniqueness, or partial filter. Do not drop or replace an index as part of this
procedure without a separately reviewed plan.

Read-only duplicate checks must return no groups:

```javascript
db.renewals.aggregate([
  { $match: { operationId: { $type: 'string' } } },
  { $group: { _id: '$operationId', count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])

db.activitylogs.aggregate([
  { $match: { operationId: { $type: 'string' } } },
  { $group: { _id: '$operationId', count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])

db.contracts.aggregate([
  { $match: { 'operationMarker.operationId': { $type: 'string' } } },
  { $group: { _id: '$operationMarker.operationId', count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])
```

If any check returns a group, stop and resolve it through a reviewed data
reconciliation. Do not delete history or activity records to make the index
build succeed. Existing renewal/activity rows without `operationId`, and
contracts without a marker operation ID, are outside their respective partial
indexes and remain unchanged.

## Explicit index creation

After the preflight is reviewed and approved, create each index in its own
collection with the exact key, options, and name below:

```javascript
db.renewals.createIndex(
  { operationId: 1 },
  {
    unique: true,
    partialFilterExpression: { operationId: { $type: 'string' } },
    name: 'operationId_1'
  }
)

db.activitylogs.createIndex(
  { operationId: 1 },
  {
    unique: true,
    partialFilterExpression: { operationId: { $type: 'string' } },
    name: 'operationId_1'
  }
)

db.contracts.createIndex(
  { 'operationMarker.operationId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'operationMarker.operationId': { $type: 'string' } },
    name: 'operationMarker.operationId_1'
  }
)
```

Do not use `syncIndexes()` or drop indexes as a shortcut. If an index with the
declared name already exists, compare its full definition and stop on any
mismatch rather than replacing it automatically.

## Verification

Read `listIndexes()` for all three collections after creation. For each
operation index, verify all four properties exactly:

- name and key for contracts: `operationMarker.operationId_1`,
  `{ 'operationMarker.operationId': 1 }`
- name and key for renewals and activitylogs: `operationId_1`, `{ operationId: 1 }`
- `unique: true`
- partial filter on contracts: `{ 'operationMarker.operationId': { $type: 'string' } }`
- partial filter on renewals and activitylogs: `{ operationId: { $type: 'string' } }`

Also rerun all three duplicate checks and confirm that ordinary renewal-history rows
without an operation ID are still present. Do not enable the idempotent renewal
write path until all three index definitions have been verified. On every
application startup, the server verifies these definitions after connecting and
before it begins listening. If any check fails or cannot complete, it logs the
affected index (or verification error), keeps the service available, and returns
HTTP 503 for `POST /renew/:contractId` and `POST /recover/:contractId`. The
`/expiring`, `/renewable`, and `/history` GET endpoints remain available. No
recovery runs automatically at startup. Pending operations are completed by
same-key retry or an explicit Admin-only recovery request scoped to the contract;
if an operation ID is supplied, it must match the current marker. A later process
restart repeats verification; index repair remains an operator-controlled step.
