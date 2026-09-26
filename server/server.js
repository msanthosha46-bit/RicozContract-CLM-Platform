const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const markOverdueItems = require('./utils/overdueUpdater');
const expireEligibleContracts = require('./utils/expiryUpdater');
const ContractDocument = require('./models/ContractDocument');
const {
  readDocumentVersionIndexReport,
  describeDocumentIndexReport
} = require('./utils/documentIndexes');

dotenv.config();

// Fail fast when required configuration is missing (never print secret values).
const missingEnv = ['MONGO_URI', 'JWT_SECRET'].filter((name) => !process.env[name]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}
if (!process.env.CLIENT_URL) {
  console.warn('CLIENT_URL is not set; CORS will allow requests from any origin.');
}

const app = express();

// Render sits behind a reverse proxy; trust the first hop so req.ip (used by
// rate limiting) reflects the client instead of the proxy address.
app.set('trust proxy', 1);

// Normalize origins (trailing slashes) so `https://example.com/` matches
// `https://example.com` — a common cause of CORS breaks in production.
const allowedOrigins = (process.env.CLIENT_URL || '')
	.split(',')
	.map((origin) => origin.trim().replace(/\/+$/, ''))
	.filter(Boolean);

app.use(cors({
	origin: allowedOrigins.length ? allowedOrigins : true
}));
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'ricoz-contract-server' }));

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/contracts', require('./routes/contractRoutes'));
app.use('/api/approvals', require('./routes/approvalRoutes'));
app.use('/api/obligations', require('./routes/obligationRoutes'));
app.use('/api/milestones', require('./routes/milestoneRoutes'));
app.use('/api/documents', require('./routes/documentRoutes'));
app.use('/api/renewals', require('./routes/renewalRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/activities', require('./routes/activityRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));

app.use((req, res) => {
	res.status(404).json({ message: 'API route not found' });
});

// Central error handler: map known errors to correct status codes and never
// expose raw internal error messages to clients.
app.use((error, req, res, next) => {
	if (error.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE') {
		return res.status(413).json({ message: 'File exceeds the 10 MiB upload limit.' });
	}
	if (error.name === 'MulterError' || (typeof error.message === 'string' && error.message.includes('Only PDF'))) {
		return res.status(400).json({ message: error.message });
	}
	if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
		return res.status(400).json({ message: 'Invalid JSON payload' });
	}
	if (error.status >= 400 && error.status < 500 && error.expose) {
		return res.status(error.status).json({ message: error.message });
	}
	if (error.name === 'ValidationError') {
		const details = Object.values(error.errors || {}).map((detail) => detail.message);
		return res.status(400).json({ message: 'Validation failed', details });
	}
	if (error.name === 'CastError') {
		return res.status(400).json({ message: `Invalid value for '${error.path}'` });
	}
	if (error.code === 11000) {
		return res.status(409).json({ message: 'A record with the same unique value already exists' });
	}
	console.error(error);
	return res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
const DB_RETRY_ATTEMPTS = 10;
const DB_RETRY_DELAY_MS = 3000;

let server;
let overdueTimer;
let expiryTimer;

const runOverdueUpdate = () => {
  markOverdueItems()
    .then((result) => {
      if (result && (result.obligations || result.milestones)) {
        console.log(`Overdue update: ${result.obligations} obligations, ${result.milestones} milestones marked Overdue`);
      }
    })
    .catch((error) => console.error('Overdue update failed:', error.message));
};

const runExpiryUpdate = () => {
  expireEligibleContracts()
    .then((result) => {
      if (result && result.expired > 0) {
        console.log(`Expiry update: ${result.expired} contract(s) marked Expired`);
      }
    })
    .catch((error) => console.error('Expiry update failed:', error.message));
};

const connectWithRetry = async () => {
  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await connectDB();
      return;
    } catch (error) {
      console.error(`MongoDB connection attempt ${attempt}/${DB_RETRY_ATTEMPTS} failed: ${error.message}`);
      if (attempt === DB_RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, DB_RETRY_DELAY_MS));
    }
  }
};

// Verify the document version index on boot. This is a read-only check so an
// implicit build can never fail silently; the index itself is created only by
// the explicit "npm run indexes:sync" procedure.
const reportDocumentVersionIndex = async () => {
  try {
    const report = await readDocumentVersionIndexReport(ContractDocument, { maxTimeMS: 5000 });
    if (report.ready) {
      console.log(`Document version index ${report.indexName} is present and unique.`);
      return;
    }
    console.warn('Document version index is not ready:');
    console.warn(describeDocumentIndexReport(report));
  } catch (error) {
    console.warn(`Document version index check could not complete: ${error.message}`);
    console.warn('Run "npm run indexes:check" manually. No data was changed.');
  }
};

// Start accepting requests only after the database connection is ready.
const startServer = async () => {
  try {
    await connectWithRetry();
  } catch (error) {
    console.error(`Unable to connect to MongoDB after ${DB_RETRY_ATTEMPTS} attempts: ${error.message}`);
    process.exit(1);
  }

  await reportDocumentVersionIndex();

  server = app.listen(PORT, () => {
    console.log(`🚀 RicozContract Server running on port ${PORT}`);
    runOverdueUpdate();
    overdueTimer = setInterval(runOverdueUpdate, 60 * 60 * 1000);
    runExpiryUpdate();
    expiryTimer = setInterval(runExpiryUpdate, 60 * 60 * 1000);
  });
};

// Graceful shutdown: stop the hourly job, drain connections, close MongoDB.
const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down gracefully...`);
  if (overdueTimer) clearInterval(overdueTimer);
  if (expiryTimer) clearInterval(expiryTimer);

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out after 10s; forcing exit.');
    process.exit(1);
  }, 10000);

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
    clearTimeout(forceExitTimer);
    console.log('Shutdown complete.');
    process.exit(0);
  } catch (error) {
    console.error('Shutdown error:', error.message);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

startServer();
