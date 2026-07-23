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
// AUTHENTICATION & REGISTRATION APIS
// =====================================================================

// MASTER LOGIN API (WITH STRICT APPROVAL & BLOCK CHECKS)
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
            
            if (empResult.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Employer account not found.' });
            }

            const employer = empResult.rows[0];
            const currentStatus = (employer.status || 'pending').toLowerCase().trim();

            if (currentStatus === 'pending') {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Your company registration is currently PENDING admin approval. You will be able to log in once approved.' 
                });
            }

            if (currentStatus === 'rejected' || currentStatus === 'blacklisted') {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Your company registration request has been rejected or restricted.' 
                });
            }

            if (!employer.password) {
                return res.status(401).json({ success: false, message: 'Password not set for this account.' });
            }

            let isMatch = false;
            if (employer.password.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, employer.password);
            } else {
                isMatch = (password === employer.password);
            }

            if (!isMatch) {
                return res.status(401).json({ success: false, message: 'Invalid Password.' });
            }

            return res.json({ 
                success: true, 
                data: { 
                    id: employer.id, 
                    name: employer.company_name, 
                    email: employer.email, 
                    role: 'employer' 
                } 
            });
        }

        if (role === 'candidate') {
            const candResult = await pool.query("SELECT * FROM candidates WHERE email = $1 OR unique_id = $1", [email]);
            if (candResult.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Candidate account not found.' });
            }

            const candidate = candResult.rows[0];

            if (candidate.account_status === 'Blocked') {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Your candidate account has been blocked by administrators.' 
                });
            }

            if (candidate.password !== password) {
                return res.status(401).json({ success: false, message: 'Invalid Password.' });
            }

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

app.post('/api/auth/employer/register', async (req, res) => {
    const { company_name, email_domain, gst_cin, industry, sector, company_size, website, hq_city, about_company, hr_name, hr_phone, email, password } = req.body;
    try {
        const userExists = await pool.query("SELECT * FROM employers WHERE email = $1", [email]);
        if (userExists.rows.length > 0) return res.status(400).json({ success: false, message: "Email already registered." });
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        await pool.query(`
            INSERT INTO employers (company_name, email_domain, gst_cin, industry, sector, company_size, website, hq_city, about_company, hr_name, hr_phone, email, password_hash, password, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending')
        `, [company_name, email_domain, gst_cin, industry, sector, company_size, website, hq_city, about_company, hr_name, hr_phone, email, password_hash, password]);
        res.status(201).json({ success: true, message: "Registration submitted successfully. Pending admin approval." });
    } catch (error) { res.status(500).json({ success: false, message: "Server error during registration." }); }
});

app.post('/api/auth/candidate/register', async (req, res) => {
    try {
        const data = req.body;
        const userExists = await pool.query("SELECT * FROM candidates WHERE email = $1 OR phone = $2", [data.email, data.phone]);
        if (userExists.rows.length > 0) return res.status(400).json({ success: false, message: "Email or Phone already registered." });
        const unique_id = 'BCC-CAN-' + Math.floor(100000 + Math.random() * 900000);
        const insertQuery = `
            INSERT INTO candidates (
                unique_id, full_name, email, phone, password, dob, gender, preferred_language, category,
                pincode, state, district, taluk, mla_constituency, mp_constituency, gram_panchayat,
                highest_qualification, year_of_passing, institution, school_name, course, specialization, percentage_cgpa, languages_fluent,
                skills, experience_type, years_of_experience, employment_status, current_job_role, current_company,
                resume_file_name, preferred_roles, preferred_locations, willing_to_relocate, preferred_job_type, expected_salary
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36
            ) RETURNING unique_id;
        `;
        const values = [
            unique_id, data.fullName, data.email, data.phone, data.password, data.dob || null, data.gender, data.language, data.category,
            data.pincode, data.state, data.district, data.taluk, data.mla, data.mp, data.gramPanchayat,
            data.qualification, data.yearOfPassing, data.institution, data.schoolName, data.course, data.specialization, data.percentage, JSON.stringify(data.languagesFluent || []),
            JSON.stringify(data.skills || []), data.experienceType, data.yearsOfExperience, data.employmentStatus, data.currentRole, data.currentCompany,
            data.resumeFileName, JSON.stringify(data.preferredRoles || []), JSON.stringify(data.preferredLocations || []), data.willingToRelocate || false, data.preferredJobType, data.expectedSalary
        ];
        const result = await pool.query(insertQuery, values);
        res.status(201).json({ success: true, message: "Candidate registered successfully", uniqueId: result.rows[0].unique_id });
    } catch (error) { res.status(500).json({ success: false, message: "Server error during registration." }); }
});

// =====================================================================
// ADMIN LIVE MONITORING & EVENT MANAGEMENT
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
                attendance: { 
                    candidates: parseInt(candidateAtt.rows[0].count) || 0, 
                    employers: parseInt(employerAtt.rows[0].count) || 0 
                },
                interviews: parseInt(interviews.rows[0].count) || 0,
                offers: parseInt(offers.rows[0].count) || 0
            };
        }));

        res.status(200).json({ success: true, data: dashboardData });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error fetching live events.' });
    }
});

app.put('/api/admin/events/:id/end', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE events SET is_live = FALSE, status = 'completed' WHERE id = $1", [id]);
        await logAdminActivity('END_EVENT', `Admin concluded live event ID: ${id}`);
        res.json({ success: true, message: "Event concluded successfully!" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to end event." });
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
        res.status(500).json({ success: false, message: "Server error generating CSV report." });
    }
});

app.get('/api/admin/events', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, event_date, event_type, city, employer_capacity, status, stall_price,
            (SELECT COUNT(*) FROM employer_event_stalls WHERE event_id = events.id) as registered_count
            FROM events ORDER BY event_date DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
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
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/events/:id/hold', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'hold', is_live = FALSE WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: 'Event status updated' });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/events/:id/live', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'live', is_live = TRUE WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Event is now live!" });
    } catch (error) { res.status(500).json({ success: false }); }
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
    } catch (error) { res.status(500).json({ success: false }); }
});

// =====================================================================
// VENUE BUILDER & STALL ALLOCATION
// =====================================================================

app.get('/api/admin/events/:eventId/venue', async (req, res) => {
    const { eventId } = req.params;
    try {
        const blocks = await pool.query("SELECT * FROM venue_blocks WHERE event_id = $1 ORDER BY id ASC", [eventId]);
        const rooms = await pool.query("SELECT * FROM venue_rooms WHERE block_id IN (SELECT id FROM venue_blocks WHERE event_id = $1)", [eventId]);
        const stalls = await pool.query(`
            SELECT s.*, e.company_name as allocated_name 
            FROM venue_stalls s LEFT JOIN employers e ON s.employer_id = e.id 
            WHERE s.event_id = $1 ORDER BY s.code ASC
        `, [eventId]);

        const venueStructure = blocks.rows.map(block => {
            const blockRooms = rooms.rows.filter(r => r.block_id === block.id).map(room => ({
                id: room.id.toString(), name: room.name, code: room.code,
                stalls: stalls.rows.filter(s => s.room_id === room.id).map(s => ({
                    id: s.id.toString(), code: s.code, allocatedToAppId: s.employer_id ? s.employer_id.toString() : null, allocatedName: s.allocated_name
                }))
            }));
            const blockStalls = stalls.rows.filter(s => s.block_id === block.id && s.room_id === null).map(s => ({
                id: s.id.toString(), code: s.code, allocatedToAppId: s.employer_id ? s.employer_id.toString() : null, allocatedName: s.allocated_name
            }));
            return { id: block.id.toString(), kind: block.type, name: block.name, code: block.code, sections: blockRooms, stalls: blockStalls };
        });
        res.json({ success: true, data: venueStructure });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/events/:eventId/blocks', async (req, res) => {
    try {
        await pool.query("INSERT INTO venue_blocks (event_id, type, name, code) VALUES ($1, $2, $3, $4)", [req.params.eventId, req.body.kind, req.body.name, req.body.code]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/admin/blocks/:blockId', async (req, res) => {
    try {
        await pool.query("DELETE FROM venue_blocks WHERE id = $1", [req.params.blockId]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/blocks/:blockId/rooms', async (req, res) => {
    try {
        await pool.query("INSERT INTO venue_rooms (block_id, name, code) VALUES ($1, $2, $3)", [req.params.blockId, req.body.name, req.body.code]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/events/:eventId/stalls', async (req, res) => {
    const { blockId, roomId, count, prefix } = req.body;
    try {
        for (let i = 1; i <= count; i++) {
            const code = `${prefix}-${i.toString().padStart(2, '0')}`;
            await pool.query("INSERT INTO venue_stalls (event_id, block_id, room_id, name, code) VALUES ($1, $2, $3, $4, $5)", [req.params.eventId, blockId, roomId || null, `${prefix} ${i}`, code]);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/admin/stalls/:stallId', async (req, res) => {
    try {
        await pool.query("DELETE FROM venue_stalls WHERE id = $1", [req.params.stallId]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/stalls/:stallId/allocate', async (req, res) => {
    try {
        await pool.query("UPDATE venue_stalls SET employer_id = $1 WHERE id = $2", [req.body.employerId, req.params.stallId]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// =====================================================================
// ADMIN CANDIDATE MANAGEMENT & MANUAL REGISTRATION
// =====================================================================

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
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/candidates', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.unique_id AS id,
                c.full_name AS name,
                COALESCE(c.highest_qualification, 'N/A') AS qual,
                COALESCE(c.district, 'N/A') AS district,
                COALESCE(c.account_status, 'Verified') AS status,
                EXISTS (
                    SELECT 1 FROM event_candidate_registrations ecr 
                    WHERE ecr.candidate_id::text = c.unique_id AND LOWER(ecr.attendance_status) = 'present'
                ) AS attended
            FROM candidates c ORDER BY c.created_at DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/candidates/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query("UPDATE candidates SET account_status = $1 WHERE unique_id = $2 OR id::text = $2 RETURNING *", [status, id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });
        await logAdminActivity('CANDIDATE_STATUS_CHANGE', `Updated status of candidate ${id} to ${status}`);
        res.json({ success: true, message: `Candidate account status updated to ${status}.` });
    } catch (error) { res.status(500).json({ success: false }); }
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
    } catch (error) { res.status(500).json({ success: false }); }
});

// =====================================================================
// ADMIN EMPLOYER, JOB & COMPANY REQUEST APPROVALS
// =====================================================================

app.get('/api/admin/employers', async (req, res) => {
    try {
        const query = `
            SELECT e.id, e.company_name AS name, COALESCE(e.gst_cin, 'Pending') AS gst_status, e.status,
                   COALESCE(AVG(ef.overall_rating), 4.0)::numeric(2,1) AS rating,
                   (SELECT COUNT(*) FROM jobs j WHERE j.employer_id = e.id AND j.status = 'approved') AS jobs
            FROM employers e LEFT JOIN employer_feedback ef ON e.id = ef.employer_id GROUP BY e.id ORDER BY e.created_at DESC;
        `;
        const result = await pool.query(query);
        const formattedData = result.rows.map(e => ({
            id: `EMP-${String(e.id).padStart(3, '0')}`,
            dbId: e.id,
            name: e.name,
            gst: e.gst_status !== 'Pending' ? 'Verified' : 'Pending',
            jobs: parseInt(e.jobs) || 0,
            rating: parseFloat(e.rating),
            status: e.status === 'approved' ? 'Active' : e.status === 'blacklisted' ? 'Blacklisted' : 'Pending'
        }));
        res.json({ success: true, data: formattedData });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/employers/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query("UPDATE employers SET status = $1 WHERE id = $2 RETURNING *", [status, id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });
        res.json({ success: true, message: `Employer status updated to ${status}.` });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/jobs', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, title, company_name AS company, job_type AS type, location, status AS \"approvalStatus\", created_at AS \"postedAt\" FROM jobs ORDER BY created_at DESC");
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/jobs/:jobId/review', async (req, res) => {
    const { jobId } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query("UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *", [status, jobId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });
        res.json({ success: true, message: `Job ${status}.` });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/company-requests', async (req, res) => {
    try {
        const query = `
            SELECT id, company_name AS name, email_domain AS domain, COALESCE(gst_cin, 'N/A') AS gst, hr_name AS "hrName",
                   email AS "hrEmail", hr_phone AS "hrPhone", industry, company_size AS size, website, hq_city AS city,
                   about_company AS about, status, created_at AS "createdAt"
            FROM employers ORDER BY created_at DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/company-requests/:id/review', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query("UPDATE employers SET status = $1 WHERE id = $2 RETURNING *", [status, id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });
        res.json({ success: true, message: `Company request ${status}.` });
    } catch (error) { res.status(500).json({ success: false }); }
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
    } catch (error) { res.status(500).json({ success: false }); }
});

// =====================================================================
// EMPLOYER PORTAL APIS
// =====================================================================

app.get('/api/employer/:employerId/dashboard', async (req, res) => {
    const { employerId } = req.params;
    try {
        const activeJobs = await pool.query("SELECT COUNT(*) FROM jobs WHERE employer_id = $1 AND status = 'approved'", [employerId]);
        const totalApps = await pool.query("SELECT COUNT(*) FROM job_applications WHERE employer_id = $1", [employerId]);
        const interviews = await pool.query("SELECT COUNT(*) FROM job_applications WHERE employer_id = $1 AND status IN ('Interview', 'Interviewed')", [employerId]);
        const offers = await pool.query("SELECT COUNT(*) FROM job_applications WHERE employer_id = $1 AND status IN ('Offered', 'Hired')", [employerId]);

        const funnelRes = await pool.query("SELECT status, COUNT(*) as count FROM job_applications WHERE employer_id = $1 GROUP BY status", [employerId]);
        const funnel = { Applied: 0, Shortlisted: 0, Interview: 0, Offer: 0, Hired: 0 };
        funnelRes.rows.forEach(row => {
            if (row.status === 'Applied') funnel.Applied = parseInt(row.count);
            if (row.status === 'Shortlisted') funnel.Shortlisted = parseInt(row.count);
            if (row.status === 'Interview' || row.status === 'Interviewed') funnel.Interview += parseInt(row.count);
            if (row.status === 'Offered' || row.status === 'Offer') funnel.Offer += parseInt(row.count);
            if (row.status === 'Hired') funnel.Hired += parseInt(row.count);
        });

        const recentApps = await pool.query(`
            SELECT ja.id as application_id, ja.status, ja.applied_at, COALESCE(c.full_name, 'Candidate') as candidate_name, ja.candidate_id, j.title as job_title, FLOOR(RANDOM() * (98 - 75 + 1) + 75) as match_score
            FROM job_applications ja LEFT JOIN candidates c ON ja.candidate_id = c.unique_id JOIN jobs j ON ja.job_id = j.id
            WHERE ja.employer_id = $1 ORDER BY ja.applied_at DESC LIMIT 5
        `, [employerId]);

        res.json({ success: true, data: {
            kpis: { activeJobs: parseInt(activeJobs.rows[0].count), applications: parseInt(totalApps.rows[0].count), interviews: parseInt(interviews.rows[0].count), offersMade: parseInt(offers.rows[0].count) },
            funnelData: funnel, recentApplicants: recentApps.rows, chartData: [{ day: 'Mon', applications: 2 }, { day: 'Tue', applications: 5 }, { day: 'Wed', applications: 3 }]
        }});
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/employer/:employerId/candidates-reviewed-count', async (req, res) => {
    try {
        const { employerId } = req.params;
        const result = await pool.query("SELECT COUNT(*) FROM job_applications ja JOIN employers e ON ja.employer_id = e.id WHERE e.id::text = $1 OR LOWER(e.email) = LOWER($1)", [employerId]);
        res.json({ success: true, count: parseInt(result.rows[0].count) || 0 });
    } catch (error) { res.status(500).json({ success: false, count: 0 }); }
});

app.get('/api/employer/profile/:employerId', async (req, res) => {
    const { employerId } = req.params;
    try {
        const query = `
            SELECT e.id AS employer_id, e.company_name, e.email AS work_email, e.hr_name, e.hr_phone AS mobile, e.industry, e.hq_city, e.about_company,
                   rp.full_name, rp.designation, rp.department, rp.preferred_language, rp.about_you, rp.profile_photo_url
            FROM employers e LEFT JOIN recruiter_profiles rp ON e.id = rp.employer_id WHERE e.id::text = $1 OR LOWER(e.email) = LOWER($1);
        `;
        const result = await pool.query(query, [employerId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });
        const row = result.rows[0];
        res.json({ success: true, data: {
            employerId: row.employer_id, companyName: row.company_name, fullName: row.full_name || row.hr_name || "Recruiter",
            designation: row.designation || "Talent Acquisition Manager", email: row.work_email, mobile: row.mobile || "+91 00000 00000",
            department: row.department || "tech", language: row.preferred_language || "en", about: row.about_you || row.about_company || "", photoUrl: row.profile_photo_url || ""
        }});
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/employer/profile/update', async (req, res) => {
    const { employerId, fullName, designation, mobile, department, language, about, photoUrl } = req.body;
    try {
        await pool.query(`
            INSERT INTO recruiter_profiles (employer_id, full_name, designation, mobile, department, preferred_language, about_you, profile_photo_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (employer_id) DO UPDATE SET full_name = EXCLUDED.full_name, designation = EXCLUDED.designation, mobile = EXCLUDED.mobile, department = EXCLUDED.department, preferred_language = EXCLUDED.preferred_language, about_you = EXCLUDED.about_you, profile_photo_url = EXCLUDED.profile_photo_url
        `, [employerId, fullName, designation, mobile, department, language, about, photoUrl]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/employer/:employerId/jobs-list', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, title, job_type, location, experience_required, salary_range, vacancies, created_at, status FROM jobs WHERE employer_id::text = $1 ORDER BY created_at DESC", [req.params.employerId]);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/employer/jobs', async (req, res) => {
    const { employerId, title, jobType, location, experience, salary, vacancies, qualification, skills } = req.body;
    try {
        const empCheck = await pool.query("SELECT company_name FROM employers WHERE id::text = $1", [employerId]);
        const companyName = empCheck.rows.length > 0 ? empCheck.rows[0].company_name : "Partner Company";
        await pool.query("INSERT INTO jobs (employer_id, company_name, title, job_type, location, experience_required, salary_range, vacancies, qualification_required, skills_required, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')", [employerId, companyName, title, jobType, location, experience, salary, parseInt(vacancies) || 1, qualification, JSON.stringify(skills || [])]);
        res.status(201).json({ success: true, message: "Job posted successfully." });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/employer/jobs/:jobId', async (req, res) => {
    const { title, jobType, location, experience, salary, vacancies, qualification, skills } = req.body;
    try {
        await pool.query("UPDATE jobs SET title = $1, job_type = $2, location = $3, experience_required = $4, salary_range = $5, vacancies = $6, qualification_required = $7, skills_required = $8, status = 'pending' WHERE id = $9", [title, jobType, location, experience, salary, parseInt(vacancies) || 1, qualification, JSON.stringify(skills || []), req.params.jobId]);
        res.json({ success: true, message: "Job updated." });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/employer/jobs/:jobId', async (req, res) => {
    try {
        await pool.query("DELETE FROM job_applications WHERE job_id = $1", [req.params.jobId]);
        await pool.query("DELETE FROM jobs WHERE id = $1", [req.params.jobId]);
        res.json({ success: true, message: "Job deleted." });
    } catch (error) { res.status(500).json({ success: false }); }
});

// =====================================================================
// CANDIDATE PORTAL APIS
// =====================================================================

app.get('/api/candidate/profile/:id', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM candidates WHERE unique_id = $1 OR id::text = $1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });
        const dbUser = result.rows[0];
        res.json({ success: true, data: {
            uniqueId: dbUser.unique_id, fullName: dbUser.full_name, email: dbUser.email, phone: dbUser.phone,
            state: dbUser.state, district: dbUser.district, qualification: dbUser.highest_qualification,
            skills: dbUser.skills || [], resumeFileName: dbUser.resume_file_name
        }});
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/candidate/:id/jobs', async (req, res) => {
    const candidateId = req.params.id;
    try {
        let candidate = null;
        if (candidateId && candidateId !== "guest") {
            const candRes = await pool.query("SELECT * FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateId]);
            if (candRes.rows.length > 0) candidate = candRes.rows[0];
        }

        let jobsRes = await pool.query("SELECT * FROM jobs WHERE LOWER(status) = 'approved' ORDER BY created_at DESC");
        if (jobsRes.rows.length === 0) {
            jobsRes = await pool.query("SELECT * FROM jobs WHERE status IS NULL OR LOWER(status) != 'rejected' ORDER BY created_at DESC");
        }

        const candidateSkills = candidate ? (typeof candidate.skills === 'string' ? JSON.parse(candidate.skills || '[]') : (candidate.skills || [])) : [];

        const matchedJobs = jobsRes.rows.map(job => {
            let score = 50;
            let jobSkills = [];
            try { jobSkills = typeof job.skills_required === 'string' ? JSON.parse(job.skills_required || '[]') : (job.skills_required || []); } catch (e) {}

            if (candidate && jobSkills.length > 0) {
                const matched = jobSkills.filter(js => candidateSkills.some(cs => cs.toLowerCase() === js.toLowerCase()));
                score += (matched.length / jobSkills.length) * 30;
            }

            return {
                id: job.id, employer_id: job.employer_id, company: job.company_name || "Partner Company",
                title: job.title || "Job Opening", type: job.job_type || "Full-time", location: job.location || "Karnataka",
                qualification: job.qualification_required || "Any Degree", experience: job.experience_required || "Fresher",
                salary: job.salary_range || "Not specified", skills: jobSkills, matchScore: Math.min(98, Math.max(65, Math.round(score)))
            };
        }).sort((a, b) => b.matchScore - a.matchScore);

        res.json({ success: true, data: matchedJobs });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/applications/apply', async (req, res) => {
    const { jobId, candidateId, employerId } = req.body;
    try {
        const checkDuplicate = await pool.query("SELECT * FROM job_applications WHERE job_id = $1 AND candidate_id = $2", [jobId, candidateId]);
        if (checkDuplicate.rows.length > 0) return res.status(400).json({ success: false, message: "You have already applied." });
        await pool.query("INSERT INTO job_applications (job_id, candidate_id, employer_id, status) VALUES ($1, $2, $3, 'Applied')", [jobId, candidateId, employerId]);
        res.status(200).json({ success: true, message: "Application submitted successfully!" });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
});
