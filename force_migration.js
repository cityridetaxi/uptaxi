const mysql = require('mysql2/promise');
require('dotenv').config();

async function forceMigration() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'railway'
    });

    console.log('Attempting to add journey_otp column...');
    try {
        await db.query('ALTER TABLE bookings ADD COLUMN journey_otp VARCHAR(10) AFTER distance');
        console.log('✅ journey_otp added successfully.');
    } catch (e) {
        console.error('❌ Failed to add journey_otp:', e.message);
    }

    await db.end();
}

forceMigration().catch(console.error);
