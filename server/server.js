const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');

dotenv.config();
connectDB();

const app = express();

const allowedOrigins = (process.env.CLIENT_URL || '')
	.split(',')
	.map((origin) => origin.trim())
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

app.use((req, res) => {
	res.status(404).json({ message: 'API route not found' });
});

app.use((error, req, res, next) => {
	if (error.name === 'MulterError' || error.message?.includes('Only PDF')) {
		return res.status(400).json({ message: error.message });
	}
	console.error(error);
	return res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 RicozContract Server running on port ${PORT}`));