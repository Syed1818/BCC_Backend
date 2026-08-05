require('dotenv').config(); // 🚨 MUST BE LINE 1: Loads the .env file into memory first!
const { Pool } = require('pg');

// Clean up DATABASE_URL to remove accidental quotes or trailing spaces
let connectionString = process.env.DATABASE_URL || '';
connectionString = connectionString.replace(/["']/g, '').trim();

if (!connectionString) {
  console.error('❌ CRITICAL: DATABASE_URL environment variable is missing!');
}

const isRDS = connectionString.includes('rds.amazonaws.com');

const pool = new Pool({
  connectionString: connectionString,
  // Automatically apply SSL only if it's an AWS RDS database
  ssl: isRDS ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL Database successfully!');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL Pool Error:', err.message);
});

module.exports = pool;
