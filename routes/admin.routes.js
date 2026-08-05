const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const bcrypt = require('bcrypt');

// --- STALL ALLOCATION & CANDIDATE FEEDBACK ---
router.put('/stalls/:id/allocate', async (req, res) => {
    const stallId = parseInt(req.params.id, 10);
    const { eventId, employerId, stallCode } = req.body;
    try {
        await pool.query(
            `UPDATE venue_stalls SET employer_id = $1 WHERE id = $2 OR code = $3`,
            [employerId, stallId, stallCode]
        );
        await pool.query(
            `UPDATE employer_event_stalls SET status = 'approved' WHERE event_id = $1 AND employer_id = $2`,
            [eventId, employerId]
        );
        res.json({ success: true, message: "Stall allocated successfully!" });
    } catch (error) {
        console.error("❌ Stall Allocation Error:", error);
        res.status(500).json({ success: false, message: "Server error allocating stall." });
    }
});

router.get('/candidate-feedback', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT cf.id, c.full_name as candidate_name, cf.overall_rating, 
                   cf.registration_exp, cf.interview_quality, cf.event_management, 
                   cf.video_url, cf.created_at
            FROM candidate_feedback cf
            JOIN candidates c ON cf.candidate_id = c.id
            ORDER BY cf.created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching candidate feedback:", error);
        res.status(500).json({ success: false, message: "Server error fetching candidate feedback." });
    }
});

// --- ATTENDANCE & LIVE EVENTS ---
router.get('/attendance-history', async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id,
                a.checked_in_at as time,
                a.user_type as role,
                'Main Gate' as gate,
                'Checked In' as status,
                e.name as event_name,
                CASE 
                    WHEN a.user_type = 'candidate' THEN c.unique_id
                    WHEN a.user_type = 'employer' THEN CONCAT('EMP-', LPAD(emp.id::text, 3, '0'))
                END as user_id,
                CASE 
                    WHEN a.user_type = 'candidate' THEN c.full_name
                    WHEN a.user_type = 'employer' THEN emp.company_name
                END as name
            FROM event_attendance a
            JOIN events e ON a.event_id = e.id
            LEFT JOIN candidates c ON a.user_id = c.id AND a.user_type = 'candidate'
            LEFT JOIN employers emp ON a.user_id = emp.id AND a.user_type = 'employer'
            ORDER BY a.checked_in_at DESC
            LIMIT 100
        `;
        const result = await pool.query(query);
        res.status(200).json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching attendance history:", error);
        res.status(500).json({ success: false, message: "Server error fetching attendance" });
    }
});

router.get('/live-events', async (req, res) => {
    try {
        const eventsResult = await pool.query(`
            SELECT * FROM events
            WHERE LOWER(COALESCE(status, '')) = 'live'
            ORDER BY created_at DESC
        `);
        const liveEvents = eventsResult.rows;
        if (liveEvents.length === 0) return res.json({ success: true, data: [] });

        const dashboardData = await Promise.all(liveEvents.map(async (event) => {
            const regCount = await pool.query('SELECT COUNT(*) FROM event_candidate_registrations WHERE event_id = $1', [event.id]);
            const empRegCount = await pool.query('SELECT COUNT(*) FROM employer_event_stalls WHERE event_id = $1', [event.id]);
            
            const candidateAtt = await pool.query("SELECT COUNT(*) FROM event_attendance WHERE event_id = $1 AND user_type = 'candidate'", [event.id]);
            const employerAtt = await pool.query("SELECT COUNT(*) FROM event_attendance WHERE event_id = $1 AND user_type = 'employer'", [event.id]);
            const interviews = await pool.query("SELECT COUNT(*) FROM event_interviews WHERE event_id = $1 AND status = 'interviewed'", [event.id]);
            const offers = await pool.query("SELECT COUNT(*) FROM event_interviews WHERE event_id = $1 AND status = 'hired'", [event.id]);

            return {
                id: event.id, name: event.name, location: event.location,
                registrations: { 
                    candidates: parseInt(regCount.rows[0].count), 
                    employers: parseInt(empRegCount.rows[0].count) 
                },
                attendance: { candidates: parseInt(candidateAtt.rows[0].count), employers: parseInt(employerAtt.rows[0].count) },
                interviews: parseInt(interviews.rows[0].count),
                offers: parseInt(offers.rows[0].count)
            };
        }));
        res.status(200).json({ success: true, data: dashboardData });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// --- EVENTS & VENUE MANAGEMENT ---
router.get('/events', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, event_date, event_time, poster, event_type, city, employer_capacity, status, stall_price,
            (SELECT COUNT(*) FROM employer_event_stalls WHERE event_id = events.id) as registered_count
            FROM events ORDER BY event_date DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.post('/events', async (req, res) => {
    const { name, date, time, type, city, venue, maps_link, capacity, price, poster, desc } = req.body;
    try {
        const qrString = `GATE_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
        await pool.query(`
            INSERT INTO events (name, event_date, event_time, event_type, city, venue_address, google_maps_link, employer_capacity, stall_price, poster, qr_code_string, status, description) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'upcoming', $12)
        `, [name, date, time || null, type, city, venue, maps_link, parseInt(capacity) || null, parseFloat(price) || null, poster || null, qrString, desc]);
        res.status(201).json({ success: true, message: 'Event created' });
    } catch (error) { 
        console.error("Error creating event:", error);
        res.status(500).json({ success: false }); 
    }
});

router.put('/events/:id', async (req, res) => {
    const { name, event_date, event_time, event_type, city, venue_address, google_maps_link, employer_capacity, stall_price, poster, description } = req.body;
    try {
        await pool.query(`
            UPDATE events SET 
                name = $1, event_date = $2, event_time = $3, event_type = $4, city = $5, 
                venue_address = $6, google_maps_link = $7, employer_capacity = $8, 
                stall_price = $9, poster = $10, description = $11 
            WHERE id = $12
        `, [name, event_date, event_time || null, event_type, city, venue_address, google_maps_link, parseInt(employer_capacity) || null, parseFloat(stall_price) || null, poster || null, description, req.params.id]);
        res.json({ success: true, message: 'Event details updated successfully' });
    } catch (error) { 
        console.error("Error updating event:", error);
        res.status(500).json({ success: false }); 
    }
});

router.put('/events/:id/hold', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'hold' WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: 'Event placed on hold' });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.put('/events/:id/live', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'live' WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Event is now live!" });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.put('/events/:id/complete', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'completed' WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Event marked as completed successfully." });
    } catch (error) { 
        console.error("❌ Error completing event:", error);
        res.status(500).json({ success: false, message: "Server error marking event as completed." }); 
    }
});

router.delete('/events/:id', async (req, res) => {
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

router.get('/events/:eventId/venue', async (req, res) => {
    try {
        const blocks = await pool.query("SELECT * FROM venue_blocks WHERE event_id = $1 ORDER BY id ASC", [req.params.eventId]);
        const rooms = await pool.query("SELECT * FROM venue_rooms WHERE block_id IN (SELECT id FROM venue_blocks WHERE event_id = $1)", [req.params.eventId]);
        const stalls = await pool.query(`
            SELECT s.*, e.company_name as allocated_name 
            FROM venue_stalls s LEFT JOIN employers e ON s.employer_id = e.id 
            WHERE s.event_id = $1 ORDER BY s.code ASC
        `, [req.params.eventId]);

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

// 🚨 BUG FIX: Bulletproof Integer Casting for Block Creation 🚨
router.post('/events/:eventId/venue/blocks', async (req, res) => {
    const { eventId } = req.params;
    const { kind, name, code } = req.body;

    if (!name || !code) {
        return res.status(400).json({ success: false, message: "Block Name and Code are required." });
    }

    try {
        const eId = parseInt(eventId, 10);
        const result = await pool.query(
            `INSERT INTO venue_blocks (event_id, type, name, code) 
             VALUES ($1, $2, $3, $4) 
             RETURNING id, type as kind, name, code`,
            [eId, kind || 'Block', name.trim(), code.trim().toUpperCase()]
        );
        res.status(201).json({ success: true, message: "Venue block created successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error creating venue block:", error.message);
        res.status(500).json({ success: false, message: "Database error creating block: " + error.message });
    }
});

// 🚨 BUG FIX: Bulletproof Integer Casting for Room Creation 🚨
router.post('/events/:eventId/venue/rooms', async (req, res) => {
    const { blockId, name, code } = req.body;
    if (!blockId || !name || !code) {
        return res.status(400).json({ success: false, message: "Block ID, Room Name, and Code are required." });
    }
    try {
        const bId = parseInt(blockId, 10);
        const result = await pool.query(
            `INSERT INTO venue_rooms (block_id, name, code) 
             VALUES ($1, $2, $3) 
             RETURNING id, name, code`,
            [bId, name.trim(), code.trim().toUpperCase()]
        );
        res.status(201).json({ success: true, message: "Venue room/section created successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error creating venue room:", error.message);
        res.status(500).json({ success: false, message: "Database error creating room: " + error.message });
    }
});

// 🚨 BUG FIX: Bulletproof Integer Casting for Stall Creation (Prevents 500 Error) 🚨
router.post('/events/:eventId/venue/stalls', async (req, res) => {
    const { eventId } = req.params;
    const { blockId, roomId, code } = req.body;

    if (!code || !blockId) {
        return res.status(400).json({ success: false, message: "Block ID and Stall Code are required." });
    }

    try {
        const eId = parseInt(eventId, 10);
        const bId = parseInt(blockId, 10);
        
        // Safely parse Room ID (handles 'undefined', 'null', empty strings)
        let rId = null;
        if (roomId && roomId !== 'null' && roomId !== 'undefined') {
            rId = parseInt(roomId, 10);
            if (isNaN(rId)) rId = null; 
        }

        const duplicate = await pool.query(
            "SELECT id FROM venue_stalls WHERE event_id = $1 AND UPPER(code) = $2",
            [eId, code.trim().toUpperCase()]
        );
        
        if (duplicate.rows.length > 0) {
            return res.status(400).json({ success: false, message: `Stall code "${code}" already exists for this event.` });
        }

        const result = await pool.query(
            `INSERT INTO venue_stalls (event_id, block_id, room_id, code, employer_id) 
             VALUES ($1, $2, $3, $4, NULL) 
             RETURNING id, code`,
            [eId, bId, rId, code.trim().toUpperCase()]
        );
        res.status(201).json({ success: true, message: "Stall created successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error creating stall:", error.message);
        res.status(500).json({ success: false, message: "Database error creating stall: " + error.message });
    }
});

router.delete('/stalls/:id', async (req, res) => {
    try {
        const stallId = parseInt(req.params.id, 10);
        await pool.query("DELETE FROM venue_stalls WHERE id = $1", [stallId]);
        res.json({ success: true, message: "Stall deleted successfully!" });
    } catch (error) {
        console.error("❌ Error deleting stall:", error);
        res.status(500).json({ success: false, message: "Server error deleting stall." });
    }
});

// GET: List all stall applications
router.get(['/stall-applications', '/stall_applications'], async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT es.id, es.status, es.payment_status, es.applied_at, es.roles_to_hire as "rolesToHire", es.vacancies_count as "vacanciesCount",
                   e.company_name as "employerName", e.email as "contactEmail", ev.id as "eventId", ev.name as "eventName", s.code as "allocatedStall",
                   e.id as "employer_id" 
            FROM employer_event_stalls es
            JOIN employers e ON es.employer_id = e.id 
            JOIN events ev ON es.event_id = ev.id
            LEFT JOIN venue_stalls s ON s.employer_id = e.id AND s.event_id = ev.id 
            WHERE COALESCE(LOWER(ev.status), '') != 'completed' 
            ORDER BY es.applied_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { 
        console.error("Error fetching applications:", error);
        res.status(500).json({ success: false }); 
    }
});

// PUT: Approve Stall Application
router.put(['/stall-applications/:id/approve', '/stall_applications/:id/approve'], async (req, res) => {
    try {
        await pool.query("UPDATE employer_event_stalls SET status = 'approved' WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Application approved successfully" });
    } catch (error) {
        console.error("Error approving stall:", error);
        res.status(500).json({ success: false, message: "Database error approving application" });
    }
});

// PUT: Reject Stall Application
router.put(['/stall-applications/:id/reject', '/stall_applications/:id/reject'], async (req, res) => {
    try {
        await pool.query("UPDATE employer_event_stalls SET status = 'rejected' WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Application rejected successfully" });
    } catch (error) {
        console.error("Error rejecting stall:", error);
        res.status(500).json({ success: false, message: "Database error rejecting application" });
    }
});

// =====================================================================
// --- JOBS & APPROVALS (UPDATED FOR EVENTS HISTORY) ---
// =====================================================================
router.get('/jobs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                j.id, j.title, j.company_name, j.job_type, j.location, j.status, 
                j.created_at, j.event_id, j.vacancies,
                e.name as event_name, LOWER(e.status) as event_status
            FROM jobs j 
            LEFT JOIN events e ON j.event_id = e.id
            ORDER BY j.created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { 
        console.error("❌ Error fetching jobs:", error);
        res.status(500).json({ success: false }); 
    }
});

router.get('/events/:eventId/jobs', async (req, res) => {
    const { eventId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM jobs WHERE event_id = $1 ORDER BY created_at DESC",
            [eventId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching admin event jobs:", error);
        res.status(500).json({ success: false, message: "Server error fetching event jobs" });
    }
});

router.put('/jobs/:jobId/status', async (req, res) => {
    const { jobId } = req.params;
    const { status } = req.body; 

    try {
        const updatedJob = await pool.query(
            `UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *`,
            [status, jobId]
        );

        if (updatedJob.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Job not found" });
        }
        res.json({ success: true, message: `Job marked as ${status}`, data: updatedJob.rows[0] });
    } catch (error) {
        console.error("❌ Error updating job status:", error);
        res.status(500).json({ success: false, message: "Server error updating job status" });
    }
});

// =====================================================================
// --- EMPLOYERS MANAGEMENT (FAIL-SAFE SELECT ALL WITH FALLBACKS) ---
// =====================================================================
router.get('/employers', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM employers ORDER BY id DESC`);
        
        let pocData = [];
        try {
            const pocsResult = await pool.query("SELECT * FROM employer_pocs");
            pocData = pocsResult.rows;
        } catch (err) {}

        let jobCounts = {};
        try {
            const jobsResult = await pool.query(`
                SELECT employer_id, COUNT(*) as count 
                FROM jobs 
                WHERE status = 'approved' OR status = 'Active' 
                GROUP BY employer_id
            `);
            jobsResult.rows.forEach(r => {
                jobCounts[r.employer_id] = parseInt(r.count) || 0;
            });
        } catch (err) {}

        const formattedData = result.rows.map(e => {
            const empId = e.id;
            const empEmail = e.email || e.contact_email || e.company_email || 'N/A';
            const empPhone = e.phone || e.mobile || e.contact_number || e.phone_number || 'N/A';
            const empName = e.company_name || e.name || 'Company';
            const rawGst = e.gst_cin || e.gst || e.gst_status || 'Pending';
            const empGst = rawGst !== 'Pending' && rawGst !== '' ? 'Verified' : 'Pending';
            
            let empStatus = e.status || 'pending';
            if (empStatus === 'blacklisted') empStatus = 'deleted';

            const employerPocs = pocData.filter(p => p.employer_id === empId).map(p => ({
                email: p.email || p.contact_email || 'N/A',
                phone: p.phone || p.mobile || p.contact_number || 'N/A'
            }));

            return {
                id: `EMP-${String(empId).padStart(3, '0')}`, 
                dbId: empId, 
                name: empName,
                email: empEmail,
                phone: empPhone,
                gst: empGst, 
                jobs: jobCounts[empId] || 0,
                status: empStatus,
                pocs: employerPocs
            };
        });

        res.json({ success: true, data: formattedData });
    } catch (error) { 
        console.error("❌ Error fetching employers:", error);
        res.status(500).json({ success: false, message: error.message }); 
    }
});

router.put('/employers/:dbId/status', async (req, res) => {
    const { dbId } = req.params;
    const { status } = req.body;
    try {
        let dbStatus = status;
        if (status === 'deleted') dbStatus = 'blacklisted';
        
        const result = await pool.query(
            `UPDATE employers SET status = $1 WHERE id = $2 RETURNING id, company_name, status`,
            [dbStatus, dbId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employer not found." });
        }
        res.json({ success: true, message: `Employer status updated to ${dbStatus}`, data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error updating employer status:", error);
        res.status(500).json({ success: false, message: "Server error updating employer status." });
    }
});

// --- CANDIDATE MODERATION & MANAGEMENT ---
router.get('/candidates', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.unique_id AS id, c.full_name AS name, c.email, c.phone, 
                   COALESCE(c.highest_qualification, 'N/A') AS qual,
                   COALESCE(c.district, 'N/A') AS district, 
                   COALESCE(c.account_status, 'Active') AS account_status,
                   EXISTS (SELECT 1 FROM event_candidate_registrations ecr WHERE ecr.candidate_id::text = c.unique_id AND LOWER(ecr.attendance_status) = 'present') AS attended
            FROM candidates c ORDER BY c.created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.put('/candidates/:id/block', async (req, res) => {
    const { id } = req.params;
    const { action } = req.body;
    
    try {
        const newStatus = action === 'Block' ? 'Blocked' : 'Active';
        const result = await pool.query(
            `UPDATE candidates SET account_status = $1 WHERE unique_id = $2 RETURNING unique_id, account_status`,
            [newStatus, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Candidate not found." });
        }
        res.json({ success: true, message: `Candidate account ${newStatus.toLowerCase()} successfully.`, data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error updating candidate status:", error);
        res.status(500).json({ success: false, message: "Server error updating candidate status." });
    }
});

// --- MONITORING & REPORTS ---
router.get('/events/:eventId/crowd-monitoring', async (req, res) => {
    const { eventId } = req.params;
    try {
        const query = `
            SELECT 
                e.id as employer_id,
                e.company_name as "companyName",
                COUNT(q.id) FILTER (WHERE q.status = 'waiting') as "waitingCount",
                COUNT(q.id) FILTER (WHERE q.status = 'called') as "calledCount",
                COUNT(q.id) FILTER (WHERE q.status = 'completed') as "completedCount"
            FROM employers e
            JOIN jobs j ON j.employer_id = e.id
            LEFT JOIN event_queues q ON q.job_id = j.id AND q.event_id = $1
            WHERE j.event_id = $1
            GROUP BY e.id, e.company_name
            ORDER BY "waitingCount" DESC;
        `;
        const result = await pool.query(query, [eventId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching crowd monitoring stats:", error);
        res.status(500).json({ success: false, message: "Server error fetching crowd data." });
    }
});

router.get('/events/history', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, event_date, event_type, city, venue_address, status, description,
                   (SELECT COUNT(DISTINCT employer_id) FROM employer_event_stalls WHERE event_id = events.id) as total_companies,
                   (SELECT COUNT(*) FROM event_attendance WHERE event_id = events.id) as total_attendance
            FROM events 
            WHERE LOWER(status) = 'completed'
            ORDER BY event_date DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching event history:", error);
        res.status(500).json({ success: false, message: "Server error fetching event history." });
    }
});

router.get('/events/:id/export', async (req, res) => {
    const eventId = req.params.id;
    try {
        const eventResult = await pool.query("SELECT * FROM events WHERE id = $1", [eventId]);
        if (eventResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Event not found" });
        }
        const ev = eventResult.rows[0];
        const eventName = ev.name || ev.event_name || "Udyoga Mela";
        const rawDate = ev.event_date || ev.date || ev.created_at;
        const eventDate = rawDate ? new Date(rawDate).toLocaleDateString('en-IN') : "N/A";
        const eventLocation = ev.city || ev.location || ev.venue_address || "N/A";

        let employersRows = [];
        try {
            const empRes = await pool.query(`
                SELECT 
                    e.id, 
                    e.company_name, 
                    e.email, 
                    e.phone, 
                    COALESCE(es.status, 'pending') as registration_status,
                    COALESCE(es.payment_status, 'pending') as payment_status,
                    (SELECT code FROM venue_stalls WHERE employer_id = e.id AND event_id = $1 LIMIT 1) as stall_code
                FROM employers e
                JOIN employer_event_stalls es ON e.id = es.employer_id
                WHERE es.event_id = $1
            `, [eventId]);
            employersRows = empRes.rows;
        } catch (dbErr) {}

        let candidatesRows = [];
        try {
            const candRes = await pool.query(`
                SELECT 
                    c.unique_id, 
                    c.full_name, 
                    c.email, 
                    c.phone, 
                    COALESCE(c.highest_qualification, 'N/A') as qualification, 
                    COALESCE(c.district, 'N/A') as district, 
                    COALESCE(r.attendance_status, 'Pending') as attendance_status,
                    r.queue_token,
                    r.entry_pass_id
                FROM candidates c
                JOIN event_candidate_registrations r ON (c.id::text = r.candidate_id::text OR c.unique_id = r.candidate_id::text)
                WHERE r.event_id = $1
            `, [eventId]);
            candidatesRows = candRes.rows;
        } catch (dbErr) {}

        let csvRows = [];
        csvRows.push(`"Event Report:","${eventName}"`);
        csvRows.push(`"Date:","${eventDate}","Location:","${eventLocation}"`);
        csvRows.push("");

        csvRows.push(`"--- REGISTERED EMPLOYERS ---"`);
        csvRows.push(`"Employer DB ID","Company Name","Email","Phone","Registration Status","Payment Status","Allocated Stall"`);
        if (employersRows.length === 0) {
            csvRows.push(`"No employers registered for this event."`);
        } else {
            employersRows.forEach(emp => {
                csvRows.push(`"${emp.id}","${(emp.company_name || '').replace(/"/g, '""')}","${emp.email || ''}","${emp.phone || ''}","${emp.registration_status}","${emp.payment_status}","${emp.stall_code || 'Pending'}"`);
            });
        }
        
        csvRows.push("");
        csvRows.push("");

        csvRows.push(`"--- REGISTERED CANDIDATES ---"`);
        csvRows.push(`"Candidate Unique ID","Full Name","Email","Phone","Qualification","District","Attendance Status","Queue Token","Entry Pass ID"`);
        if (candidatesRows.length === 0) {
            csvRows.push(`"No candidates registered for this event."`);
        } else {
            candidatesRows.forEach(cand => {
                csvRows.push(`"${cand.unique_id || ''}","${(cand.full_name || '').replace(/"/g, '""')}","${cand.email || ''}","${cand.phone || ''}","${(cand.qualification || '').replace(/"/g, '""')}","${cand.district || ''}","${cand.attendance_status}","${cand.queue_token || ''}","${cand.entry_pass_id || ''}"`);
            });
        }

        const csvString = csvRows.join("\n");
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${eventName.replace(/\s+/g, '_')}_Master_Report.csv"`);
        return res.status(200).send(csvString);
    } catch (error) {
        console.error("❌ Critical Error exporting event report:", error.message);
        return res.status(500).json({ success: false, message: "Server error generating report: " + error.message });
    }
});

// =====================================================================
// --- EVENT CANDIDATES REPORT ---
// =====================================================================
router.get('/events/:eventId/candidates-report', async (req, res) => {
    const { eventId } = req.params;
    try {
        const query = `
            SELECT 
                c.unique_id, c.full_name as name, c.email, c.phone, c.highest_qualification as qual, c.district,
                COALESCE(ecr.attendance_status, 'Pending') as attendance,
                (SELECT COUNT(*) FROM job_applications ja JOIN jobs j ON ja.job_id = j.id WHERE (ja.candidate_id::text = c.id::text OR ja.candidate_id::text = c.unique_id) AND j.event_id::text = $1) as total_applications,
                (SELECT COUNT(*) FROM job_applications ja JOIN jobs j ON ja.job_id = j.id WHERE (ja.candidate_id::text = c.id::text OR ja.candidate_id::text = c.unique_id) AND j.event_id::text = $1 AND ja.status ILIKE '%interview%') as interviews,
                EXISTS(SELECT 1 FROM job_applications ja JOIN jobs j ON ja.job_id = j.id WHERE (ja.candidate_id::text = c.id::text OR ja.candidate_id::text = c.unique_id) AND j.event_id::text = $1 AND ja.status ILIKE '%hired%') as is_hired,
                ARRAY(
                    SELECT DISTINCT COALESCE(j.company_name, emp.company_name)
                    FROM job_applications ja
                    JOIN jobs j ON ja.job_id = j.id
                    LEFT JOIN employers emp ON j.employer_id = emp.id
                    WHERE (ja.candidate_id::text = c.id::text OR ja.candidate_id::text = c.unique_id) AND j.event_id::text = $1
                ) as companies_applied
            FROM event_candidate_registrations ecr
            JOIN candidates c ON (ecr.candidate_id::text = c.id::text OR ecr.candidate_id::text = c.unique_id)
            WHERE ecr.event_id::text = $1
            ORDER BY c.created_at DESC
        `;
        const result = await pool.query(query, [eventId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching event candidates report:", error);
        res.status(500).json({ success: false, message: "Server error fetching report." });
    }
});

// =====================================================================
// --- STALL-WISE INTERVIEW CONTROL & LOGS REPORT (NEW) ---
// =====================================================================
router.get('/events/:eventId/interviews-report', async (req, res) => {
    const { eventId } = req.params;
    try {
        // 1. Stall-wise aggregated interview statistics
        const stallQuery = `
            SELECT 
                s.id as stall_id,
                s.code as stall_code,
                e.id as employer_id,
                e.company_name,
                COUNT(DISTINCT ja.id) FILTER (WHERE ja.status ILIKE '%waiting%' OR ja.status ILIKE '%pending%') as waiting_count,
                COUNT(DISTINCT ja.id) FILTER (WHERE ja.status ILIKE '%shortlist%') as shortlisted_count,
                COUNT(DISTINCT ja.id) FILTER (WHERE ja.status ILIKE '%interview%') as interviewed_count,
                COUNT(DISTINCT ja.id) FILTER (WHERE ja.status ILIKE '%hired%' OR ja.status ILIKE '%offer%') as hired_count,
                COUNT(DISTINCT ja.id) FILTER (WHERE ja.status ILIKE '%reject%') as rejected_count,
                COUNT(DISTINCT ja.id) as total_applications
            FROM venue_stalls s
            JOIN employers e ON s.employer_id = e.id
            LEFT JOIN jobs j ON j.employer_id = e.id AND j.event_id::text = s.event_id::text
            LEFT JOIN job_applications ja ON ja.job_id = j.id
            WHERE s.event_id::text = $1
            GROUP BY s.id, s.code, e.id, e.company_name
            ORDER BY s.code ASC
        `;
        const stallRes = await pool.query(stallQuery, [eventId]);

        // 2. Detailed candidate interview log list
        const logsQuery = `
            SELECT 
                ja.id as application_id,
                c.unique_id as candidate_id,
                c.full_name as candidate_name,
                c.email as candidate_email,
                c.phone as candidate_phone,
                j.title as job_title,
                COALESCE(j.company_name, emp.company_name) as company_name,
                vs.code as stall_code,
                ja.status as interview_status,
                ja.applied_at as interview_time
            FROM job_applications ja
            JOIN jobs j ON ja.job_id = j.id
            LEFT JOIN candidates c ON (ja.candidate_id::text = c.id::text OR ja.candidate_id::text = c.unique_id)
            LEFT JOIN employers emp ON j.employer_id = emp.id
            LEFT JOIN venue_stalls vs ON vs.employer_id = emp.id AND vs.event_id::text = j.event_id::text
            WHERE j.event_id::text = $1
            ORDER BY ja.applied_at DESC
        `;
        const logsRes = await pool.query(logsQuery, [eventId]);

        res.json({ 
            success: true, 
            data: {
                stalls: stallRes.rows,
                logs: logsRes.rows
            }
        });
    } catch (error) {
        console.error("❌ Error fetching interview report:", error);
        res.status(500).json({ success: false, message: "Server error fetching interview report." });
    }
});

// ==========================================
// EMPLOYER FEEDBACK MODERATION
// ==========================================
router.get('/feedback', async (req, res) => {
  try {
    const query = `
      SELECT 
        ef.id,
        ef.employer_id AS "employerId",
        COALESCE(u.company_name, 'Employer #' || ef.employer_id) AS "employerName",
        ef.overall_rating AS "rating",
        ef.candidate_quality AS "candidateQuality",
        ef.event_organization AS "eventOrganisation",
        ef.hiring_efficiency AS "hiringEfficiency",
        ef.video_url AS "videoUrl",
        ef.status,
        TO_CHAR(ef.created_at, 'DD Mon YYYY') AS "createdAt"
      FROM employer_feedback ef
      LEFT JOIN employers u ON u.id = ef.employer_id
      ORDER BY ef.created_at DESC;
    `;
    const result = await pool.query(query);

    return res.status(200).json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching feedback for admin:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/feedback/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'published', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value' });
    }

    const query = `
      UPDATE employer_feedback
      SET status = $1
      WHERE id = $2
      RETURNING *;
    `;
    const result = await pool.query(query, [status, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Feedback item not found' });
    }

    return res.status(200).json({
      success: true,
      message: `Feedback marked as ${status}`,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating feedback status:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==========================================
// NOTIFICATIONS & COMMUNICATION SYSTEM
// ==========================================

// GET: Fetch compact lists of users for the Notification Dropdowns
router.get('/users-list', async (req, res) => {
    try {
        const candidatesRes = await pool.query(`SELECT unique_id as id, full_name as name FROM candidates ORDER BY full_name ASC`);
        const employersRes = await pool.query(`SELECT id, company_name as name FROM employers ORDER BY company_name ASC`);
        
        res.json({
            success: true,
            data: {
                candidates: candidatesRes.rows,
                employers: employersRes.rows
            }
        });
    } catch (error) {
        console.error("❌ Error fetching users list for notifications:", error);
        res.status(500).json({ success: false, message: "Server error fetching users." });
    }
});

// POST: Send/Queue a broadcast message
router.post('/notifications/send', async (req, res) => {
    const { channels, audience, specificUserId, subject, message } = req.body;

    if (!channels || channels.length === 0) return res.status(400).json({ success: false, message: "No delivery channels selected." });
    if (!subject || !message) return res.status(400).json({ success: false, message: "Subject and message are required." });

    try {
        let recipientCount = 0;

        // 1. Process Portal Notifications (Actually inserts into DB)
        if (channels.includes('portal')) {
            await pool.query(
                `INSERT INTO notifications (audience_type, user_id, subject, message, channels) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [audience, specificUserId || null, subject, message, channels]
            );
            
            // Just for a realistic response message, count approx how many people get it
            if (audience === 'all_candidates') {
                const c = await pool.query('SELECT COUNT(*) FROM candidates');
                recipientCount = parseInt(c.rows[0].count);
            } else if (audience === 'all_employers') {
                const e = await pool.query('SELECT COUNT(*) FROM employers');
                recipientCount = parseInt(e.rows[0].count);
            } else {
                recipientCount = 1; 
            }
        } else {
            // If only SMS/Email are selected (Mock functionality for now as requested)
            recipientCount = audience.includes('specific') ? 1 : 250; // Mock count
        }

        // Generate dynamic success message based on channels used
        const channelNames = channels.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ');
        const successMsg = `Successfully queued ${channelNames} broadcast for ${recipientCount} recipient(s).`;

        res.json({ success: true, message: successMsg });
    } catch (error) {
        console.error("❌ Error sending notification broadcast:", error);
        res.status(500).json({ success: false, message: "Server error processing broadcast." });
    }
});

// ==========================================
// --- EXHIBITOR MANAGEMENT ---
// ==========================================
router.get('/exhibitors', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, company_name as name, email, phone, status, created_at FROM exhibitors ORDER BY created_at DESC`);
        
        const formattedData = result.rows.map(e => ({
            id: `EXH-${String(e.id).padStart(3, '0')}`,
            dbId: e.id,
            name: e.name,
            email: e.email || 'N/A',
            phone: e.phone || 'N/A',
            status: e.status || 'pending',
            created_at: e.created_at
        }));

        res.json({ success: true, data: formattedData });
    } catch (error) { 
        console.error("❌ Error fetching exhibitors:", error);
        res.status(500).json({ success: false, message: error.message }); 
    }
});

router.put('/exhibitors/:dbId/status', async (req, res) => {
    const { dbId } = req.params;
    const { status } = req.body; // 'approved' or 'rejected'
    try {
        const result = await pool.query(
            `UPDATE exhibitors SET status = $1 WHERE id = $2 RETURNING id, company_name as name, status`,
            [status, dbId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Exhibitor not found." });
        }
        res.json({ success: true, message: `Exhibitor status updated to ${status}`, data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error updating exhibitor status:", error);
        res.status(500).json({ success: false, message: "Server error updating exhibitor status." });
    }
});

module.exports = router;
