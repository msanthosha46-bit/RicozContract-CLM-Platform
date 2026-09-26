# RicozContract

RicozContract is a contract lifecycle management application with a React client and an Express/MongoDB API.

## Requirements

- Node.js 18 or newer
- MongoDB running locally or a reachable MongoDB connection string

## Project structure

- `client/` React 18 single-page application
- `server/` Express API, JWT authentication, Mongoose models, and uploads

## Local setup

1. Install dependencies:

   ```powershell
   cd server
   npm install
   cd ..\client
   npm install
   ```

2. Configure the API:

   ```powershell
   cd ..\server
   Copy-Item .env.example .env
   ```

   Update `server/.env` for your MongoDB instance. At minimum, use a unique `JWT_SECRET` outside local demos.

3. Seed demo data (optional):

   ```powershell
   npm run seed
   ```

   Demo accounts use the password `password123`:

   - `admin@ricoz.com` (Admin)
   - `manager@ricoz.com` (Manager)
   - `employee@ricoz.com` (Employee)

4. Start the API in one terminal:

   ```powershell
   cd server
   npm start
   ```

5. Start the React client in a second terminal:

   ```powershell
   cd client
   npm start
   ```

Open `http://localhost:3000`. The API listens on `http://localhost:5000` by default.

## Client API configuration

The client uses `http://localhost:5000/api` by default. To point it at another API before building or starting the client, set:

```powershell
$env:REACT_APP_API_URL = 'https://api.example.com/api'
```

## Verification

Build the production client with:

```powershell
cd client
npm run build
```

Run the server model tests with:

```powershell
cd ..\server
npm test
```

Validate the server source syntax with:

```powershell
cd ..\server
node --check server.js
node --check utils/seedData.js
```

## Production notes

- Replace the demo `JWT_SECRET` and all demo passwords.
- Use a managed MongoDB deployment and restrict its network access.
- Configure a specific CORS origin instead of allowing every origin.
- Uploaded documents are served through the authenticated download endpoint rather than a public static path.
- Store uploaded documents outside the local filesystem or on durable private object storage for multi-instance deployments.
- Serve the client and API over HTTPS.

## Supabase Storage document storage

Document uploads are written to a **private** Supabase Storage bucket through the backend. Downloads remain authenticated API responses; the bucket is never made public, no signed URLs are handed to clients, and no storage paths or permanent document URLs are stored in MongoDB or returned by the API.

1. In the Supabase dashboard open **Storage** and create a bucket named `contract-documents`.
2. Set the bucket to **private**. Leave "Public bucket" and the public object URL off.
3. Copy the project URL from **Settings → API** (it looks like `https://<project-ref>.supabase.co`).
4. Create a secret key under **Settings → API Keys**. Use the **secret** key, never the publishable/anon key: the publishable key is public by design and cannot read a private bucket. The server refuses to start a storage operation with a publishable or `anon` key.
5. Copy the secret key once. Do not paste it into chat, source control, screenshots, or client-side environment variables.
6. Add the following environment variables to the Render API service and redeploy it when approved:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | The project URL, e.g. `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | The Supabase **secret** key (server-side only) |
| `SUPABASE_BUCKET_NAME` | The private bucket name, `contract-documents` |

The server derives the Storage REST endpoints from `SUPABASE_URL` and sends the secret key only on outbound requests to Supabase. It is never logged, never written to the database, and never included in an API response.

### How storage is wired

`server/services/storage/supabaseStorage.js` implements the storage adapter contract (`createObjectKey`, `upload`, `download`, `exists`, `delete`) against the Supabase Storage REST API, and `server/services/storage/index.js` selects the active adapter. Tests inject a mocked Supabase API at the `fetch` boundary, so no test ever touches a real bucket.

| Operation | Supabase endpoint |
| --- | --- |
| Upload | `POST /storage/v1/object/{bucket}/{key}` with `x-upsert: false` so an existing object is never overwritten |
| Download | `GET /storage/v1/object/{bucket}/{key}`, streamed straight through Express |
| Existence | `GET /storage/v1/object/info/{bucket}/{key}` |
| Delete | `DELETE /storage/v1/object/{bucket}` with the key as a prefix |

Object keys are generated as `documents/<year>/<month>/<uuid><ext>`, so a stored name never reveals the original filename. Each key is re-validated and encoded per path segment before use. The SHA-256 checksum is computed by the server and stored on the document row; Supabase's REST API accepts no custom object metadata, so MongoDB is the source of truth. If metadata persistence fails after an upload, the route deletes the uploaded object so no orphan is left behind.

### Legacy documents

Documents created before any object-storage integration have no `storageBackend` value and store a local `filePath` instead. They are treated as **read-only**: the server can still serve them from `server/uploads`, and it will never delete them. Their metadata rows and their place in the contract document list are unaffected by the move to Supabase.

Be aware of two limits:

- The local `uploads` directory is **not durable on Render**. Render's container filesystem is ephemeral and this project does not attach a persistent disk, so a legacy file is lost on the next deploy, restart or instance change. Docker Compose maps an `uploads_data` volume, but that only applies to local Compose.
- Because the stored `filePath` is an absolute path from the machine that created the document, a path recorded under a different deployment root is treated as outside the upload directory and is refused.

When a legacy binary can no longer be served, the download returns a `404` or `403` with a message telling the user to upload a new version. The document row itself is **not** removed, and no data is deleted: re-uploading is the only remedy, because the original bytes no longer exist anywhere the application can reach.

### Documents from the retired R2 backend

`storageBackend` may still read `r2` on historical rows so they remain schema-valid, but the R2 adapter has been removed. A request for such a document is refused with a `403` that tells the user to upload a new version; the metadata row and its position in the document list are untouched. No object is read, written or deleted during this check.

### Document version index

Documents are versioned per contract, and the `contractdocuments` collection needs a unique index on `(contract, version)` so that concurrent uploads cannot create two documents with the same version.

The server does **not** create this index implicitly. `autoIndex` is disabled in `server/config/db.js` so an index build can never fail quietly at boot. Instead the index is managed explicitly:

```bash
cd server
npm run indexes:check   # read-only: reports duplicates and index state, changes nothing
npm run indexes:sync    # creates the unique index, but only if the pre-checks pass
```

`indexes:check` runs a read-only duplicate scan and prints one of three states: `ready`, `SAFE TO CREATE`, or `ACTION REQUIRED`. `indexes:sync` refuses to build the index while any blocker is present and never adds, edits or deletes a document, and never drops an index.

The server also runs the read-only check on startup and logs the result, so a missing index is always visible in the logs.

To inspect the data by hand in `mongosh`, the read-only queries used by the check are:

```js
db.contractdocuments.aggregate([
  { $group: { _id: { contract: "$contract", version: "$version" }, count: { $sum: 1 }, ids: { $push: "$_id" } } },
  { $match: { count: { $gt: 1 }, "_id.version": { $ne: null } } },
  { $sort: { count: -1 } }
])

db.contractdocuments.aggregate([
  { $match: { $or: [{ version: { $exists: false } }, { version: null }] } },
  { $group: { _id: "$contract", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
])

db.contractdocuments.getIndexes()
```

Both aggregations must return nothing before `indexes:sync` will build the index. MongoDB cannot create a unique index while duplicate values exist. Resolving duplicates means changing production records, so it needs a separately approved data plan; do not delete or renumber documents as part of deployment.

## Deployment

Build the client with `npm run build` and serve the generated `client/build` directory from a static host. Deploy the `server` directory as a Node.js service with `npm start` and configure `MONGO_URI`, `JWT_SECRET`, `CLIENT_URL`, and `PORT` in the host environment.

The API health check is available at `/api/health` and returns `{ "status": "ok" }` when the process is running.

### Docker Compose

Docker Compose can run MongoDB, the API, and the production client together:

```powershell
$env:JWT_SECRET = 'replace-with-a-long-random-secret'
docker compose up --build -d
```

Open `http://localhost:3000`. Stop the stack with `docker compose down`; named volumes preserve MongoDB data and uploaded documents.
