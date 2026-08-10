const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// --- AWS SES Integration ---
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const sesClient = new SESClient({ region: 'ap-south-1' });
const attendanceOtpStore = new Map(); // In-memory OTP storage for check-ins

// ==========================================
// 1. REQUEST OTP FOR ATTENDANCE
// POST /api/events/qr/request-otp
// ==========================================
router.post('/qr/request-otp', async (req, res) => {
    const { email, role } = req.body;
    
    if (!email || !role) {
        return res.status(400).json({ success: false, message: "Email and role are required." });
    }

    const cleanEmail = email.toLowerCase().trim();
    let userFound = false;
    let userName = "User";

    try {
        // Check database to ensure the email exists for the chosen role
        if (role === 'candidate') {
            const resDb = await pool.query("SELECT full_name FROM candidates WHERE LOWER(email) = $1", [cleanEmail]);
            if (resDb.rows.length > 0) { userFound = true; userName = resDb.rows[0].full_name; }
        } else if (role === 'employer') {
            const resDb = await pool.query("SELECT company_name FROM employers WHERE LOWER(email) = $1", [cleanEmail]);
            if (resDb.rows.length > 0) { userFound = true; userName = resDb.rows[0].company_name; }
        } else if (role === 'exhibitor') {
            const resDb = await pool.query("SELECT company_name FROM exhibitors WHERE LOWER(email) = $1", [cleanEmail]);
            if (resDb.rows.length > 0) { userFound = true; userName = resDb.rows[0].company_name; }
        }

        if (!userFound) {
            return res.status(404).json({ success: false, message: `No registered ${role} found with this email.` });
        }

        // Generate 6-digit OTP and store it in memory for 10 minutes
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        attendanceOtpStore.set(cleanEmail, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });

        // Send Email via AWS SES
        const mailParams = {
            Source: '"Bharat Career Connect" <noreply@nammaudyogamela.com>',
            Destination: { ToAddresses: [cleanEmail] },
            Message: {
                Subject: { Data: 'Event Check-In OTP — Bharat Career Connect' },
                Body: {
                    Html: {
                        Data: `
                            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; border: 1px solid #e0e0e0; border-radius: 8px;">
                                <h2 style="color: #0b1f3a; text-align: center;">Event Check-In</h2>
                                <p>Hello ${userName},</p>
                                <p>Your 6-digit verification code to enter the event is:</p>
                                <div style="background-color: #f4f6f8; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #1B8354; border-radius: 6px; margin: 20px 0;">
                                    ${otp}
                                </div>
                                <p>Show this to the security desk if requested. Valid for 10 minutes.</p>
                            </div>
                        `
                    }
                }
            }
        };

        await sesClient.send(new SendEmailCommand(mailParams));
        return res.json({ success: true, message: `OTP sent successfully to ${cleanEmail}` });

    } catch (error) {
        console.error("OTP Request Error:", error);
        return res.status(500).json({ success: false, message: "Server error sending OTP." });
    }
});

// ==========================================
// 2. VERIFY OTP & FETCH DETAILS
// POST /api/events/qr/verify-otp
// ==========================================
router.post('/qr/verify-otp', async (req, res) => {
    const { email, otp, role } = req.body;
    const cleanEmail = email.toLowerCase().trim();

    const record = attendanceOtpStore.get(cleanEmail);

    if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
        return res.status(400).json({ success: false, message: "Invalid or expired OTP." });
    }

    try {
        let userData = null;

        // Fetch display data to show on the security scanner screen
        if (role === 'candidate') {
            const resDb = await pool.query("SELECT id, unique_id, full_name, email, phone, highest_qualification FROM candidates WHERE LOWER(email) = $1", [cleanEmail]);
            if (resDb.rows.length > 0) {
                const row = resDb.rows[0];
                userData = { id: row.unique_id || row.id, name: row.full_name, email: row.email, phone: row.phone, qual: row.highest_qualification };
            }
        } else if (role === 'employer') {
             const resDb = await pool.query("SELECT id, company_name, email, poc1_phone FROM employers WHERE LOWER(email) = $1", [cleanEmail]);
             if (resDb.rows.length > 0) {
                 const row = resDb.rows[0];
                 userData = { id: `EMP-${row.id}`, name: row.company_name, email: row.email, phone: row.poc1_phone };
             }
        } else if (role === 'exhibitor') {
             const resDb = await pool.query("SELECT id, company_name, email, phone FROM exhibitors WHERE LOWER(email) = $1", [cleanEmail]);
             if (resDb.rows.length > 0) {
                 const row = resDb.rows[0];
                 userData = { id: `EXH-${row.id}`, name: row.company_name, email: row.email, phone: row.phone };
             }
        }

        if (!userData) {
            return res.status(404).json({ success: false, message: "User data could not be retrieved." });
        }

        attendanceOtpStore.delete(cleanEmail); // Clear OTP after success
        return res.json({ success: true, data: userData });

    } catch (error) {
        console.error("Verify Error:", error);
        return res.status(500).json({ success: false, message: "Server error verifying OTP." });
    }
});

// ==========================================
// 3. MARK VENUE ATTENDANCE
// POST /api/events/qr/mark-attendance
// ==========================================
router.post('/qr/mark-attendance', async (req, res) => {
    const { eventId, userId, role } = req.body;

    if (!eventId || !userId) {
        return res.status(400).json({ success: false, message: "Missing event or user details." });
    }

    try {
        let dbUserId = userId;

        // Resolve correct Database ID based on the unique string sent by frontend
        if (role === 'candidate') {
            const candLookup = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [userId.toString()]);
            if (candLookup.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });
            dbUserId = candLookup.rows[0].id;
        } 
        else if (role === 'employer') {
             const empIdStr = userId.toString().replace('EMP-', '');
             const empLookup = await pool.query("SELECT id FROM employers WHERE id::text = $1", [empIdStr]);
             if (empLookup.rows.length === 0) return res.status(404).json({ success: false, message: "Employer not found." });
             dbUserId = empLookup.rows[0].id;
        }
        else if (role === 'exhibitor') {
             const exhIdStr = userId.toString().replace('EXH-', '');
             const exhLookup = await pool.query("SELECT id FROM exhibitors WHERE id::text = $1", [exhIdStr]);
             if (exhLookup.rows.length === 0) return res.status(404).json({ success: false, message: "Exhibitor not found." });
             dbUserId = exhLookup.rows[0].id;
        }

        // Prevent Duplicate Check-ins
        const duplicateCheck = await pool.query(
            "SELECT id FROM event_attendance WHERE event_id = $1 AND user_id = $2 AND user_type = $3", 
            [eventId, dbUserId, role]
        );
        if (duplicateCheck.rows.length > 0) {
            return res.json({ success: true, message: "Already checked in! You may enter." });
        }

        // Insert Attendance Record
        await pool.query(
            `INSERT INTO event_attendance (event_id, user_id, user_type, checked_in_at) 
             VALUES ($1, $2, $3, NOW())`,
            [eventId, dbUserId, role]
        );

        // Also update Registration Status to 'Present' for candidates specifically
        if (role === 'candidate') {
            await pool.query(
                `UPDATE event_candidate_registrations 
                 SET attendance_status = 'Present' 
                 WHERE event_id = $1 AND candidate_id = $2`,
                [eventId, dbUserId]
            );
        }

        return res.json({ success: true, message: "Attendance verified and logged successfully!" });

    } catch (error) {
        console.error("❌ Error marking attendance:", error);
        return res.status(500).json({ success: false, message: "Server error logging attendance." });
    }
});


// ==========================================
// 4. CANDIDATE: APPLY/REGISTER FOR AN EVENT
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
// 5. PUBLIC: EVENT JOBS PREVIEW
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
// 6. CANDIDATE: JOIN LIVE INTERVIEW QUEUE
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
