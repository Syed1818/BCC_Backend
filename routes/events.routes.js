const express = require('express');
const router = express.Router();
const pool = require('../config/db'); // Use your shared DB pool connection

// ==========================================
// 1. MARK VENUE ATTENDANCE (CANDIDATE & EMPLOYER)
// POST /api/events/attendance/mark
// ==========================================
router.post('/attendance/mark', async (req, res) => {
    const { eventId, userId, userType, code } = req.body;

    if (!eventId || !userId) {
        return res.status(400).json({ success: false, message: "Missing eventId or userId in request." });
    }

    if (code !== '1234' && code !== '123456') {
        return res.status(400).json({ success: false, message: "Invalid verification code." });
    }

    try {
        let dbUserId = userId;

        // Resolve Candidate DB ID
        if (userType === 'candidate') {
            const candLookup = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [userId.toString()]);
            if (candLookup.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate account not found." });
            dbUserId = candLookup.rows[0].id;
        } 
        // Resolve Employer DB ID
        else if (userType === 'employer') {
             const empLookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [userId.toString()]);
             if (empLookup.rows.length === 0) return res.status(404).json({ success: false, message: "Employer account not found." });
             dbUserId = empLookup.rows[0].id;
        }

        // Prevent Duplicate Check-ins
        const duplicateCheck = await pool.query(
            "SELECT id FROM event_attendance WHERE event_id = $1 AND user_id = $2 AND user_type = $3", 
            [eventId, dbUserId, userType]
        );
        if (duplicateCheck.rows.length > 0) {
            return res.json({ success: true, message: "Already checked in! Event unlocked." });
        }

        // Insert Attendance
        await pool.query(
            `INSERT INTO event_attendance (event_id, user_id, user_type, checked_in_at) 
             VALUES ($1, $2, $3, NOW())`,
            [eventId, dbUserId, userType]
        );

        // Update Registration Status to 'Present' for candidates
        if (userType === 'candidate') {
            await pool.query(
                `UPDATE event_candidate_registrations 
                 SET attendance_status = 'Present' 
                 WHERE event_id = $1 AND candidate_id = $2`,
                [eventId, dbUserId]
            );
        }

        res.json({ success: true, message: "Attendance verified! Event unlocked." });
    } catch (error) {
        console.error("❌ Error marking attendance:", error);
        res.status(500).json({ success: false, message: "Server error marking attendance." });
    }
});

// ==========================================
// 2. CANDIDATE: APPLY/REGISTER FOR AN EVENT
// POST /api/events/apply
// ==========================================
router.post('/apply', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.body.candidateId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate account not found." });
        
        const eventCheck = await pool.query("SELECT status FROM events WHERE id = $1", [req.body.eventId]);
        if (eventCheck.rows.length > 0 && eventCheck.rows[0].status === 'Hold') {
            return res.status(400).json({ success: false, message: "This event is currently on hold." });
        }
        
        const duplicateCheck = await pool.query(
            "SELECT id FROM event_candidate_registrations WHERE event_id = $1 AND (candidate_id::text = $2 OR candidate_id::text = $3)", 
            [req.body.eventId, req.body.candidateId, candCheck.rows[0].id.toString()]
        );
        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: "You have already registered for this event." });
        }
        
        const passId = `BCC-evt-${req.body.eventId}-${Date.now().toString().slice(-5)}`;
        const queueToken = `A-${Math.floor(100 + Math.random() * 900)}`;
        
        try {
            await pool.query(
                "INSERT INTO event_candidate_registrations (event_id, candidate_id, entry_pass_id, queue_token, attendance_status) VALUES ($1, $2, $3, $4, 'Pending')", 
                [req.body.eventId, req.body.candidateId, passId, queueToken]
            );
        } catch (insertError) {
            // Fallback for ID type mismatch
            if (insertError.code === '22P02') {
                await pool.query(
                    "INSERT INTO event_candidate_registrations (event_id, candidate_id, entry_pass_id, queue_token, attendance_status) VALUES ($1, $2, $3, $4, 'Pending')", 
                    [req.body.eventId, candCheck.rows[0].id, passId, queueToken]
                );
            } else throw insertError;
        }
        res.json({ success: true, message: "Successfully registered!", passId, queueToken });
    } catch (error) { 
        console.error("❌ Error applying for event:", error);
        res.status(500).json({ success: false, message: "Server error during event registration." }); 
    }
});

// ==========================================
// 3. PUBLIC: EVENT JOBS PREVIEW
// GET /api/events/:eventId/jobs
// ==========================================
router.get('/:eventId/jobs', async (req, res) => {
    const { eventId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM jobs WHERE event_id = $1 AND status = 'approved' ORDER BY created_at DESC",
            [eventId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching event jobs:", error);
        res.status(500).json({ success: false, message: "Server error fetching event jobs" });
    }
});

// ==========================================
// 4. CANDIDATE: JOIN LIVE INTERVIEW QUEUE
// POST /api/events/queue/join
// ==========================================
router.post('/queue/join', async (req, res) => {
    const { eventId, jobId, employerId, candidateId } = req.body;

    if (!eventId || !jobId || !employerId || !candidateId) {
        return res.status(400).json({ success: false, message: "Missing required queue parameters." });
    }

    try {
        let dbCandId = candidateId;
        const candLookup = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateId.toString()]);
        if (candLookup.rows.length > 0) {
            dbCandId = candLookup.rows[0].id;
        }

        // Prevent duplicate queue entries for the same job
        const existing = await pool.query(
            "SELECT id, token_number, status FROM event_queues WHERE event_id = $1 AND job_id = $2 AND candidate_id = $3 AND status IN ('waiting', 'called')",
            [eventId, jobId, dbCandId]
        );

        if (existing.rows.length > 0) {
            return res.json({ 
                success: true, 
                alreadyInQueue: true, 
                tokenNumber: existing.rows[0].token_number, 
                message: `You are already in line with Token #${existing.rows[0].token_number}!` 
            });
        }

        // Calculate next sequence token number
        const maxTokenRes = await pool.query(
            "SELECT COALESCE(MAX(token_number), 0) as max_token FROM event_queues WHERE event_id = $1 AND job_id = $2",
            [eventId, jobId]
        );
        const nextToken = parseInt(maxTokenRes.rows[0].max_token) + 1;

        await pool.query(
            `INSERT INTO event_queues (event_id, job_id, employer_id, candidate_id, token_number, status, created_at) 
             VALUES ($1, $2, $3, $4, $5, 'waiting', NOW())`,
            [eventId, jobId, employerId, dbCandId, nextToken]
        );

        res.status(201).json({ 
            success: true, 
            tokenNumber: nextToken, 
            message: `Successfully joined queue! Your Token Number is #${nextToken}.` 
        });
    } catch (error) {
        console.error("❌ Error joining event queue:", error);
        res.status(500).json({ success: false, message: "Server error joining queue." });
    }
});

module.exports = router;
