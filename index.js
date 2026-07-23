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

// =====================================================================
// SPRINT 1: LIVE EVENT MONITORING & END EVENT / DOWNLOAD DATA
// =====================================================================

app.get('/api/admin/live-events', async (req, res) => {
    try {
        const eventsResult = await pool.query("SELECT * FROM events WHERE is_live = TRUE OR status = 'live' ORDER BY created_at DESC");
        const liveEvents = eventsResult.rows;

        if (liveEvents.length === 0) {
            return res.json({ success: true, data: [] });
        }

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
        console.error('Live Monitoring API Error:', error);
        res.status(500).json({ success: false, message: 'Server error fetching live events.' });
    }
});

// END EVENT API
app.put('/api/admin/events/:id/end', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query(
            "UPDATE events SET is_live = FALSE, status = 'completed' WHERE id = $1", 
            [id]
        );
        
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
            ['END_EVENT', `Admin concluded live event ID: ${id}`]
        );

        res.json({ success: true, message: "Event concluded successfully!" });
    } catch (error) {
        console.error("End Event Error:", error);
        res.status(500).json({ success: false, message: "Failed to end event." });
    }
});

// DOWNLOAD LIVE EVENT DATA (CSV FORMAT)
app.get('/api/admin/events/:id/download-data', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT 
                c.unique_id,
                c.full_name,
                c.email,
                c.phone,
                c.highest_qualification,
                c.district,
                r.entry_pass_id,
                r.queue_token,
                r.attendance_status
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
        console.error("Download Event Data Error:", error);
        res.status(500).json({ success: false, message: "Server error generating CSV report." });
    }
});

// =====================================================================
// SPRINT 2: EVENT MANAGEMENT CRUD API
// =====================================================================

app.get('/api/admin/events', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id, name, event_date, event_type, city, 
                employer_capacity, status, stall_price,
                (SELECT COUNT(*) FROM employer_event_stalls WHERE event_id = events.id) as registered_count
            FROM events 
            ORDER BY event_date DESC
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

app.put('/api/admin/events/:id/hold', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'hold', is_live = FALSE WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: 'Event status updated' });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/admin/events/:id/live', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'live', is_live = TRUE WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Event is now live!" });
    } catch (error) { 
        res.status(500).json({ success: false, message: "Failed to update status." }); 
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
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// =====================================================================
// SPRINT 3: VENUE BUILDER & ALLOCATION API
// =====================================================================

app.get('/api/admin/events/:eventId/venue', async (req, res) => {
    const { eventId } = req.params;
    try {
        const blocks = await pool.query("SELECT * FROM venue_blocks WHERE event_id = $1 ORDER BY id ASC", [eventId]);
        const rooms = await pool.query("SELECT * FROM venue_rooms WHERE block_id IN (SELECT id FROM venue_blocks WHERE event_id = $1)", [eventId]);
        const stalls = await pool.query(`
            SELECT s.*, e.company_name as allocated_name 
            FROM venue_stalls s 
            LEFT JOIN employers e ON s.employer_id = e.id 
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
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
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
            await pool.query(
                "INSERT INTO venue_stalls (event_id, block_id, room_id, name, code) VALUES ($1, $2, $3, $4, $5)", 
                [req.params.eventId, blockId, roomId || null, `${prefix} ${i}`, code]
            );
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
// SPRINT 4: MASTER LOGIN API (WITH APPROVAL CHECK & CANDIDATE BLOCK CHECK)
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
            
            if (empResult.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Employer account not found.' });
            }

            const employer = empResult.rows[0];
            const currentStatus = (employer.status || 'pending').toLowerCase().trim();

            if (currentStatus === 'pending') {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Your company registration is currently PENDING admin approval. You will be able to log in once an admin reviews and approves your request.' 
                });
            }

            if (currentStatus === 'rejected' || currentStatus === 'blacklisted') {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Your company registration request has been rejected or restricted by the platform administrator.' 
                });
            }

            if (!employer.password) {
                return res.status(401).json({ success: false, message: 'Password not set.' });
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
                    message: 'Your candidate account has been blocked by administrators due to compliance or platform policy issues.' 
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

// =====================================================================
// SPRINT 5: CANDIDATE MANAGEMENT & MANUAL ON-THE-SPOT REGISTRATION
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
            ['MANUAL_CANDIDATE_ENTRY', `Registered candidate ${fullName} (${result.rows[0].unique_id})`]
        );

        res.status(201).json({ 
            success: true, 
            message: "Candidate registered manually and verified!", 
            uniqueId: result.rows[0].unique_id 
        });

    } catch (error) {
        console.error("Manual Candidate Entry Error:", error);
        res.status(500).json({ success: false, message: "Failed to register candidate manually." });
    }
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

// UPDATE CANDIDATE STATUS (BLOCK / UNBLOCK)
app.put('/api/admin/candidates/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const result = await pool.query(
            "UPDATE candidates SET account_status = $1 WHERE unique_id = $2 OR id::text = $2 RETURNING *",
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Candidate not found." });
        }

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
            ['CANDIDATE_STATUS_CHANGE', `Updated status of candidate ${id} to ${status}`]
        );

        res.json({ success: true, message: `Candidate account status updated to ${status}.` });
    } catch (error) {
        console.error("Update Candidate Status Error:", error);
        res.status(500).json({ success: false, message: "Server error updating candidate status." });
    }
});

// PERMANENTLY DELETE CANDIDATE
app.delete('/api/admin/candidates/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query("DELETE FROM candidate_activity_logs WHERE candidate_id::text = $1", [id]);
        await pool.query("DELETE FROM event_candidate_registrations WHERE candidate_id::text = $1", [id]);
        await pool.query("DELETE FROM job_applications WHERE candidate_id::text = $1", [id]);

        const result = await pool.query(
            "DELETE FROM candidates WHERE unique_id = $1 OR id::text = $1 RETURNING *",
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Candidate account not found." });
        }

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
            ['PERMANENT_CANDIDATE_DELETE', `Permanently deleted candidate ${id}`]
        );

        res.json({ success: true, message: "Candidate account permanently deleted." });

    } catch (error) {
        console.error("Delete Candidate Error:", error);
        res.status(500).json({ success: false, message: "Server error deleting candidate." });
    }
});

// =====================================================================
// SPRINT 6: ADMIN ACTIVITY HISTORY APIS
// =====================================================================

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
        console.error("Fetch Admin History Error:", error);
        res.status(500).json({ success: false, message: "Server error fetching activity history." });
    }
});

// =====================================================================
// SPRINT 7: EMPLOYER PROFILE, METRICS & CANDIDATE MATCH ENGINE
// =====================================================================

app.get('/api/employer/:employerId/candidates-reviewed-count', async (req, res) => {
    try {
        const { employerId } = req.params;
        const result = await pool.query(`
            SELECT COUNT(*) 
            FROM job_applications ja
            JOIN employers e ON ja.employer_id = e.id
            WHERE e.id::text = $1 OR LOWER(e.email) = LOWER($1)
        `, [employerId]);

        const count = parseInt(result.rows[0].count) || 0;
        res.json({ success: true, count });
    } catch (error) {
        console.error("Fetch Candidates Count Error:", error);
        res.status(500).json({ success: false, count: 0 });
    }
});

app.get('/api/employer/profile/:employerId', async (req, res) => {
    const { employerId } = req.params;
    try {
        const query = `
            SELECT 
                e.id AS employer_id,
                e.company_name,
                e.email AS work_email,
                e.hr_name,
                e.hr_phone AS mobile,
                e.industry,
                e.hq_city,
                e.about_company,
                rp.full_name,
                rp.designation,
                rp.department,
                rp.preferred_language,
                rp.about_you,
                rp.profile_photo_url
            FROM employers e
            LEFT JOIN recruiter_profiles rp ON e.id = rp.employer_id
            WHERE e.id::text = $1 OR LOWER(e.email) = LOWER($1);
        `;
        const result = await pool.query(query, [employerId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employer account not found" });
        }

        const row = result.rows[0];
        res.json({
            success: true,
            data: {
                employerId: row.employer_id,
                companyName: row.company_name,
                fullName: row.full_name || row.hr_name || "Recruiter",
                designation: row.designation || "Talent Acquisition Manager",
                email: row.work_email,
                mobile: row.mobile || "+91 00000 00000",
                department: row.department || "tech",
                language: row.preferred_language || "en",
                about: row.about_you || row.about_company || "Recruiter profile managed via Bharat Career Connect.",
                photoUrl: row.profile_photo_url || ""
            }
        });
    } catch (error) {
        console.error("Error fetching employer profile:", error);
        res.status(500).json({ success: false, message: "Server error fetching profile" });
    }
});

app.get('/api/candidate/:id/jobs', async (req, res) => {
    const candidateId = req.params.id;

    try {
        let candidate = null;
        if (candidateId && candidateId !== "guest") {
            const candRes = await pool.query(
                "SELECT * FROM candidates WHERE unique_id = $1 OR id::text = $1", 
                [candidateId]
            );
            if (candRes.rows.length > 0) {
                candidate = candRes.rows[0];
            }
        }

        let jobsRes = await pool.query("SELECT * FROM jobs WHERE LOWER(status) = 'approved' ORDER BY created_at DESC");

        if (jobsRes.rows.length === 0) {
            jobsRes = await pool.query("SELECT * FROM jobs WHERE status IS NULL OR LOWER(status) != 'rejected' ORDER BY created_at DESC");
        }

        const candidateSkills = candidate ? (typeof candidate.skills === 'string' ? JSON.parse(candidate.skills || '[]') : (candidate.skills || [])) : [];
        const candidateDistrict = candidate ? (candidate.district || "") : "";
        const preferredLocations = candidate ? (typeof candidate.preferred_locations === 'string' ? JSON.parse(candidate.preferred_locations || '[]') : (candidate.preferred_locations || [])) : [];

        const matchedJobs = jobsRes.rows.map(job => {
            let score = 50;
            let jobSkills = [];

            try {
                jobSkills = typeof job.skills_required === 'string' ? JSON.parse(job.skills_required || '[]') : (job.skills_required || []);
            } catch (e) {
                jobSkills = [];
            }

            if (candidate && jobSkills.length > 0) {
                const matched = jobSkills.filter(js => candidateSkills.some(cs => cs.toLowerCase() === js.toLowerCase()));
                score += (matched.length / jobSkills.length) * 30;
            }

            if (candidate && ((job.location || "").toLowerCase() === candidateDistrict.toLowerCase() || preferredLocations.some(l => l.toLowerCase() === (job.location || "").toLowerCase()))) {
                score += 20;
            }

            return {
                id: job.id,
                employer_id: job.employer_id,
                company: job.company_name || "Partner Company",
                title: job.title || "Job Opening",
                type: job.job_type || "Full-time",
                location: job.location || "Karnataka",
                qualification: job.qualification_required || "Any Degree",
                experience: job.experience_required || "Fresher",
                salary: job.salary_range || "Not specified",
                skills: jobSkills,
                matchScore: Math.min(98, Math.max(65, Math.round(score)))
            };
        }).sort((a, b) => b.matchScore - a.matchScore);

        res.json({ success: true, data: matchedJobs });

    } catch (error) {
        console.error("Candidate Jobs Engine Error:", error);
        res.status(500).json({ success: false, message: "Server error calculating job matches." });
    }
});

// =====================================================================
// SPRINT 8: ADMIN JOB & COMPANY APPROVAL APIS
// =====================================================================

app.get('/api/admin/jobs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id,
                title,
                company_name AS company,
                job_type AS type,
                location,
                status AS "approvalStatus",
                created_at AS "postedAt"
            FROM jobs
            ORDER BY created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Admin Fetch Jobs Error:", error);
        res.status(500).json({ success: false, message: "Server error fetching jobs for admin." });
    }
});

app.put('/api/admin/jobs/:jobId/review', async (req, res) => {
    const { jobId } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ success: false, message: "Invalid status provided." });
    }

    try {
        const result = await pool.query(
            "UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *",
            [status, jobId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Job listing not found." });
        }

        res.json({ 
            success: true, 
            message: `Job has been successfully ${status}.`,
            data: result.rows[0] 
        });
    } catch (error) {
        console.error("Admin Job Review Error:", error);
        res.status(500).json({ success: false, message: "Server error reviewing job." });
    }
});

app.get('/api/admin/company-requests', async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                company_name AS name,
                email_domain AS domain,
                COALESCE(gst_cin, 'N/A') AS gst,
                hr_name AS "hrName",
                email AS "hrEmail",
                hr_phone AS "hrPhone",
                industry,
                company_size AS size,
                website,
                hq_city AS city,
                about_company AS about,
                status,
                created_at AS "createdAt"
            FROM employers
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Fetch Company Requests Error:", error);
        res.status(500).json({ success: false, message: "Server error fetching company requests." });
    }
});

app.put('/api/admin/company-requests/:id/review', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ success: false, message: "Invalid status provided." });
    }

    try {
        const result = await pool.query(
            "UPDATE employers SET status = $1 WHERE id = $2 RETURNING *",
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Company request not found." });
        }

        res.json({ 
            success: true, 
            message: `Company registration request ${status}.`,
            data: result.rows[0]
        });
    } catch (error) {
        console.error("Review Company Request Error:", error);
        res.status(500).json({ success: false, message: "Server error reviewing company request." });
    }
});

app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
});
