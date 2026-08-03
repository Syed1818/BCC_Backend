const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const bcrypt = require('bcrypt');

// --- STALL ALLOCATION & FEEDBACK ---
router.put('/stalls/:id/allocate', async (req, res) => {
    const stallId = req.params.id;
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

router.get('/feedback', async (req, res) => {
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
        console.error("❌ Error fetching feedback:", error);
        res.status(500).json({ success: false, message: "Server error fetching feedback." });
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
            SELECT id, name, event_date, event_type, city, employer_capacity, status, stall_price,
            (SELECT COUNT(*) FROM employer_event_stalls WHERE event_id = events.id) as registered_count
            FROM events ORDER BY event_date DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.post('/events', async (req, res) => {
    const { name, date, type, city, venue, maps_link, capacity, price, desc } = req.body;
    try {
        const qrString = `GATE_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
        await pool.query(`
            INSERT INTO events (name, event_date, event_type, city, venue_address, google_maps_link, employer_capacity, stall_price, qr_code_string, status, description) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'upcoming', $10)
        `, [name, date, type, city, venue, maps_link, parseInt(capacity), parseFloat(price), qrString, desc]);
        res.status(201).json({ success: true, message: 'Event created' });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.put('/events/:id', async (req, res) => {
    const { name, event_date, event_type, city, venue_address, employer_capacity, stall_price, description } = req.body;
    try {
        await pool.query(`UPDATE events SET name = $1, event_date = $2, event_type = $3, city = $4, venue_address = $5, employer_capacity = $6, stall_price = $7, description = $8 WHERE id = $9`, 
        [name, event_date, event_type, city, venue_address, parseInt(employer_capacity), parseFloat(stall_price), description, req.params.id]);
        res.json({ success: true, message: 'Event details updated successfully' });
    } catch (error) { res.status(500).json({ success: false }); }
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

router.post('/events/:eventId/venue/blocks', async (req, res) => {
    const { eventId } = req.params;
    const { kind, name, code } = req.body;

    if (!name || !code) {
        return res.status(400).json({ success: false, message: "Block Name and Code are required." });
    }

    try {
        const result = await pool.query(
            `INSERT INTO venue_blocks (event_id, type, name, code) 
             VALUES ($1, $2, $3, $4) 
             RETURNING id, type as kind, name, code`,
            [eventId, kind || 'Block', name.trim(), code.trim().toUpperCase()]
        );
        res.status(201).json({ success: true, message: "Venue block created successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error creating venue block:", error);
        res.status(500).json({ success: false, message: "Database error creating block: " + error.message });
    }
});

router.post('/events/:eventId/venue/rooms', async (req, res) => {
    const { blockId, name, code } = req.body;
    if (!blockId || !name || !code) {
        return res.status(400).json({ success: false, message: "Block ID, Room Name, and Code are required." });
    }
    try {
        const result = await pool.query(
            `INSERT INTO venue_rooms (block_id, name, code) 
             VALUES ($1, $2, $3) 
             RETURNING id, name, code`,
            [blockId, name.trim(), code.trim().toUpperCase()]
        );
        res.status(201).json({ success: true, message: "Venue room/section created successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error creating venue room:", error);
        res.status(500).json({ success: false, message: "Database error creating room: " + error.message });
    }
});

router.post('/events/:eventId/venue/stalls', async (req, res) => {
    const { eventId } = req.params;
    const { blockId, roomId, code } = req.body;

    if (!code || !blockId) {
        return res.status(400).json({ success: false, message: "Block ID and Stall Code are required." });
    }

    try {
        const duplicate = await pool.query(
            "SELECT id FROM venue_stalls WHERE event_id = $1 AND UPPER(code) = $2",
            [eventId, code.trim().toUpperCase()]
        );
        if (duplicate.rows.length > 0) {
            return res.status(400).json({ success: false, message: `Stall code "${code}" already exists for this event.` });
        }

        const result = await pool.query(
            `INSERT INTO venue_stalls (event_id, block_id, room_id, code, employer_id) 
             VALUES ($1, $2, $3, $4, NULL) 
             RETURNING id, code`,
            [eventId, blockId, roomId || null, code.trim().toUpperCase()]
        );
        res.status(201).json({ success: true, message: "Stall created successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error creating stall:", error);
        res.status(500).json({ success: false, message: "Database error creating stall: " + error.message });
    }
});

router.delete('/stalls/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM venue_stalls WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Stall deleted successfully!" });
    } catch (error) {
        console.error("❌ Error deleting stall:", error);
        res.status(500).json({ success: false, message: "Server error deleting stall." });
    }
});

// Inside your routes/admin.routes.js
router.get('/stall-applications', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT es.id, es.status, es.payment_status, es.applied_at, es.roles_to_hire as "rolesToHire", es.vacancies_count as "vacanciesCount",
                   e.company_name as "employerName", e.email as "contactEmail", ev.id as "eventId", ev.name as "eventName", s.code as "allocatedStall",
                   e.id as "employer_id" 
            FROM employer_event_stalls es
            JOIN employers e ON es.employer_id = e.id 
            JOIN events ev ON es.event_id = ev.id
            LEFT JOIN venue_stalls s ON s.employer_id = e.id AND s.event_id = ev.id 
            WHERE LOWER(ev.status) != 'completed' 
            ORDER BY es.applied_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { 
        console.error("Error fetching applications:", error);
        res.status(500).json({ success: false }); 
    }
});

// --- JOBS & APPROVALS ---
router.get('/jobs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, title, company_name, job_type, location, status, created_at, event_id 
            FROM jobs 
            ORDER BY created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
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

// --- EMPLOYERS & CANDIDATES MANAGEMENT ---
router.get('/employers', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT e.id, e.company_name AS name, COALESCE(e.gst_cin, 'Pending') AS gst_status, e.status,
                   COALESCE(AVG(ef.overall_rating), 4.0)::numeric(2,1) AS rating,
                   (SELECT COUNT(*) FROM jobs j WHERE j.employer_id = e.id AND j.status = 'approved') AS jobs
            FROM employers e LEFT JOIN employer_feedback ef ON e.id = ef.employer_id GROUP BY e.id ORDER BY e.created_at DESC
        `);
        const formattedData = result.rows.map(e => ({
            id: `EMP-${String(e.id).padStart(3, '0')}`, dbId: e.id, name: e.name,
            gst: e.gst_status !== 'Pending' ? 'Verified' : 'Pending', jobs: parseInt(e.jobs) || 0,
            rating: parseFloat(e.rating), status: e.status === 'approved' ? 'Active' : e.status === 'blacklisted' ? 'Blacklisted' : 'Pending'
        }));
        res.json({ success: true, data: formattedData });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.put('/employers/:dbId/status', async (req, res) => {
    const { dbId } = req.params;
    const { status } = req.body;
    try {
        let dbStatus = status;
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

router.get('/candidates', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.unique_id AS id, c.full_name AS name, COALESCE(c.highest_qualification, 'N/A') AS qual,
                   COALESCE(c.district, 'N/A') AS district, COALESCE(c.account_status, 'Pending') AS status,
                   EXISTS (SELECT 1 FROM event_candidate_registrations ecr WHERE ecr.candidate_id::text = c.unique_id AND LOWER(ecr.attendance_status) = 'present') AS attended
            FROM candidates c ORDER BY c.created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
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

        // Safe query for employers
        let employersRows = [];
        try {
            const empRes = await pool.query(`
                SELECT e.id, e.company_name, e.email, e.phone, e.status, 
                       (SELECT code FROM venue_stalls WHERE employer_id = e.id AND event_id = $1 LIMIT 1) as stall_code
                FROM employers e
                JOIN employer_event_stalls es ON e.id = es.employer_id
                WHERE es.event_id = $1
            `, [eventId]);
            employersRows = empRes.rows;
        } catch (dbErr) {
            console.error("⚠️ Employer export sub-query warning:", dbErr.message);
        }

        // Safe query for candidates
        let candidatesRows = [];
        try {
            const candRes = await pool.query(`
                SELECT c.unique_id, c.full_name, c.email, c.phone, 
                       COALESCE(c.highest_qualification, 'N/A') as qualification, 
                       COALESCE(c.district, 'N/A') as district, 
                       COALESCE(r.attendance_status, 'Pending') as attendance_status
                FROM candidates c
                JOIN event_candidate_registrations r ON (c.id::text = r.candidate_id::text OR c.unique_id = r.candidate_id::text)
                WHERE r.event_id = $1
            `, [eventId]);
            candidatesRows = candRes.rows;
        } catch (dbErr) {
            console.error("⚠️ Candidate export sub-query warning:", dbErr.message);
        }

        let csvRows = [];
        csvRows.push(`"Event Report:","${eventName}"`);
        csvRows.push(`"Date:","${eventDate}","Location:","${eventLocation}"`);
        csvRows.push("");

        // --- EMPLOYERS SECTION ---
        csvRows.push(`"--- REGISTERED EMPLOYERS ---"`);
        csvRows.push(`"Company ID","Company Name","Email","Phone","Status","Allocated Stall"`);
        if (employersRows.length === 0) {
            csvRows.push(`"No employers registered for this event."`);
        } else {
            employersRows.forEach(emp => {
                csvRows.push(`"${emp.id}","${emp.company_name || ''}","${emp.email || ''}","${emp.phone || ''}","${emp.status || ''}","${emp.stall_code || 'Pending'}"`);
            });
        }
        
        csvRows.push("");
        csvRows.push("");

        // --- CANDIDATES SECTION ---
        csvRows.push(`"--- REGISTERED CANDIDATES ---"`);
        csvRows.push(`"Candidate ID","Full Name","Email","Phone","Qualification","District","Attendance"`);
        if (candidatesRows.length === 0) {
            csvRows.push(`"No candidates registered for this event."`);
        } else {
            candidatesRows.forEach(cand => {
                csvRows.push(`"${cand.unique_id || ''}","${cand.full_name || ''}","${cand.email || ''}","${cand.phone || ''}","${cand.qualification || ''}","${cand.district || ''}","${cand.attendance_status || 'Pending'}"`);
            });
        }

        const csvString = csvRows.join("\n");
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${eventName.replace(/\s+/g, '_')}_Full_Data.csv"`);
        return res.status(200).send(csvString);
    } catch (error) {
        console.error("❌ Critical Error exporting event report:", error.message);
        return res.status(500).json({ success: false, message: "Server error generating report: " + error.message });
    }
});

// --- ADMIN TEAM & IAM MANAGEMENT ---
router.post('/team', async (req, res) => {
    const { fullName, email, password, role, permissions } = req.body;
    if (!fullName || !email || !password || !role) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }
    if (role === 'Admin') {
        return res.status(400).json({ success: false, message: "The Master Admin role is exclusive to the BCC CEO and cannot be assigned." });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const result = await pool.query(
            `INSERT INTO admin_team (full_name, email, password, role, permissions, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING id, full_name, email, role`,
            [fullName.trim(), email.trim().toLowerCase(), hashedPassword, role, JSON.stringify(permissions || {})]
        );

        res.status(201).json({ success: true, message: "Admin team member created successfully.", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error adding admin team member:", error);
        res.status(500).json({ success: false, message: "Server error saving team member." });
    }
});

router.get('/team', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, full_name as name, email, role, created_at FROM admin_team ORDER BY created_at DESC");
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching admin team:", error);
        res.status(500).json({ success: false, message: "Server error fetching team members." });
    }
});

router.delete('/team/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM admin_team WHERE id = $1", [id]);
        res.json({ success: true, message: "Team member deleted successfully." });
    } catch (error) {
        console.error("❌ Error deleting team member:", error);
        res.status(500).json({ success: false, message: "Server error deleting member." });
    }
});

// --- INTERVIEW MANAGEMENT DASHBOARD ---
router.get('/interviews/dashboard', async (req, res) => {
    try {
        // 1. Get Live Event IDs
        const liveEventsRes = await pool.query("SELECT id FROM events WHERE status = 'live'");
        const liveEventIds = liveEventsRes.rows.map(e => e.id);
        
        if (liveEventIds.length === 0) {
            return res.json({ 
                success: true, 
                data: { activeStalls: 0, scheduled: 0, avgWaitTime: 0, stalls: [], activities: [] }
            });
        }

        // 2. Get Stalls with Queue Stats
        const stallsQuery = `
            SELECT 
                s.code as stall_code,
                emp.company_name,
                COUNT(q.id) FILTER (WHERE q.status = 'waiting') as waiting,
                COUNT(q.id) FILTER (WHERE q.status = 'completed') as completed,
                MAX(q.called_at) as last_called
            FROM venue_stalls s
            JOIN employers emp ON s.employer_id = emp.id
            LEFT JOIN jobs j ON j.employer_id = emp.id AND j.event_id = s.event_id
            LEFT JOIN event_queues q ON q.job_id = j.id AND CAST(q.created_at AS DATE) = CURRENT_DATE
            WHERE s.event_id = ANY($1)
            GROUP BY s.code, emp.company_name
            ORDER BY s.code ASC
        `;
        const stallsRes = await pool.query(stallsQuery, [liveEventIds]);

        // 3. Overall stats calculations
        let totalWaiting = 0;
        let totalCompleted = 0;
        stallsRes.rows.forEach(s => {
            totalWaiting += parseInt(s.waiting || 0);
            totalCompleted += parseInt(s.completed || 0);
        });

        // Calculate average wait time based on completed queues (approximate fallback to 12 if none)
        const avgWaitQuery = `
            SELECT COALESCE(EXTRACT(EPOCH FROM AVG(called_at - created_at))/60, 12) as avg_min 
            FROM event_queues 
            WHERE event_id = ANY($1) AND status IN ('called', 'completed') AND DATE(created_at) = CURRENT_DATE
        `;
        const avgWaitRes = await pool.query(avgWaitQuery, [liveEventIds]);
        const avgWaitTime = Math.round(avgWaitRes.rows[0].avg_min);

        // 4. Recent Employer Activity
        const activityQuery = `
            SELECT 
                emp.company_name,
                ja.status as action,
                ja.applied_at as time
            FROM job_applications ja
            JOIN jobs j ON ja.job_id = j.id
            JOIN employers emp ON ja.employer_id = emp.id
            WHERE j.event_id = ANY($1)
              AND ja.status IN ('shortlisted', 'interviewed', 'hired')
            ORDER BY ja.applied_at DESC
            LIMIT 10
        `;
        const activityRes = await pool.query(activityQuery, [liveEventIds]);

        res.json({
            success: true,
            data: {
                activeStalls: stallsRes.rows.length,
                scheduled: totalWaiting + totalCompleted,
                avgWaitTime: avgWaitTime,
                stalls: stallsRes.rows,
                activities: activityRes.rows
            }
        });

    } catch (error) {
        console.error("❌ Error fetching interview dashboard:", error);
        res.status(500).json({ success: false, message: "Server error fetching interview data." });
    }
});

// ==========================================
// MOBILE QR CHECK-IN FLOW
// ==========================================

// 1. Request OTP
router.post('/qr/request-otp', async (req, res) => {
    const { email, phone, role } = req.body;
    try {
        if (role === 'candidate') {
            const result = await pool.query("SELECT id FROM candidates WHERE email = $1 AND phone = $2", [email, phone]);
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: "No candidate found with these details. Please register first." });
            }
        }
        // In a real app, send an SMS/Email here. For now, we mock it.
        res.json({ success: true, message: "OTP sent successfully! (Use 1234 for testing)" });
    } catch (error) {
        console.error("OTP Request Error:", error);
        res.status(500).json({ success: false, message: "Server error generating OTP." });
    }
});

// 2. Verify OTP & Fetch Details
router.post('/qr/verify-otp', async (req, res) => {
    const { email, phone, otp, role } = req.body;
    
    // Mock OTP verification (1234)
    if (otp !== '1234') {
        return res.status(400).json({ success: false, message: "Invalid OTP. Please try again." });
    }

    try {
        if (role === 'candidate') {
            const result = await pool.query(
                "SELECT unique_id as id, full_name as name, email, phone, highest_qualification as qual FROM candidates WHERE email = $1 AND phone = $2", 
                [email, phone]
            );
            return res.json({ success: true, data: result.rows[0] });
        } else {
            return res.status(400).json({ success: false, message: "Employer/Exhibitor flow not fully configured yet." });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error verifying OTP." });
    }
});

// 3. Mark Final Attendance
router.post('/qr/mark-attendance', async (req, res) => {
    const { eventId, userId, role } = req.body;
    try {
        let dbUserId;
        if (role === 'candidate') {
            const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [userId]);
            if (candCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });
            dbUserId = candCheck.rows[0].id;
        }

        // Check if already marked
        const dup = await pool.query("SELECT id FROM event_attendance WHERE event_id = $1 AND user_id = $2 AND user_type = $3", [eventId, dbUserId, role]);
        if (dup.rows.length > 0) {
            return res.json({ success: true, message: "Attendance is already marked for this event!" });
        }

        // Insert Attendance
        await pool.query("INSERT INTO event_attendance (event_id, user_id, user_type, checked_in_at) VALUES ($1, $2, $3, NOW())", [eventId, dbUserId, role]);
        
        // Update Registration Status
        if (role === 'candidate') {
            await pool.query("UPDATE event_candidate_registrations SET attendance_status = 'Present' WHERE event_id = $1 AND candidate_id = $2", [eventId, dbUserId]);
        }

        res.json({ success: true, message: "Attendance marked successfully!" });
    } catch (error) {
        console.error("Mark Attendance Error:", error);
        res.status(500).json({ success: false, message: "Failed to mark attendance." });
    }
});

module.exports = router;
