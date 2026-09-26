const mongoose = require('mongoose');

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not configured');
  }

  const conn = await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false
  });
  console.log(`MongoDB Connected: ${conn.connection.host}`);
  return conn;
};

module.exports = connectDB;
