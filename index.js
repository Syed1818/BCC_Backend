const express = require('express');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); 

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// 1. BULLETPROOF MIDDLEWARE
// ==========================================
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// 2. Database Connection Setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect((err) => {
    if (err) {
        console.error('Database connection error:', err.stack);
    } else {
        console.log('Successfully connected to the PostgreSQL database.');
    }
});

// BASE HEALTH & FALLBACK ROUTES (Fixes "Cannot GET /api/admin")
app.get('/api/admin', (req, res) => {
    res.json({ success: true, message: "Bharat Career Connect Admin API Service is Live!" });
});

app.get('/api/employer', (req, res) => {
    res.json({ success: true, message: "Bharat Career Connect Employer API Service is Live!" });
});

app.get('/api/candidate', (req, res) => {
    res.json({ success: true, message: "Bharat Career Connect Candidate API Service is Live!" });
});

// Helper for Activity Logging
const logAdminActivity = async (actionType, description) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_activity_logs (
                id SERIAL PRIMARY KEY,
                action_type VARCHAR(100) NOT NULL,
                description TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await pool.query(
            "INSERT INTO admin_activity_logs (action_type, description) VALUES ($1, $2)",
            [actionType, description]
        );
    } catch (e) {
        console.error("Admin Log Error:", e);
    }
};

// =====================================================================
// AUTHENTICATION & LOGIN APIS
// =====================================================================

app.post('/api/auth/login', async (req, res) => {
    const { role, email, password } = req.body;

    try {
        if (role === 'admin') {
            if (email === 'karthiktej2004@gmail.com' && password === 'Karthiktej@1985') {
                return res.json({ 
                    success: true, 
                    data: { id: 'BCC-ADMIN-001', name: 'Karthik Teja', email: email, role: 'admin' } 
                });
            }
            return res.status(401).json({ success: false, message: 'Invalid Admin Credentials.' });
        }

        if (role === 'employer') {
            const empResult = await pool.query("SELECT * FROM employers WHERE email = $1", [email]);
            if (empResult.rows.length === 0) return res.status(401).json({ success: false, message: 'Employer account not found.' });

            const employer = empResult.rows[0];
            const currentStatus = (employer.status || 'pending').toLowerCase().trim();

            if (currentStatus === 'pending') {
                return res.status(403).json({ success: false, message: 'Company registration is pending admin approval.' });
            }
            if (currentStatus === 'rejected' || currentStatus === 'blacklisted') {
                return res.status(403).json({ success: false, message: 'Employer account restricted or rejected.' });
            }

            let isMatch = employer.password.startsWith('$2') ? await bcrypt.compare(password, employer.password) : (password === employer.password);
            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Password.' });

            return res.json({ success: true, data: { id: employer.id, name: employer.company_name, email: employer.email, role: 'employer' } });
        }

        if (role === 'candidate') {
            const candResult = await pool.query("SELECT * FROM candidates WHERE email = $1 OR unique_id = $1", [email]);
            if (candResult.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Candidate account not found.' });
            }

            const candidate = candResult.rows[0];
            if (candidate.account_status === 'Blocked') {
                return res.status(403).json({ success: false, message: 'Candidate account is blocked.' });
            }

            if (candidate.password !== password) {
                return res.status(401).json({ success: false, message: 'Invalid Password.' });
            }

            return res.json({ success: true, data: { id: candidate.unique_id, name: candidate.full_name, email: candidate.email, role: 'candidate' } });
        }

        res.status(400).json({ success: false, message: 'Invalid role selected.' });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

// =====================================================================
// ADMIN CANDIDATES API
// =====================================================================

app.get('/api/admin/candidates', async (req, res) => {
    try {
        await pool.query(`
            ALTER TABLE candidates 
            ADD COLUMN IF NOT EXISTS account_status VARCHAR(50) DEFAULT 'Verified';
        `);

        const query = `
            SELECT 
                c.unique_id AS id,
                COALESCE(c.full_name, 'Candidate') AS name,
                COALESCE(c.highest_qualification, 'N/A') AS qual,
                COALESCE(c.district, 'N/A') AS district,
                COALESCE(c.account_status, 'Verified') AS status,
                EXISTS (
                    SELECT 1 FROM event_candidate_registrations ecr 
                    WHERE ecr.candidate_id::text = c.unique_id 
                    AND LOWER(ecr.attendance_status) = 'present'
                ) AS attended
            FROM candidates c
            ORDER BY c.created_at DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Fetch Admin Candidates Error:", error);
        res.status(500).json({ success: false, message: "Server error fetching candidates." });
    }
});

app.post('/api/admin/candidates/manual-register', async (req, res) => {
    const { fullName, email, phone, qualification, district, state, experienceType } = req.body;
    try {
        const unique_id = 'BCC-CAN-' + Math.floor(100000 + Math.random() * 900000);
        const insertQuery = `
            INSERT INTO candidates (
                unique_id, full_name, email, phone, password, 
                highest_qualification, district, state, experience_type, 
                account_status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Verified', NOW()) RETURNING unique_id;
        `;
        const values = [
            unique_id, fullName, email || `${unique_id.toLowerCase()}@bcc-manual.in`, 
            phone || '0000000000', phone || 'BccPass@123', qualification || 'BE/B-Tech', 
            district || 'Bengaluru Urban', state || 'Karnataka', experienceType || 'Fresher'
        ];
        const result = await pool.query(insertQuery, values);
        await logAdminActivity('MANUAL_CANDIDATE_ENTRY', `Registered candidate ${fullName} (${result.rows[0].unique_id})`);
        res.status(201).json({ success: true, message: "Candidate registered manually and verified!", uniqueId: result.rows[0].unique_id });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to register candidate." }); }
});

app.put('/api/admin/candidates/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query("UPDATE candidates SET account_status = $1 WHERE unique_id = $2 OR id::text = $2 RETURNING *", [status, id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });
        await logAdminActivity('CANDIDATE_STATUS_CHANGE', `Updated status of candidate ${id} to ${status}`);
        res.json({ success: true, message: `Candidate account status updated to ${status}.` });
    } catch (error) { res.status(500).json({ success: false, message: "Error updating status." }); }
});

app.delete('/api/admin/candidates/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM candidate_activity_logs WHERE candidate_id::text = $1", [id]);
        await pool.query("DELETE FROM event_candidate_registrations WHERE candidate_id::text = $1", [id]);
        await pool.query("DELETE FROM job_applications WHERE candidate_id::text = $1", [id]);
        const result = await pool.query("DELETE FROM candidates WHERE unique_id = $1 OR id::text = $1 RETURNING *", [id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate account not found." });
        await logAdminActivity('PERMANENT_CANDIDATE_DELETE', `Permanently deleted candidate ${id}`);
        res.json({ success: true, message: "Candidate account permanently deleted." });
    } catch (error) { res.status(500).json({ success: false, message: "Error deleting candidate." }); }
});

// =====================================================================
// EVENTS & LIVE MONITORING APIS
// =====================================================================

app.get('/api/admin/live-events', async (req, res) => {
    try {
        const eventsResult = await pool.query("SELECT * FROM events WHERE is_live = TRUE OR status = 'live' ORDER BY created_at DESC");
        const liveEvents = eventsResult.rows;

        if (liveEvents.length === 0) return res.json({ success: true, data: [] });

        const dashboardData = await Promise.all(liveEvents.map(async (event) => {
            const regCount = await pool.query('SELECT COUNT(*) FROM event_candidate_registrations WHERE event_id = $1', [event.id]);
            const candidateAtt = await pool.query("SELECT COUNT(*) FROM event_attendance WHERE event_id = $1 AND user_type = 'candidate'", [event.id]);
            const employerAtt = await pool.query("SELECT COUNT(*) FROM event_attendance WHERE event_id = $1 AND user_type = 'employer'", [event.id]);
            const interviews = await pool.query("SELECT COUNT(*) FROM event_interviews WHERE event_id = $1 AND status = 'interviewed'", [event.id]);
            const offers = await pool.query("SELECT COUNT(*) FROM event_interviews WHERE event_id = $1 AND status = 'hired'", [event.id]);

            return {
                id: event.id,
                name: event.name,
                location: event.city || event.location || "Karnataka",
                registrations: parseInt(regCount.rows[0].count) || 0,
                attendance: { candidates: parseInt(candidateAtt.rows[0].count) || 0, employers: parseInt(employerAtt.rows[0].count) || 0 },
                interviews: parseInt(interviews.rows[0].count) || 0,
                offers: parseInt(offers.rows[0].count) || 0
            };
        }));

        res.status(200).json({ success: true, data: dashboardData });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error fetching live events.' }); }
});

app.put('/api/admin/events/:id/end', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE events SET is_live = FALSE, status = 'completed' WHERE id = $1", [id]);
        await logAdminActivity('END_EVENT', `Admin concluded live event ID: ${id}`);
        res.json({ success: true, message: "Event concluded successfully!" });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to end event." }); }
});

app.get('/api/admin/events/:id/download-data', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT c.unique_id, c.full_name, c.email, c.phone, c.highest_qualification, c.district, r.entry_pass_id, r.queue_token, r.attendance_status
            FROM event_candidate_registrations r
            JOIN candidates c ON r.candidate_id::text = c.unique_id OR r.candidate_id::text = c.id::text
            WHERE r.event_id = $1;
        `;
        const result = await pool.query(query, [id]);

        let csv = "Candidate ID,Full Name,Email,Phone,Qualification,District,Pass ID,Queue Token,Attendance\n";
        result.rows.forEach(row => {
            csv += `"${row.unique_id}","${row.full_name}","${row.email}","${row.phone}","${row.highest_qualification}","${row.district}","${row.entry_pass_id}","${row.queue_token}","${row.attendance_status}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="event_${id}_candidates.csv"`);
        res.status(200).send(csv);
    } catch (error) { res.status(500).json({ success: false, message: "Error generating report." }); }
});

app.get('/api/admin/history', async (req, res) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_activity_logs (
                id SERIAL PRIMARY KEY,
                action_type VARCHAR(100) NOT NULL,
                description TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        const result = await pool.query("SELECT * FROM admin_activity_logs ORDER BY created_at DESC LIMIT 100");
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false, message: "Error fetching history." }); }
});

app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
});
