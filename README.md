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
