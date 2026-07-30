const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) console.error('❌ Database connection error:', err.stack);
    else console.log('✅ Successfully connected to the PostgreSQL database.');
});

module.exports = pool;
