const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// --- MULTER STORAGE CONFIGURATION ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/drivers');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- RATE LIMITING (DDoS & Thread Attack Protection) ---
// Global rule for general traffic (prevents basic floods)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 3000, // Increased for polling
    message: { error: 'Security Limit: Too many requests from this IP.' },
    standardHeaders: true, 
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 2500, // Explicitly set to 2500 for high-frequency polling
    message: { error: 'API Rate limit exceeded. Please lower your request frequency.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(globalLimiter); // Apply to all
app.use('/api/', apiLimiter); // Extra layer for backend routes

// Clean Navigation Routes
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver.html')));
app.get('/vendor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/driver-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver-login.html')));
app.get('/driver-register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver-register.html')));
app.get('/vendor-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor-login.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// --- DRIVER ONBOARDING OTP STORAGE ---
const registrationOtps = new Map(); // email -> otp

// Global DB
let db;

// --- BREVO HTTP API ENGINE ---
// This engine uses standard Port 443 (HTTP), bypassing all cloud port blocks
async function sendBrevoMail(recipient, subject, htmlContent, attachments = []) {
    if (!process.env.BREVO_API_KEY) {
        console.error('❌ BREVO FAILURE: API Key missing in environment.');
        return;
    }

    try {
        const payload = {
            sender: { 
                name: process.env.BREVO_SENDER_NAME || 'CityRide', 
                email: process.env.BREVO_SENDER_EMAIL || 'sureshit2005@gmail.com' 
            },
            to: [{ email: recipient }],
            subject: subject,
            htmlContent: htmlContent
        };

        if (attachments && attachments.length > 0) {
            payload.attachment = attachments;
        }

        const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
            headers: {
                'api-key': process.env.BREVO_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        console.log(`✅ [BREVO] Mail successfully dispatched to: ${recipient}. Message ID: ${response.data.messageId || 'N/A'}`);
        return response.data;
    } catch (err) {
        const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        console.error(`❌ [BREVO] API Error to ${recipient}:`, errMsg);
        throw new Error(errMsg);
    }
}

async function initDB() {
    console.log('Connecting to MySQL at:', process.env.DB_HOST);
    
    const dbConfig = {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'railway',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        charset: 'UTF8MB4_UNICODE_CI'
    };

    try {
        // 1. Ensure Database Exists (Railway often pre-creates it, but this is safe)
        const tempConn = await mysql.createConnection({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password
        });
        
        await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await tempConn.end();
        console.log(`Database "${dbConfig.database}" ensured.`);

        // 2. Initialize Shared Pool
        db = mysql.createPool(dbConfig);
        console.log('Database Pool initialized.');

        // 3. Create Tables
        // Passengers
        await db.query(`
            CREATE TABLE IF NOT EXISTS passengers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100),
                password VARCHAR(255),
                phone VARCHAR(20) UNIQUE,
                otp_verified TINYINT DEFAULT 0,
                banned_until TIMESTAMP NULL,
                is_blocked TINYINT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migration: Ensure is_blocked exists
        try {
            await db.query('ALTER TABLE passengers ADD COLUMN is_blocked TINYINT DEFAULT 0');
        } catch (e) { /* existing */ }

        // Drivers
        await db.query(`
            CREATE TABLE IF NOT EXISTS drivers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100) UNIQUE,
                password VARCHAR(255),
                phone VARCHAR(20),
                car_model VARCHAR(50),
                car_number VARCHAR(20),
                vehicle_type VARCHAR(50) DEFAULT 'sedan',
                wallet_balance DECIMAL(10,2) DEFAULT 0,
                is_blocked TINYINT DEFAULT 0,
                approval_status VARCHAR(20) DEFAULT 'approved',
                
                -- Driver Documents (Stored upon approval)
                dl_front VARCHAR(255),
                dl_back VARCHAR(255),
                pvc VARCHAR(255),
                aadhar_front VARCHAR(255),
                aadhar_back VARCHAR(255),
                rc_book VARCHAR(255),
                insurance VARCHAR(255),
                pollution VARCHAR(255),
                permit VARCHAR(255),

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migration: Ensure columns exist
        try { await db.query('ALTER TABLE drivers ADD COLUMN is_blocked TINYINT DEFAULT 0'); } catch (e) {}
        try { await db.query('ALTER TABLE drivers ADD COLUMN approval_status VARCHAR(20) DEFAULT "approved"'); } catch (e) {}
        try { await db.query('ALTER TABLE drivers ADD UNIQUE (phone)'); } catch (e) {}
        try { await db.query('ALTER TABLE driver_applications ADD UNIQUE (phone)'); } catch (e) {}
        
        // Add Document Columns to Drivers if missing
        const docCols = ['dl_front', 'dl_back', 'pvc', 'aadhar_front', 'aadhar_back', 'rc_book', 'insurance', 'pollution', 'permit'];
        for (const col of docCols) {
            try { await db.query(`ALTER TABLE drivers ADD COLUMN ${col} VARCHAR(255)`); } catch (e) {}
        }

        // Driver Applications (New Registrations)
        await db.query(`
            CREATE TABLE IF NOT EXISTS driver_applications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100) UNIQUE,
                password VARCHAR(255),
                phone VARCHAR(20),
                car_model VARCHAR(50),
                car_number VARCHAR(20),
                vehicle_type VARCHAR(50) DEFAULT 'sedan',
                
                -- Driver Documents
                dl_front VARCHAR(255),
                dl_back VARCHAR(255),
                pvc VARCHAR(255),
                aadhar_front VARCHAR(255),
                aadhar_back VARCHAR(255),
                
                -- Vehicle Documents
                rc_book VARCHAR(255),
                insurance VARCHAR(255),
                pollution VARCHAR(255),
                permit VARCHAR(255),
                
                status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
                admin_note TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Admins
        await db.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100) UNIQUE,
                password VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Vendors (Partners/Dealers)
        await db.query(`
            CREATE TABLE IF NOT EXISTS vendors (
                id INT AUTO_INCREMENT PRIMARY KEY,
                vendor_id VARCHAR(50) UNIQUE,
                name VARCHAR(100),
                business_name VARCHAR(100),
                email VARCHAR(100) UNIQUE,
                password VARCHAR(255),
                phone VARCHAR(20),
                is_blocked TINYINT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Bookings
        await db.query(`
            CREATE TABLE IF NOT EXISTS bookings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                pickup_loc TEXT,
                pickup_coords VARCHAR(100),
                drop_loc TEXT,
                drop_coords VARCHAR(100),
                pickup_date DATE,
                pickup_time TIME,
                passengers INT,
                vehicle_type VARCHAR(50),
                trip_type VARCHAR(50),
                fare VARCHAR(20),
                status VARCHAR(20) DEFAULT 'pending',
                driver_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migration: Ensure coords exist
        try { await db.query('ALTER TABLE bookings ADD COLUMN pickup_coords VARCHAR(100) AFTER pickup_loc'); } catch(e){}
        try { await db.query('ALTER TABLE bookings ADD COLUMN drop_coords VARCHAR(100) AFTER drop_loc'); } catch(e){}

        // Migration: Ensure trip_type exists
        try {
            await db.query('ALTER TABLE bookings ADD COLUMN trip_type VARCHAR(50) AFTER vehicle_type');
        } catch (e) { /* already exists */ }

        // Migration: Ensure cancel_reason exists
        try {
            await db.query('ALTER TABLE bookings ADD COLUMN cancel_reason TEXT AFTER status');
        } catch (e) { /* already exists */ }

        // Migration: Ensure distance exists
        try { await db.query('ALTER TABLE bookings ADD COLUMN distance VARCHAR(50)'); } catch(e){}
        
        // Migration: Ensure journey_otp exists
        try { await db.query('ALTER TABLE bookings ADD COLUMN journey_otp VARCHAR(10)'); } catch(e){}

        // Migration: Odometer and Timer for Rental
        try { await db.query('ALTER TABLE bookings ADD COLUMN start_odometer INT NULL'); } catch(e){}
        try { await db.query('ALTER TABLE bookings ADD COLUMN end_odometer INT NULL'); } catch(e){}
        try { await db.query('ALTER TABLE bookings ADD COLUMN journey_start_time DATETIME NULL'); } catch(e){}
        try { await db.query('ALTER TABLE bookings ADD COLUMN journey_end_time DATETIME NULL'); } catch(e){}
        try { await db.query('ALTER TABLE bookings ADD COLUMN rental_package VARCHAR(50) NULL'); } catch(e){}
        // Ensure status column can handle 'finished'
        try { await db.query("ALTER TABLE bookings MODIFY COLUMN status ENUM('pending', 'assigned', 'ongoing', 'finished', 'completed', 'cancelled', 'cancel_requested') DEFAULT 'pending'"); } catch(e){}

        // Migration: Vendor Support
        try { await db.query('ALTER TABLE bookings ADD COLUMN vendor_id INT NULL'); } catch(e){}
        try { await db.query('ALTER TABLE bookings ADD COLUMN vendor_markup DECIMAL(10,2) DEFAULT 0'); } catch(e){}

        // Recovery: Generate OTPs for legacy rides that don't have one
        try {
            const [missing] = await db.query('SELECT id FROM bookings WHERE journey_otp IS NULL OR journey_otp = ""');
            for (const ride of missing) {
                const newOtp = Math.floor(1000 + Math.random() * 9000).toString();
                await db.query('UPDATE bookings SET journey_otp = ? WHERE id = ?', [newOtp, ride.id]);
                console.log(`[RECOVERY] Generated legacy OTP [${newOtp}] for Ride #B${ride.id}`);
            }
        } catch (e) { console.error('Recovery script failed:', e.message); }

        // Abort Rejections Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS abort_rejections (
                id INT AUTO_INCREMENT PRIMARY KEY,
                booking_id INT,
                driver_id INT,
                original_reason TEXT,
                admin_note TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // OTPs Table (For Email Verification)
        await db.query(`
            CREATE TABLE IF NOT EXISTS otps (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100),
                otp VARCHAR(10),
                expires_at TIMESTAMP
            )
        `);

        // Tariffs
        await db.query(`
            CREATE TABLE IF NOT EXISTS tariffs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                vehicle_type VARCHAR(50),
                category VARCHAR(50),
                config JSON,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        // Insert default tariffs if empty
        try {
            const [tariffRows] = await db.query('SELECT COUNT(*) as cnt FROM tariffs');
            if (tariffRows[0].cnt === 0) {
                const defaultTariffs = [
                    {
                        vehicle_type: 'bike',
                        category: 'local',
                        config: JSON.stringify({ base: 0, perKm: 10, minKm: 5 })
                    },
                    {
                        vehicle_type: 'bike',
                        category: 'oneway',
                        config: JSON.stringify({ base: 0, perKm: 10, minKm: 5, convenience: 0 })
                    },
                    {
                        vehicle_type: 'sedan',
                        category: 'local',
                        config: JSON.stringify({ base: 200, perKm: 25, minKm: 0 })
                    },
                    {
                        vehicle_type: 'sedan',
                        category: 'oneway',
                        config: JSON.stringify({ base: 0, perKm: 13, minKm: 130 })
                    },
                    {
                        vehicle_type: 'sedan',
                        category: 'round',
                        config: JSON.stringify({ base: 0, perKm: 12, minKmPerDay: 250 })
                    },
                    {
                        vehicle_type: 'sedan',
                        category: 'rental',
                        config: JSON.stringify({ 
                            '2-20': { base: 600, extraKm: 18, extraHour: 150 }, 
                            '4-40': { base: 1100, extraKm: 18, extraHour: 150 }, 
                            '8-80': { base: 2100, extraKm: 16, extraHour: 120 }, 
                            '12-120': { base: 2800, extraKm: 15, extraHour: 120 } 
                        })
                    },
                    {
                        vehicle_type: 'suv',
                        category: 'local',
                        config: JSON.stringify({ base: 300, perKm: 35, minKm: 0 })
                    },
                    {
                        vehicle_type: 'suv',
                        category: 'oneway',
                        config: JSON.stringify({ base: 0, perKm: 19, minKm: 130 })
                    },
                    {
                        vehicle_type: 'suv',
                        category: 'round',
                        config: JSON.stringify({ base: 0, perKm: 18, minKmPerDay: 250 })
                    },
                    {
                        vehicle_type: 'suv',
                        category: 'rental',
                        config: JSON.stringify({ 
                            '2-20': { base: 900, extraKm: 25, extraHour: 250 }, 
                            '4-40': { base: 1600, extraKm: 25, extraHour: 250 }, 
                            '8-80': { base: 3100, extraKm: 22, extraHour: 200 }, 
                            '12-120': { base: 4200, extraKm: 20, extraHour: 200 } 
                        })
                    }
                ];

                for (const t of defaultTariffs) {
                    await db.query('INSERT INTO tariffs (vehicle_type, category, config) VALUES (?, ?, ?)', [t.vehicle_type, t.category, t.config]);
                }
                console.log('Default tariffs initialized.');
            }
        } catch (e) {
            console.error('Tariff initialization failed:', e.message);
        }

        console.log('MySQL schema and default admin ensured.');
    } catch (err) {
        console.error('Database Initialization Failed:', err.message);
        throw err;
    }
}

// Maintenance: Clean up old OTPs every hour
cron.schedule('0 * * * *', async () => {
    if (db) {
        await db.query('DELETE FROM otps WHERE expires_at < NOW()');
        console.log('--- OTP CLEANUP COMPLETED ---');
    }
});

async function startServer() {
    try {
        await initDB();
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('CRITICAL ERROR during startup:', err);
        process.exit(1);
    }
}

// --- AUTOMATED DAILY REPORTING ENGINE (RESEND) ---
async function sendDailyReport() {
    console.log('--- GENERATING ADVANCED PERFORMANCE BACKUP ---');
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        // 1. Gather Rich Data
        const [bookings] = await db.query(`
            SELECT b.*, 
                   u.name as customer_name, u.phone as customer_phone, u.email as customer_email,
                   d.name as driver_name, d.phone as driver_phone, d.car_model, d.car_number
            FROM bookings b 
            LEFT JOIN passengers u ON b.user_id = u.id 
            LEFT JOIN drivers d ON b.driver_id = d.id 
            WHERE b.created_at >= ?
        `, [todayStart]);

        let dailyRevenue = 0;
        bookings.forEach(b => {
             if (b.status === 'completed') {
                 dailyRevenue += parseFloat(b.fare.replace(/[^0-9.]/g, '')) || 0;
             }
        });

        // 2. Generate CSV In-Memory
        console.log('📊 Compiling Extended CSV Dataset...');
        const csvRows = ['ID,Status,Fare,Type,Customer,Cust_Phone,Cust_Email,Pickup,Drop,Car_Type,Driver,Driver_Phone,Car_Model,Plate'];
        bookings.forEach(b => {
            csvRows.push(`${b.id},${b.status},"${b.fare}","${b.trip_type || 'oneway'}","${b.customer_name || 'Walk-in'}","${b.customer_phone || ''}","${b.customer_email || ''}","${b.pickup_loc}","${b.drop_loc}","${b.vehicle_type}","${b.driver_name || 'Unassigned'}","${b.driver_phone || ''}","${b.car_model || ''}","${b.car_number || ''}"`);
        });
        const csvContent = Buffer.from(csvRows.join('\n')).toString('base64');

        // 3. Generate PDF In-Memory
        console.log('📄 Crafting Professional PDF Visualization...');
        const pdfPromise = new Promise((resolve) => {
            const doc = new PDFDocument({ margin: 30, size: 'A4' });
            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));

            // --- HEADER SECTION ---
            doc.rect(0, 0, 600, 100).fill('#1a1a1a');
            
            // Add Logo Image
            try {
                const logoPath = path.join(__dirname, 'public', 'logo.png');
                doc.image(logoPath, 40, 30, { width: 40 });
                doc.fillColor('#ff5252').fontSize(24).text('CITYRIDE', 90, 35, { characterSpacing: 2 });
            } catch (err) {
                doc.fillColor('#ff5252').fontSize(28).text('CITYRIDE', 40, 35, { characterSpacing: 2 });
            }

            doc.fillColor('#ffffff').fontSize(10).text('LOGISTICS INTELLIGENCE UNIT', 40, 75);
            doc.text(`REPORT ID: ${new Date().getTime()}`, 400, 45, { align: 'right' });
            doc.text(`AUDIT DATE: ${new Date().toDateString()}`, 400, 60, { align: 'right' });

            // --- METRICS CARDS ---
            doc.fillColor('#000000');
            const drawCard = (x, y, label, value, color) => {
                doc.rect(x, y, 160, 70).fill('#f8f8f8');
                doc.rect(x, y, 5, 70).fill(color);
                doc.fillColor('#888888').fontSize(8).text(label.toUpperCase(), x + 15, y + 15);
                doc.fillColor('#333333').fontSize(18).text(value, x + 15, y + 35);
            };

            const completed = bookings.filter(b => b.status === 'completed').length;
            drawCard(40, 120, 'Total Missions', bookings.length.toString(), '#444444');
            drawCard(215, 120, 'Completed', completed.toString(), '#28a745');
            drawCard(390, 120, 'Daily Revenue', `Rs. ${dailyRevenue.toFixed(2)}`, '#ff5252');

            // --- MISSION LOG TABLE ---
            doc.fillColor('#000000').fontSize(14).text('MISSION LOG (DAILY SNAPSHOT)', 40, 215);
            
            // Table Header
            const startY = 240;
            doc.rect(40, startY, 515, 20).fill('#1a1a1a');
            doc.fillColor('#ffffff').fontSize(9);
            doc.text('ID', 50, startY + 6);
            doc.text('TYPE', 80, startY + 6);
            doc.text('STATUS', 140, startY + 6);
            doc.text('CUSTOMER', 210, startY + 6);
            doc.text('ROUTE', 320, startY + 6);
            doc.text('FARE', 490, startY + 6);

            // Table Rows
            let rowY = startY + 20;
            doc.fillColor('#333333');
            bookings.slice(0, 20).forEach((b, i) => {
                if (i % 2 === 0) doc.rect(40, rowY, 515, 25).fill('#fafafa');
                doc.fillColor('#444444').fontSize(8);
                doc.text(b.id.toString(), 50, rowY + 8);
                doc.text((b.trip_type || 'oneway').toUpperCase(), 80, rowY + 8);
                
                const statusColor = b.status === 'completed' ? '#28a745' : (b.status === 'pending' ? '#ffc107' : '#dc3545');
                doc.fillColor(statusColor).text(b.status.toUpperCase(), 140, rowY + 8);
                
                doc.fillColor('#444444').text(b.customer_name || 'Walk-in', 210, rowY + 8);
                const route = `${b.pickup_loc.substring(0, 15)} -> ${b.drop_loc.substring(0, 15)}`;
                doc.text(route, 320, rowY + 8);
                doc.text(b.fare, 490, rowY + 8);
                rowY += 25;
            });

            // --- FOOTER ---
            doc.fontSize(8).fillColor('#aaaaaa').text('CONFIDENTIAL SYSTEM GENERATED DOCUMENT • CITYRIDE TAXI ADMINISTRATION', 40, 780, { align: 'center' });

            doc.end();
        });
        const pdfContent = await pdfPromise;

        // 4. Dispatch via HTTP
        const subject = `[SYSTEM BACKUP] CityRide Logistics - ${new Date().toLocaleDateString()}`;
        const html = `
            <div style="font-family: sans-serif; padding: 25px; border: 1px solid #eee; border-radius: 12px;">
                <h1 style="margin:0; color:#ff5252;">Daily Audit Complete</h1>
                <p>Hello Admin, your Daily Intelligence Backup and Logistics Spreadsheet are attached below.</p>
                <div style="background: #f8f8f8; padding: 15px; border-left: 5px solid #ff5252; margin: 20px 0;">
                    <strong>Revenue:</strong> Rs. ${dailyRevenue.toFixed(2)}<br>
                    <strong>Missions Logged:</strong> ${bookings.length}
                </div>
            </div>
        `;

        const attachments = [
            { content: csvContent, name: `Logistics_${new Date().getTime()}.csv` },
            { content: pdfContent, name: `Audit_Report_${new Date().getTime()}.pdf` }
        ];

        await sendBrevoMail(process.env.REPORT_RECEIVER_EMAIL, subject, html, attachments);
        console.log('✅ Advanced Integrity Backup Delivered Successfully.');
    } catch (err) {
        console.error('❌ Advanced Backup Failure:', err.message);
    }
}

// Schedule: 11:59 PM Daily
cron.schedule('59 23 * * *', () => {
    sendDailyReport();
});

startServer();

// --- AUTHENTICATION ROUTES ---
// 1. Send OTP (Email Verification Request)
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    try {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await db.query('DELETE FROM otps WHERE email = ?', [email]);
        await db.query('INSERT INTO otps (email, otp, expires_at) VALUES (?, ?, ?)', [email, otp, expiresAt]);

        const subject = 'CityRide platform verification code';
        const html = `<div style="font-family: Arial, sans-serif; padding: 25px; border: 4px solid #1a1a1a; border-radius: 15px; max-width: 500px; text-align: center;">
                          <h2 style="color: #ff5252;">Identity <span style="color: #1a1a1a;">Verification</span></h2>
                          <p style="color: #555;">Use the following code to authorize your action:</p>
                          <div style="background: #f8f8f8; padding: 20px; font-size: 38px; font-weight: bold; letter-spacing: 12px; color: #000; border-radius: 8px;">
                              ${otp}
                          </div>
                          <p style="color: #888; font-size: 10px; margin-top: 20px;">Requested at: ${new Date().toLocaleTimeString()}</p>
                      </div>`;

        console.log(`[BREVO API] Dispatching OTP for: ${email}`);
        await sendBrevoMail(email, subject, html);
        res.json({ success: true, message: 'OTP sent successfully via API.' });
    } catch (err) {
        console.error('--- BREVO API FAIL ---', err.message);
        res.status(500).json({ error: 'Mail delivery failure (API Gateway)' });
    }
});

// 2. Passenger Registry (With OTP Validation)
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, phone, otp } = req.body;
        
        // 1. Validate OTP (DISABLED)
        // const [otpRows] = await db.query('SELECT * FROM otps WHERE email = ? AND otp = ? AND expires_at > NOW()', [email, otp]);
        // if (otpRows.length === 0) return res.status(400).json({ error: 'Invalid or expired OTP.' });

        // 2. Check for Existing Member
        const [existing] = await db.query('SELECT id FROM passengers WHERE phone = ? OR email = ?', [phone, email]);
        if (existing.length > 0) return res.status(400).json({ error: 'Identity already registered in the mainframe.' });

        // 3. Register Member
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const sql = 'INSERT INTO passengers (name, email, password, phone) VALUES (?, ?, ?, ?)';
        const [result] = await db.query(sql, [name, email, hashedPassword, phone]);
        
        // Cleanup OTP (DISABLED)
        // await db.query('DELETE FROM otps WHERE email = ?', [email]);
        
        res.json({ success: true, userId: result.insertId });
    } catch (err) {
        res.status(500).json({ error: 'Registry Failure' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone, email, password } = req.body;
        const identifier = phone || email;
        
        if (!identifier || !password) {
            return res.status(400).json({ error: 'Identifier (phone/email) and password are required.' });
        }

        // Check against both phone and email
        const [users] = await db.query(
            'SELECT id, name, email, phone, password, is_blocked FROM passengers WHERE phone = ? OR email = ?', 
            [identifier, identifier]
        );
        
        if (users.length > 0) {
            const user = users[0];
            if (user.is_blocked) return res.status(403).json({ error: 'Mainframe: Your access has been permanently revoked by Command.' });
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) {
                delete user.password;
                user.role = 'user';
                return res.json({ success: true, user });
            }
        }
        res.status(401).json({ error: 'Invalid phone number or password.' });
    } catch (err) {
        res.status(500).json({ error: 'Auth Failure' });
    }
});

// 3. Admin Command Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [admins] = await db.query('SELECT id, name, email, password FROM admins WHERE email = ?', [email]);
        
        if (admins.length > 0) {
            const user = admins[0];
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) {
                delete user.password;
                user.role = 'admin';
                return res.json({ success: true, user });
            }
        }
        res.status(401).json({ error: 'Mainframe Access Denied.' });
    } catch (err) {
        res.status(500).json({ error: 'Executive Auth Failure' });
    }
});

// 4. Partner Pilot Login
app.post('/api/driver/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const [drivers] = await db.query('SELECT id, name, email, phone, car_model, car_number, vehicle_type, wallet_balance, password, is_blocked FROM drivers WHERE phone = ?', [phone]);
        
        if (drivers.length > 0) {
            const user = drivers[0];
            if (user.is_blocked) return res.status(403).json({ error: 'Flight Status: Denied. Your authorization key has been revoked by Ground Control.' });
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) {
                delete user.password;
                user.role = 'driver';
                return res.json({ success: true, user });
            }
        }
        res.status(401).json({ error: 'Pilot Authorization Denied. Invalid phone number or password.' });
    } catch (err) {
        res.status(500).json({ error: 'Pilot Auth Failure' });
    }
});

// --- DRIVER REGISTRATION OTP FLOW ---
app.post('/api/driver/register/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required for verification.' });

        // Check if email already in use
        const [existing] = await db.query('SELECT id FROM drivers WHERE email = ?', [email]);
        const [existingApp] = await db.query('SELECT id FROM driver_applications WHERE email = ?', [email]);
        if (existing.length > 0 || existingApp.length > 0) {
            return res.status(400).json({ error: 'This email is already registered or has a pending application.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        registrationOtps.set(email, { otp, expiry: Date.now() + 10 * 60 * 1000 }); // 10 min expiry

        const subject = 'CityRide Pilot Identity Verification';
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #B71C1C;">Pilot Recruitment Hub</h2>
                <p>Greetings, Pilot. You are attempting to register with the CityRide Network.</p>
                <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
                    <span style="font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #333;">${otp}</span>
                </div>
                <p>Enter this verification token in your registration portal to continue. This code is valid for 10 minutes.</p>
                <p style="font-size: 0.8rem; color: #888;">If you did not request this, please ignore this email.</p>
            </div>
        `;

        await sendBrevoMail(email, subject, html);
        res.json({ success: true, message: 'Verification token dispatched to your inbox.' });
    } catch (err) {
        console.error('OTP Dispatch Error:', err.message);
        res.status(500).json({ error: 'Neural Link failed (Email System Offline).' });
    }
});

app.post('/api/driver/register/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and token are required.' });

    const stored = registrationOtps.get(email);
    if (!stored) return res.status(400).json({ error: 'No verification request found for this email.' });

    if (Date.now() > stored.expiry) {
        registrationOtps.delete(email);
        return res.status(400).json({ error: 'Verification token expired. Please request a new one.' });
    }

    if (stored.otp !== otp) {
        return res.status(400).json({ error: 'Invalid verification token.' });
    }

    // Mark as verified
    stored.verified = true;
    res.json({ success: true, message: 'Identity verified. You may now continue your application.' });
});

// --- DRIVER REGISTRATION (MULTI-STEP WITH DOCS) ---
app.post('/api/driver/register', upload.fields([
    { name: 'dl_front', maxCount: 1 },
    { name: 'dl_back', maxCount: 1 },
    { name: 'pvc', maxCount: 1 },
    { name: 'aadhar_front', maxCount: 1 },
    { name: 'aadhar_back', maxCount: 1 },
    { name: 'rc_book', maxCount: 1 },
    { name: 'insurance', maxCount: 1 },
    { name: 'pollution', maxCount: 1 },
    { name: 'permit', maxCount: 1 }
]), async (req, res) => {
    try {
        const { name, email, password, phone, car_model, car_number, vehicle_type } = req.body;
        
        // Validation
        if (!name || !email || !password || !phone) {
            return res.status(400).json({ error: 'Core identity details are required.' });
        }

        // Verify OTP Status (DISABLED)
        // const otpStatus = registrationOtps.get(email);
        // if (!otpStatus || !otpStatus.verified) {
        //     return res.status(401).json({ error: 'Identity Verification Required. Please verify your email via OTP first.' });
        // }

        // Check availability
        const [existingEmail] = await db.query('SELECT id FROM driver_applications WHERE email = ?', [email]);
        const [existingDriverEmail] = await db.query('SELECT id FROM drivers WHERE email = ?', [email]);
        const [existingPhone] = await db.query('SELECT id FROM driver_applications WHERE phone = ?', [phone]);
        const [existingDriverPhone] = await db.query('SELECT id FROM drivers WHERE phone = ?', [phone]);

        if (existingEmail.length > 0 || existingDriverEmail.length > 0) {
            return res.status(400).json({ error: 'This email is already registered or has a pending application.' });
        }
        if (existingPhone.length > 0 || existingDriverPhone.length > 0) {
            return res.status(400).json({ error: 'This phone number is already registered or has a pending application.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const getFilePath = (fieldname) => {
            return (req.files && req.files[fieldname]) ? `/uploads/drivers/${req.files[fieldname][0].filename}` : null;
        };

        const sql = `
            INSERT INTO driver_applications 
            (name, email, password, phone, car_model, car_number, vehicle_type, 
             dl_front, dl_back, pvc, aadhar_front, aadhar_back, 
             rc_book, insurance, pollution, permit) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const values = [
            name, email, hashedPassword, phone, car_model, car_number, vehicle_type,
            getFilePath('dl_front'), getFilePath('dl_back'), getFilePath('pvc'), 
            getFilePath('aadhar_front'), getFilePath('aadhar_back'),
            getFilePath('rc_book'), getFilePath('insurance'), getFilePath('pollution'), getFilePath('permit')
        ];

        await db.query(sql, values);
        res.json({ success: true, message: 'Application submitted! Ground Control will review your credentials shortly.' });
    } catch (err) {
        console.error('Driver Registration Error:', err.message);
        res.status(500).json({ error: 'Failed to process application.' });
    }
});

// --- ADMIN: MANAGE DRIVER APPLICATIONS ---
app.get('/api/admin/driver-applications', async (req, res) => {
    try {
        const { status } = req.query;
        let sql = 'SELECT * FROM driver_applications';
        let params = [];
        
        if (status) {
            sql += ' WHERE status = ?';
            params.push(status);
        } else {
            // Default to pending for the main queue
            sql += ' WHERE status = "pending"';
        }
        
        sql += ' ORDER BY created_at DESC';
        
        const [apps] = await db.query(sql, params);
        res.json({ success: true, applications: apps });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch applications.' });
    }
});

app.get('/api/admin/driver-applications/history', async (req, res) => {
    try {
        const [apps] = await db.query('SELECT * FROM driver_applications WHERE status = "approved" ORDER BY created_at DESC');
        res.json({ success: true, applications: apps });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch application history.' });
    }
});

app.post('/api/admin/driver-applications/decision', async (req, res) => {
    const { appId, status, note } = req.body; // status: approved or rejected
    try {
        const [apps] = await db.query('SELECT * FROM driver_applications WHERE id = ?', [appId]);
        if (apps.length === 0) return res.status(404).json({ error: 'Application not found.' });
        
        const app = apps[0];

        if (status === 'approved') {
            // Move to drivers table with all documents
            const sql = `
                INSERT INTO drivers (
                    name, email, password, phone, car_model, car_number, vehicle_type, approval_status,
                    dl_front, dl_back, pvc, aadhar_front, aadhar_back, rc_book, insurance, pollution, permit
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const values = [
                app.name, app.email, app.password, app.phone, app.car_model, app.car_number, app.vehicle_type,
                app.dl_front, app.dl_back, app.pvc, app.aadhar_front, app.aadhar_back, 
                app.rc_book, app.insurance, app.pollution, app.permit
            ];
            await db.query(sql, values);
            
            // Mark application as approved (History Storage)
            await db.query('UPDATE driver_applications SET status = "approved", admin_note = ? WHERE id = ?', [note || 'Approved by Command', appId]);

            // Optional: Send Email Notification
            await sendBrevoMail(app.email, 'CityRide Pilot Identity Verified', `<h2>Welcome to the fleet, Pilot!</h2><p>Your application has been authorized by Command. You can now log in to the Driver Portal and begin your missions.</p>`).catch(e => console.error('Approval notification failed', e));

        } else {
            // REJECTED: Delete application data as requested
            await db.query('DELETE FROM driver_applications WHERE id = ?', [appId]);
            
            // Optional: Send Email Notification before deletion? 
            // Better to send first then delete, but we already have 'app' data in memory.
            await sendBrevoMail(app.email, 'Pilot Application Update', `<h2>Ground Control Update</h2><p>Your application was not authorized at this time.</p><p><strong>Reason:</strong> ${note}</p>`).catch(e => console.error('Rejection notification failed', e));
        }

        res.json({ success: true, message: `Application ${status} successfully.` });
    } catch (err) {
        console.error('Decision Error:', err.message);
        res.status(500).json({ error: 'Failed to process decision.' });
    }
});

// 4.1 Get Latest Driver Info
app.get('/api/driver/info/:id', async (req, res) => {
    try {
        const [drivers] = await db.query('SELECT id, name, email, phone, car_model, car_number, vehicle_type, wallet_balance FROM drivers WHERE id = ?', [req.params.id]);
        if (drivers.length > 0) {
            res.json({ success: true, driver: drivers[0] });
        } else {
            res.status(404).json({ error: 'Pilot not found.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch pilot info' });
    }
});

// 5. Vendor Partner Login
app.post('/api/vendor/login', async (req, res) => {
    try {
        const { vendor_id, password } = req.body;
        const [rows] = await db.query('SELECT * FROM vendors WHERE vendor_id = ?', [vendor_id]);
        
        if (rows.length > 0) {
            const vendor = rows[0];
            if (vendor.is_blocked) return res.status(403).json({ error: 'Partner Access Revoked. Contact Command.' });
            const isMatch = await bcrypt.compare(password, vendor.password);
            if (isMatch) {
                delete vendor.password;
                vendor.role = 'vendor';
                return res.json({ success: true, user: vendor });
            }
        }
        res.status(401).json({ error: 'Auth Failure. Invalid Vendor ID/Key.' });
    } catch (err) {
        res.status(500).json({ error: 'Partner Auth Failure' });
    }
});

// --- AI CHATBOT / SUPPORT WIDGET API ---
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message required' });

        // Offline Fallback
        if (!process.env.GEMINI_API_KEY) {
            return res.json({ 
                success: true, 
                reply: "I am the CityRide AI. I am currently offline because the Ground Command has not connected my Neural Link API Key yet. Please call us directly!" 
            });
        }

        const apiKey = (process.env.GEMINI_API_KEY || '').trim();
        const genAI = new GoogleGenerativeAI(apiKey);
        
        // Final verified model: gemini-flash-latest is the only one with active quota for this project.
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        const prompt = `You are "CityRide AI", the official virtual assistant for CityRideTaxi.
        Your style: Friendly, professional, and concise (max 2 sentences).
        Core Knowledge:
        - Fares: Sedan is ₹25/KM. SUV is ₹35/KM.
        - Limits: Local rides are capped at 50 KM (otherwise use Outstation).
        Response Instructions: 
        - Only mention booking or redirecting if the user specifically asks how to book or seems ready to ride. 
        - Answer their specific question directly first.
        User says: ${message}`;

        try {
            const result = await model.generateContent(prompt);
            res.json({ success: true, reply: result.response.text() });
        } catch (apiErr) {
            console.error('Google API Error Handled Gracefully:', apiErr.message);
            // If the key is invalid, region-locked, or 404s, NEVER crash the server. Provide a fallback!
            return res.json({
                success: true,
                reply: "I'm currently experiencing neural network maintenance or regional API locks. Please use the 'Raise Ticket' tab next to me to submit your query directly to our team!"
            });
        }
    } catch (err) {
        console.error('Core AI Route Error:', err.message);
        res.status(500).json({ error: 'AI systems crashed.' });
    }
});

app.post('/api/support/ticket', async (req, res) => {
    try {
        const { name, email, query } = req.body;
        if (!name || !email || !query) return res.status(400).json({ error: 'All fields required.' });

        // Send email to admin (Receiver)
        const adminEmail = process.env.REPORT_RECEIVER_EMAIL || 'sureshit2005@gmail.com';
        const subject = `🎫 New Support Ticket from ${name}`;
        const html = `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; max-width: 600px;">
                <h2 style="color: #ff5252;">New Support Ticket</h2>
                <p><strong>Customer Name:</strong> ${name}</p>
                <p><strong>Reply to Email:</strong> ${email}</p>
                <hr style="border-top: 1px dashed #ccc;" />
                <p><strong>Issue/Query:</strong></p>
                <div style="background: #f8f8f8; padding: 15px; border-radius: 8px;">
                    ${query}
                </div>
            </div>
        `;
        
        await sendBrevoMail(adminEmail, subject, html);
        
        // --- AUTO-MESSAGE / AUTO-REPLY TO CUSTOMER ---
        const customerSubject = `Ticket Received - CityRideTaxi Support`;
        const customerHtml = `
            <div style="font-family: sans-serif; padding: 20px; border-left: 4px solid #ff5252; background: #f9f9f9; max-width: 600px;">
                <h3 style="color: #333;">Hello ${name},</h3>
                <p>This is an automated message confirming that your support ticket has been logged into our system successfully.</p>
                <p>Our operations team will review your query and respond directly to this email address within 12 business hours.</p>
                <p style="margin-top: 20px; font-size: 0.9rem; color: #777;">Thank you for riding with us,<br/><strong>CityRideTaxi Command Team</strong></p>
            </div>
        `;
        // Send auto-responder back to the customer's inputted email
        await sendBrevoMail(email, customerSubject, customerHtml).catch(e => console.error('Auto-reply failed', e));

        res.json({ success: true, message: 'Ticket received. We will email you shortly.' });
    } catch (err) {
        console.error('Ticket Error:', err.message);
        res.status(500).json({ error: 'Failed to send ticket.' });
    }
});

// 2. Booking Management
app.post('/api/bookings/create', async (req, res) => {
    try {
        const booking = req.body;
        const journeyOtp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP
        const values = [
            booking.userId || 1,
            String(booking.pickup || ''),
            booking.pickupCoords,
            String(booking.drop || ''),
            booking.dropCoords,
            booking.date,
            booking.time,
            parseInt(booking.passengers) || 1,
            String(booking.vehicle || 'sedan'),
            String(booking.tripType || 'oneway'),
            String(booking.fare || '₹0'),
            String(booking.distance || '0 KM'),
            journeyOtp,
            'pending',
            booking.vendorId || null,
            booking.vendorMarkup || 0,
            booking.rentalPackage || null
        ];
        const [result] = await db.query('INSERT INTO bookings (user_id, pickup_loc, pickup_coords, drop_loc, drop_coords, pickup_date, pickup_time, passengers, vehicle_type, trip_type, fare, distance, journey_otp, status, vendor_id, vendor_markup, rental_package) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', values);
        res.json({ success: true, bookingId: result.insertId, journeyOtp: journeyOtp });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.1.1 Cancel Ride (Passenger) — with 3-cancel-per-day ban enforcement
app.post('/api/user/cancel-ride', async (req, res) => {
    try {
        const { bookingId, userId } = req.body;
        if (!bookingId || !userId) return res.status(400).json({ error: 'bookingId and userId are required.' });

        const [passRows] = await db.query('SELECT id, banned_until FROM passengers WHERE id = ?', [userId]);
        if (passRows.length === 0) return res.status(404).json({ error: 'User not found.' });
        const passenger = passRows[0];
        if (passenger.banned_until) {
            const banEnd = new Date(passenger.banned_until);
            if (banEnd > new Date()) {
                const timeLeft = Math.ceil((banEnd - new Date()) / (1000 * 60 * 60));
                return res.status(403).json({
                    error: `Your account is temporarily suspended for excessive cancellations. Ban lifts in ${timeLeft} hour(s).`,
                    banned: true,
                    banned_until: passenger.banned_until
                });
            }
        }

        const [bookings] = await db.query('SELECT id, status FROM bookings WHERE id = ? AND user_id = ?', [bookingId, userId]);
        if (bookings.length === 0) return res.status(404).json({ error: 'Booking not found.' });
        if (!['pending', 'assigned'].includes(bookings[0].status)) {
            return res.status(400).json({ error: 'Only pending or assigned rides can be cancelled.' });
        }

        await db.query('UPDATE bookings SET status = "cancelled", driver_id = NULL WHERE id = ?', [bookingId]);

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const [cancelRows] = await db.query(
            `SELECT COUNT(*) as cnt FROM bookings WHERE user_id = ? AND status = 'cancelled' AND created_at >= ?`,
            [userId, todayStart]
        );
        const cancelCount = cancelRows[0].cnt;

        let banned = false;
        let banUntil = null;
        if (cancelCount >= 3) {
            banUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await db.query('UPDATE passengers SET banned_until = ? WHERE id = ?', [banUntil, userId]);
            banned = true;
        }

        res.json({ success: true, cancelCount, banned, banned_until: banUntil });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.1.2 Check Passenger Ban Status
app.get('/api/user/ban-status/:userId', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT banned_until FROM passengers WHERE id = ?', [req.params.userId]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        const banEnd = rows[0].banned_until ? new Date(rows[0].banned_until) : null;
        const isBanned = banEnd && banEnd > new Date();
        res.json({ banned: isBanned, banned_until: isBanned ? rows[0].banned_until : null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.2 User Ride History
app.get('/api/user/bookings/:userId', async (req, res) => {
    try {
        const sql = `
            SELECT b.*, d.name as driver_name, d.phone as driver_phone, d.car_model, d.car_number 
            FROM bookings b 
            LEFT JOIN drivers d ON b.driver_id = d.id 
            WHERE b.user_id = ? 
            ORDER BY b.created_at DESC
        `;
        const [rows] = await db.query(sql, [req.params.userId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'History Retrieval Failure' });
    }
});

// 2.3 Accept Ride (Driver Action)
app.post('/api/bookings/accept', async (req, res) => {
    try {
        const { bookingId, driverId } = req.body;
        const [bookings] = await db.query('SELECT fare FROM bookings WHERE id = ? AND status = "pending"', [bookingId]);
        if (bookings.length === 0) return res.status(400).json({ error: 'Ride no longer available.' });
        
        const bookingFare = parseFloat(bookings[0].fare.replace(/[^0-9.]/g, '')) || 0;
        const requiredBalance = bookingFare * 0.10;
        
        const [drivers] = await db.query('SELECT wallet_balance FROM drivers WHERE id = ?', [driverId]);
        if (drivers.length === 0) return res.status(400).json({ error: 'Pilot not found.' });
        
        if (parseFloat(drivers[0].wallet_balance) < requiredBalance) {
            return res.status(400).json({ error: `Insufficient funds. Need ₹${requiredBalance.toFixed(2)}.` });
        }

        // --- ENFORCE SINGLE ACTIVE MISSION RULE ---
        const [active] = await db.query('SELECT id FROM bookings WHERE driver_id = ? AND status = "assigned"', [driverId]);
        if (active.length > 0) {
            return res.status(400).json({ error: 'Ground Control: You already have an active mission locked in. Complete your current duty before accepting new targets.' });
        }

        await db.query('UPDATE bookings SET status = "assigned", driver_id = ? WHERE id = ?', [driverId, bookingId]);
        await db.query('UPDATE drivers SET wallet_balance = wallet_balance - ? WHERE id = ?', [requiredBalance, driverId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.3.1 Request Cancellation (Driver Action)
app.post('/api/driver/request-cancel', async (req, res) => {
    try {
        const { bookingId, driverId, reason } = req.body;
        const [bookings] = await db.query('SELECT status FROM bookings WHERE id = ? AND driver_id = ?', [bookingId, driverId]);
        if (bookings.length === 0) return res.status(404).json({ error: 'Mission not found.' });
        if (bookings[0].status !== 'assigned') return res.status(400).json({ error: 'Only assigned missions can be aborted.' });

        await db.query('UPDATE bookings SET status = "cancel_requested", cancel_reason = ? WHERE id = ?', [reason || 'No reason provided', bookingId]);
        res.json({ success: true, message: 'Cancellation request sent to Ground Control.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.3.2 Approve Cancellation (Admin Action)
app.post('/api/admin/approve-cancel', async (req, res) => {
    try {
        const { bookingId } = req.body;
        await db.query('UPDATE bookings SET status = "cancelled", driver_id = NULL WHERE id = ?', [bookingId]);
        res.json({ success: true, message: 'Mission officially aborted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.3.3 Reject Cancellation (Admin Action)
app.post('/api/admin/reject-cancel', async (req, res) => {
    try {
        const { bookingId, note } = req.body;
        const [bookings] = await db.query('SELECT driver_id, cancel_reason FROM bookings WHERE id = ?', [bookingId]);
        if (bookings.length > 0) {
            await db.query('INSERT INTO abort_rejections (booking_id, driver_id, original_reason, admin_note) VALUES (?, ?, ?, ?)', 
                [bookingId, bookings[0].driver_id, bookings[0].cancel_reason, note || 'Rejected by Admin Control']);
        }
        await db.query('UPDATE bookings SET status = "assigned" WHERE id = ?', [bookingId]);
        res.json({ success: true, message: 'Cancellation rejected. Mission remains active.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.3.4 Abort Rejection History (Admin Action)
app.get('/api/admin/rejection-history', async (req, res) => {
    try {
        const sql = `
            SELECT r.*, d.name as driver_name, b.pickup_loc, b.drop_loc 
            FROM abort_rejections r
            LEFT JOIN drivers d ON r.driver_id = d.id
            LEFT JOIN bookings b ON r.booking_id = b.id
            ORDER BY r.created_at DESC
        `;
        const [rows] = await db.query(sql);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.4 Driver Current Jobs
app.get('/api/driver/my-jobs/:driverId', async (req, res) => {
    try {
        const sql = `
            SELECT b.*, u.name as customer_name, u.phone as customer_phone 
            FROM bookings b 
            LEFT JOIN passengers u ON b.user_id = u.id 
            WHERE b.driver_id = ? AND b.status IN ("assigned", "ongoing", "finished", "completed", "cancel_requested")
            ORDER BY b.created_at DESC
        `;
        const [rows] = await db.query(sql, [req.params.driverId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Admin Panel Stats
app.get('/api/admin/stats', async (req, res) => {
    try {
        const [totalBookings] = await db.query("SELECT COUNT(*) as count FROM bookings");
        const [activeBookings] = await db.query("SELECT COUNT(*) as count FROM bookings WHERE status IN ('pending', 'assigned')");
        const [totalRevenue] = await db.query("SELECT fare FROM bookings WHERE status = 'completed'");
        const [driverCount] = await db.query("SELECT COUNT(*) as count FROM drivers");
        const [userCount] = await db.query("SELECT COUNT(*) as count FROM passengers");

        let revenue = 0;
        totalRevenue.forEach(row => {
            revenue += parseFloat(row.fare.replace(/[^0-9.]/g, '')) || 0;
        });

        res.json({
            totalBookings: totalBookings[0].count,
            activeBookings: activeBookings[0].count,
            revenue: revenue,
            totalDrivers: driverCount[0].count,
            totalUsers: userCount[0].count
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3.1 Detailed Bookings for Admin
app.get('/api/admin/bookings', async (req, res) => {
    try {
        const sql = `
            SELECT b.*, u.name as customer_name, u.phone as customer_phone, 
                   d.name as driver_name, d.car_model, d.car_number, d.phone as driver_phone,
                   v.business_name as vendor_business_name
            FROM bookings b
            LEFT JOIN passengers u ON b.user_id = u.id
            LEFT JOIN drivers d ON b.driver_id = d.id
            LEFT JOIN vendors v ON b.vendor_id = v.id
            ORDER BY b.created_at DESC
        `;
        const [rows] = await db.query(sql);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3.2 Member Management
app.get('/api/admin/users', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT id, name, email, phone, 'user' as role, is_blocked, created_at FROM passengers ORDER BY created_at DESC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3.2.1 Fleet Management
app.get('/api/admin/drivers', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT id, name, email, phone, 'driver' as role, car_model, car_number, vehicle_type, wallet_balance, is_blocked, created_at FROM drivers ORDER BY created_at DESC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3.3 Delete Operations
app.post('/api/admin/delete-passenger', async (req, res) => {
    try {
        await db.query("DELETE FROM passengers WHERE id = ?", [req.body.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/delete-driver', async (req, res) => {
    try {
        await db.query("DELETE FROM drivers WHERE id = ?", [req.body.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/update-user', async (req, res) => {
    try {
        const { id, name, email, phone, password } = req.body;
        
        let sql = 'UPDATE passengers SET name = ?, email = ?, phone = ?';
        let params = [name, email, phone];

        if (password && password.trim() !== "") {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            sql += ', password = ?';
            params.push(hashedPassword);
        }

        sql += ' WHERE id = ?';
        params.push(id);

        await db.query(sql, params);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3.4 Registry Updates
app.post('/api/admin/update-driver', async (req, res) => {
    try {
        const { id, name, email, phone, car_model, car_number, vehicle_type, password } = req.body;
        
        let sql = 'UPDATE drivers SET name = ?, email = ?, phone = ?, car_model = ?, car_number = ?, vehicle_type = ?';
        let params = [name, email, phone, car_model, car_number, vehicle_type];

        if (password && password.trim() !== "") {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            sql += ', password = ?';
            params.push(hashedPassword);
        }

        sql += ' WHERE id = ?';
        params.push(id);

        await db.query(sql, params);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3.4.1 Wallet Update
app.post('/api/admin/update-driver-wallet', async (req, res) => {
    try {
        await db.query('UPDATE drivers SET wallet_balance = ? WHERE id = ?', [req.body.wallet_balance, req.body.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3.4.1.2 Password Reset (Driver)
app.post('/api/admin/update-driver-password', async (req, res) => {
    try {
        const { id, password } = req.body;
        if (!id || !password) return res.status(400).json({ error: 'ID and password are required.' });
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        await db.query('UPDATE drivers SET password = ? WHERE id = ?', [hashedPassword, id]);
        res.json({ success: true, message: 'Driver password updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update driver password.' });
    }
});

// 3.4.1.3 Password Reset (Passenger)
app.post('/api/admin/update-passenger-password', async (req, res) => {
    try {
        const { id, password } = req.body;
        if (!id || !password) return res.status(400).json({ error: 'ID and password are required.' });
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        await db.query('UPDATE passengers SET password = ? WHERE id = ?', [hashedPassword, id]);
        res.json({ success: true, message: 'Passenger password updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update passenger password.' });
    }
});

// 3.4.2 Block/Unblock Operations
app.post('/api/admin/toggle-block', async (req, res) => {
    try {
        const { id, type, status } = req.body;
        const table = type === 'user' ? 'passengers' : 'drivers';
        await db.query(`UPDATE ${table} SET is_blocked = ? WHERE id = ?`, [status, id]);
        res.json({ success: true, message: `Access ${status ? 'Revoked' : 'Restored'} successfully.` });
    } catch (err) {
        res.status(500).json({ error: 'Command Failure' });
    }
});

// 3.5 Induct Pilot
app.post('/api/admin/create-driver', async (req, res) => {
    try {
        const { name, email, password, phone, car_model, car_number, vehicle_type } = req.body;
        const [existing] = await db.query('SELECT id FROM drivers WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(400).json({ error: 'Pilot email already authorized.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const sql = 'INSERT INTO drivers (name, email, password, phone, car_model, car_number, vehicle_type) VALUES (?, ?, ?, ?, ?, ?, ?)';
        await db.query(sql, [name, email, hashedPassword, phone, car_model, car_number, vehicle_type]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Pilot Induction failed.' });
    }
});

// 3.6 Vendor Partner Management
app.get('/api/admin/vendors', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT id, vendor_id, name, business_name, email, phone, is_blocked, created_at FROM vendors ORDER BY created_at DESC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch partners.' });
    }
});

app.post('/api/admin/create-vendor', async (req, res) => {
    try {
        const { vendor_id, name, business_name, email, password, phone } = req.body;
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const [existing] = await db.query('SELECT id FROM vendors WHERE vendor_id = ? OR email = ?', [vendor_id, email]);
        if (existing.length > 0) return res.status(400).json({ error: 'Partner ID or Email already exists.' });

        const sql = 'INSERT INTO vendors (vendor_id, name, business_name, email, password, phone) VALUES (?, ?, ?, ?, ?, ?)';
        await db.query(sql, [vendor_id, name, business_name, email, hashedPassword, phone]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Partner Induction failed.' });
    }
});

app.post('/api/admin/delete-vendor', async (req, res) => {
    try {
        await db.query("DELETE FROM vendors WHERE id = ?", [req.body.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/driver/jobs/:driverId', async (req, res) => {
    try {
        const [driverRows] = await db.query('SELECT vehicle_type FROM drivers WHERE id = ?', [req.params.driverId]);
        if (driverRows.length === 0) return res.status(404).json({ error: 'Driver not found' });
        
        const driverVehicleType = driverRows[0].vehicle_type;
        const sql = `
            SELECT b.*, u.name as customer_name, u.phone as customer_phone 
            FROM bookings b 
            LEFT JOIN passengers u ON b.user_id = u.id 
            WHERE b.status = "pending" AND b.vehicle_type = ?
            ORDER BY b.created_at ASC
        `;
        const [rows] = await db.query(sql, [driverVehicleType]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4.5 Transfer Ride (Admin Only)
app.post('/api/admin/transfer-ride', async (req, res) => {
    try {
        const { bookingId, newDriverId } = req.body;
        const [bookings] = await db.query('SELECT fare, status FROM bookings WHERE id = ?', [bookingId]);
        if (bookings.length === 0) return res.status(404).json({ error: 'Booking not found.' });

        const fare = bookings[0].fare;
        const requiredBalance = (parseFloat(fare.replace(/[^0-9.]/g, '')) || 0) * 0.10;

        await db.query('UPDATE bookings SET driver_id = ?, status = "assigned" WHERE id = ?', [newDriverId, bookingId]);
        await db.query('UPDATE drivers SET wallet_balance = wallet_balance - ? WHERE id = ?', [requiredBalance, newDriverId]);
        
        res.json({ success: true, message: `Ride #B${bookingId} assigned/transferred. Fee deducted.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Update Booking Status & Odometer/Timer Logic
app.post('/api/bookings/start-journey', async (req, res) => {
    try {
        const { bookingId, startOdometer } = req.body;
        if (!bookingId || !startOdometer) return res.status(400).json({ error: 'Booking ID and Start Odometer are required.' });
        
        await db.query('UPDATE bookings SET status = "ongoing", start_odometer = ?, journey_start_time = NOW() WHERE id = ?', [startOdometer, bookingId]);
        res.json({ success: true, message: 'Journey started. Timer is now running.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/bookings/update-status', async (req, res) => {
    try {
        const { status, bookingId, otp, endOdometer } = req.body;
        
        // If completing, verify OTP
        if (status === 'completed') {
            const [rows] = await db.query('SELECT journey_otp, status, trip_type, rental_package, start_odometer, journey_start_time, vehicle_type, vendor_id, vendor_markup, driver_id, fare FROM bookings WHERE id = ?', [bookingId]);
            if (rows.length === 0) return res.status(404).json({ error: 'Booking missing.' });
            
            const booking = rows[0];

            if (booking.journey_otp !== otp) {
                return res.status(400).json({ error: 'SECURITY ALERT: Verification Token Mismatch. Please check the 4-digit code in passenger details.' });
            }

            // --- VENDOR PROFIT DEDUCTION ---
            let vendorProfitDeducted = 0;
            if (booking.status !== 'completed' && booking.vendor_id && parseFloat(booking.vendor_markup) > 0) {
                vendorProfitDeducted = parseFloat(booking.vendor_markup);
                await db.query('UPDATE drivers SET wallet_balance = wallet_balance - ? WHERE id = ?', [vendorProfitDeducted, booking.driver_id]);
                console.log(`[FINANCE] Deducted ₹${vendorProfitDeducted} vendor profit from Driver #${booking.driver_id} for Ride #B${bookingId}`);
            }

            // Handle Rental Calculations (Legacy - now handled in /finish-trip)
            if (booking.trip_type === 'rental') {
                // If they bypassed finish-trip somehow, we still need journey_end_time
                if (!booking.journey_end_time) {
                    await db.query('UPDATE bookings SET journey_end_time = NOW() WHERE id = ?', [bookingId]);
                }
            } else {
                // Non-rental rides also record end time
                await db.query('UPDATE bookings SET journey_end_time = NOW() WHERE id = ?', [bookingId]);
            }

            await db.query('UPDATE bookings SET status = ? WHERE id = ?', [status, bookingId]);
            
            return res.json({ 
                success: true, 
                vendorProfit: vendorProfitDeducted,
                totalFare: booking.fare,
                baseFare: (parseFloat(booking.fare.replace(/[^0-9.]/g,'')) || 0) - vendorProfitDeducted
            });
        }
        
        await db.query('UPDATE bookings SET status = ? WHERE id = ?', [status, bookingId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.8 Finish Trip (Odometer Input & Fare Calculation)
app.post('/api/bookings/finish-trip', async (req, res) => {
    try {
        const { bookingId, endOdometer } = req.body;
        if (!endOdometer) return res.status(400).json({ error: 'End Odometer reading is required.' });

        const [rows] = await db.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Booking not found.' });

        const booking = rows[0];
        const distanceCovered = parseInt(endOdometer) - parseInt(booking.start_odometer);
        if (distanceCovered < 0) return res.status(400).json({ error: 'End Odometer cannot be less than Start Odometer.' });

        let finalFareStr = booking.fare;
        let durationHrs = null;

        if (booking.trip_type === 'rental') {
            const [tariffRows] = await db.query('SELECT config FROM tariffs WHERE vehicle_type = ? AND category = "rental"', [booking.vehicle_type]);
            if (tariffRows.length > 0) {
                const config = typeof tariffRows[0].config === 'string' ? JSON.parse(tariffRows[0].config) : tariffRows[0].config;
                const packageConfig = config[booking.rental_package];
                
                if (packageConfig) {
                    const [pMaxHrs, pMaxKm] = booking.rental_package.split('-').map(Number);
                    
                    // 1. Distance Calculation
                    const extraKm = Math.max(0, distanceCovered - pMaxKm);
                    const extraKmCharge = extraKm * packageConfig.extraKm;

                    // 2. Time Calculation
                    const startTime = new Date(booking.journey_start_time);
                    const endTime = new Date();
                    const durationMs = endTime - startTime;
                    durationHrs = durationMs / (1000 * 60 * 60);
                    
                    const extraHrs = Math.max(0, Math.ceil(durationHrs - pMaxHrs));
                    const extraHrCharge = extraHrs * packageConfig.extraHour;

                    const totalExtra = extraKmCharge + extraHrCharge;
                    const baseWithExtra = packageConfig.base + totalExtra;
                    const finalFareNum = Math.ceil(baseWithExtra * 1.05); // Incl 5% GST
                    
                    finalFareStr = `₹${finalFareNum}`;
                }
            }
        }

        // Update booking to 'finished' state
        await db.query('UPDATE bookings SET status = "finished", end_odometer = ?, journey_end_time = NOW(), fare = ? WHERE id = ?', [endOdometer, finalFareStr, bookingId]);
        
        res.json({ 
            success: true, 
            finalFare: finalFareStr, 
            distance: distanceCovered,
            duration: durationHrs ? durationHrs.toFixed(2) : null 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- GEOCODING PROXY (To avoid CORS issues with Photon API) ---
app.get('/api/proxy/geocode', async (req, res) => {
    try {
        const { q, limit, lang, lon, lat } = req.query;
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit || 5}&lang=${lang || 'en'}&lon=${lon}&lat=${lat}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (err) {
        console.error('Geocode Proxy Error:', err.message);
        res.status(500).json({ error: 'Geocoding service unavailable via proxy.' });
    }
});

app.get('/api/proxy/reverse', async (req, res) => {
    try {
        const { lon, lat } = req.query;
        const url = `https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (err) {
        console.error('Reverse Geocode Proxy Error:', err.message);
        res.status(500).json({ error: 'Reverse geocoding service unavailable via proxy.' });
    }
});

app.get('/api/proxy/route', async (req, res) => {
    try {
        const { pickup, drop } = req.query;
        const url = `https://router.project-osrm.org/route/v1/driving/${pickup};${drop}?overview=false`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (err) {
        console.error('Route Proxy Error:', err.message);
        res.status(500).json({ error: 'Routing service unavailable via proxy.' });
    }
});

// --- CONFIGURATION & UTILITIES ---
app.get('/api/config/maps-key', (req, res) => {
    res.json({ mapboxToken: process.env.MAPBOX_ACCESS_TOKEN || '' });
});

// --- RATE TARIFF CONTROLLER ---
app.get('/api/tariffs', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM tariffs');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch tariffs' });
    }
});

app.post('/api/admin/update-tariff', async (req, res) => {
    try {
        const { id, config } = req.body;
        if (!id || !config) return res.status(400).json({ error: 'ID and config are required.' });
        
        await db.query('UPDATE tariffs SET config = ? WHERE id = ?', [JSON.stringify(config), id]);
        res.json({ success: true, message: 'Tariff updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update tariff.' });
    }
});

// --- TESTING UTILITIES ---
// Trigger the Daily Report manually for testing
app.get('/api/test/daily-report', async (req, res) => {
    console.log('--- MANUAL TEST REPORT TRIGGERED ---');
    try {
        await sendDailyReport();
        res.json({ success: true, message: 'Intel report triggered. Check sureshit2005@gmail.com inbox or check server console for status.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
