const express = require('express');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); 

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// 1. MIDDLEWARE & BODY PARSER
// ==========================================
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==========================================
// 2. POSTGRESQL CONNECTION POOL
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) {
        console.error('Database connection error:', err.stack);
    } else {
        console.log('Successfully connected to the PostgreSQL database.');
    }
});

// ==========================================
// 3. MASTER AUTHENTICATION (LOGIN)
// ==========================================
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
            if (empResult.rows.length === 0) return res.status(401).json({ success: false, message: 'Employer not found.' });
            
            const employer = empResult.rows[0];
            const currentStatus = (employer.status || 'pending').toLowerCase().trim();

            if (currentStatus === 'pending') {
                return res.status(403).json({ success: false, message: 'Registration request pending admin approval.' });
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

            // Block Check
            if (candidate.account_status === 'Blocked') {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Your candidate account has been blocked by administrators.' 
                });
            }

            let isMatch = false;
            if (candidate.password && candidate.password.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, candidate.password);
            } else {
                isMatch = (password === candidate.password);
            }

            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Password.' });

            return res.json({ 
                success: true, 
                data: { id: candidate.unique_id, name: candidate.full_name, email: candidate.email, role: 'candidate' } 
            });
        }

        res.status(400).json({ success: false, message: 'Invalid role selected.' });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

// ==========================================
// 4. CANDIDATE REGISTRATION (PUBLIC & MANUAL)
// ==========================================
app.post('/api/auth/candidate/register', async (req, res) => {
    const data = req.body;
    try {
        if (!data.fullName || (!data.email && !data.phone)) {
            return res.status(400).json({ success: false, message: "Full Name and Email/Phone are required." });
        }

        const userExists = await pool.query(
            "SELECT id FROM candidates WHERE (email IS NOT NULL AND email = $1) OR (phone IS NOT NULL AND phone = $2)",
            [data.email || null, data.phone || null]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: "An account with this Email or Phone number already exists." });
        }

        const unique_id = 'BCC-CAN-' + Math.floor(100000 + Math.random() * 900000);

        const insertQuery = `
            INSERT INTO candidates (
                unique_id, full_name, email, phone, password, dob, gender, preferred_language, category,
                pincode, state, district, taluk, mla_constituency, mp_constituency, gram_panchayat,
                highest_qualification, year_of_passing, institution, school_name, course, specialization, percentage_cgpa, languages_fluent,
                skills, experience_type, years_of_experience, employment_status, current_job_role, current_company,
                resume_file_name, preferred_roles, preferred_locations, willing_to_relocate, preferred_job_type, expected_salary, account_status, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, 'Verified', NOW()
            ) RETURNING unique_id;
        `;

        const values = [
            unique_id, data.fullName, data.email || null, data.phone || null, data.password || "BccPass@123",
            data.dob ? new Date(data.dob) : null, data.gender || null, data.language || 'English', data.category || 'General Merit (GM)',
            data.pincode || null, data.state || null, data.district || null, data.taluk || null, data.mla || null, data.mp || null, data.gramPanchayat || null,
            data.qualification || null, data.yearOfPassing || null, data.institution || null, data.schoolName || null, data.course || null, data.specialization || null, data.percentage || null, JSON.stringify(data.languagesFluent || []),
            JSON.stringify(data.skills || []), data.experienceType || 'Fresher', data.yearsOfExperience || null, data.employmentStatus || null, data.currentRole || null, data.currentCompany || null,
            data.resumeFileName || null, JSON.stringify(data.preferredRoles || []), JSON.stringify(data.preferredLocations || []), data.willingToRelocate || false, data.preferredJobType || 'Full-time', data.expectedSalary || null
        ];

        const result = await pool.query(insertQuery, values);
        res.status(201).json({ success: true, message: "Candidate registered successfully", uniqueId: result.rows[0].unique_id });
    } catch (error) {
        console.error("Candidate Register Error:", error);
        res.status(500).json({ success: false, message: "Server error during registration." });
    }
});

// Admin Manual Candidate Registration
app.post('/api/admin/candidates/manual-register', async (req, res) => {
    const { fullName, email, phone, qualification, district, state, experienceType } = req.body;
    try {
        const unique_id = 'BCC-CAN-' + Math.floor(100000 + Math.random() * 900000);
        const insertQuery = `
            INSERT INTO candidates (
                unique_id, full_name, email, phone, password, 
                highest_qualification, district, state, experience_type, 
                account_status, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, 'Verified', NOW()
            ) RETURNING unique_id;
        `;
        const values = [
            unique_id, fullName, email || `${unique_id.toLowerCase()}@bcc-manual.in`, 
            phone || '0000000000', phone || 'BccPass@123', qualification || 'BE/B-Tech', 
            district || 'Bengaluru Urban', state || 'Karnataka', experienceType || 'Fresher'
        ];

        const result = await pool.query(insertQuery, values);
        await pool.query("INSERT INTO admin_activity_logs (action_type, description) VALUES ($1, $2)", ['MANUAL_CANDIDATE_ENTRY', `Registered candidate ${fullName} (${result.rows[0].unique_id})`]);

        res.status(201).json({ success: true, message: "Candidate registered manually!", uniqueId: result.rows[0].unique_id });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to register candidate manually." });
    }
});

// ==========================================
// 5. CANDIDATE MANAGEMENT (BLOCK & DELETE)
// ==========================================
app.get('/api/admin/candidates', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.unique_id AS id, c.full_name AS name, COALESCE(c.highest_qualification, 'N/A') AS qual,
                COALESCE(c.district, 'N/A') AS district, COALESCE(c.account_status, 'Verified') AS status,
                EXISTS (SELECT 1 FROM event_candidate_registrations ecr WHERE ecr.candidate_id::text = c.unique_id AND LOWER(ecr.attendance_status) = 'present') AS attended
            FROM candidates c ORDER BY c.created_at DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching candidates." });
    }
});

app.put('/api/admin/candidates/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query("UPDATE candidates SET account_status = $1 WHERE unique_id = $2 OR id::text = $2 RETURNING *", [status, id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });
        res.json({ success: true, message: `Candidate account status updated to ${status}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error updating status." });
    }
});

app.delete('/api/admin/candidates/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM candidate_activity_logs WHERE candidate_id::text = $1", [id]);
        await pool.query("DELETE FROM event_candidate_registrations WHERE candidate_id::text = $1", [id]);
        await pool.query("DELETE FROM job_applications WHERE candidate_id::text = $1", [id]);

        const result = await pool.query("DELETE FROM candidates WHERE unique_id = $1 OR id::text = $1 RETURNING *", [id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });

        res.json({ success: true, message: "Candidate permanently deleted." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error deleting candidate." });
    }
});

// ==========================================
// 6. EVENT MANAGEMENT & LIVE MONITORING
// ==========================================
app.get('/api/admin/events', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, event_date, event_type, city, employer_capacity, status, stall_price,
                   (SELECT COUNT(*) FROM employer_event_stalls WHERE event_id = events.id) as registered_count
            FROM events ORDER BY event_date DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/admin/events', async (req, res) => {
    const { name, date, type, city, venue, maps_link, capacity, price, desc } = req.body;
    try {
        const qrString = `GATE_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
        await pool.query(`
            INSERT INTO events (name, event_date, event_type, city, venue_address, google_maps_link, employer_capacity, stall_price, qr_code_string, status, is_live) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'upcoming', FALSE)
        `, [name, date, type, city, venue, maps_link, parseInt(capacity) || 100, parseFloat(price) || 0, qrString]);
        res.status(201).json({ success: true, message: 'Event created' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.put('/api/admin/events/:id/live', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'live', is_live = TRUE WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Event is now live!" });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.put('/api/admin/events/:id/hold', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'hold', is_live = FALSE WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: 'Event placed on hold' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.put('/api/admin/events/:id/end', async (req, res) => {
    try {
        await pool.query("UPDATE events SET is_live = FALSE, status = 'completed' WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Event concluded successfully!" });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/admin/events/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM event_interviews WHERE event_id = $1", [id]);
        await pool.query("DELETE FROM employer_event_stalls WHERE event_id = $1", [id]);
        await pool.query("DELETE FROM event_attendance WHERE event_id = $1", [id]);
        await pool.query("DELETE FROM event_candidate_registrations WHERE event_id = $1", [id]);
        await pool.query("DELETE FROM events WHERE id = $1", [id]);
        res.json({ success: true, message: 'Event deleted' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
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
    } catch (error) {
        res.status(500).json({ success: false, message: "Error generating CSV." });
    }
});

// ==========================================
// 7. ADMIN ACTIVITY HISTORY LOGS
// ==========================================
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
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});
