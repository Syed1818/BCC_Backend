const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// ==========================================
// EXHIBITOR PANEL ROUTES
// ==========================================

// 1. Dashboard Stats
router.get('/dashboard/:id', async (req, res) => {
    const exhibitorId = req.params.id;
    try {
        res.json({ 
            success: true, 
            data: {
                activeEvents: 1,
                visitorLeads: 0,
                representatives: 0,
                promotions: 0
            }
        });
    } catch (error) {
        console.error("Error fetching exhibitor dashboard:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 2. Fetch Exhibitor Profile Details
router.get('/profile/:id', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, company_name, email, phone, website, gst_number, city, state, address, about_us, logo_url, status FROM exhibitors WHERE id = $1", 
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Exhibitor profile not found" });
        }
        
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error fetching exhibitor profile:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 3. Update Exhibitor Profile Details
router.put('/profile/update', async (req, res) => {
    const { id, company_name, phone, website, gst_number, city, state, address, about_us, logo_url } = req.body;
    try {
        await pool.query(`
            UPDATE exhibitors SET
                company_name = $1,
                phone = $2,
                website = $3,
                gst_number = $4,
                city = $5,
                state = $6,
                address = $7,
                about_us = $8,
                logo_url = $9
            WHERE id = $10
        `, [company_name, phone, website, gst_number, city, state, address, about_us, logo_url || null, id]);

        res.json({ success: true, message: "Profile details updated successfully!" });
    } catch (error) {
        console.error("Error updating exhibitor profile:", error);
        res.status(500).json({ success: false, message: "Server error updating profile" });
    }
});

// 4. Fetch Events & Registration Status
router.get('/:exhibitorId/events', async (req, res) => {
    const { exhibitorId } = req.params;
    try {
        const result = await pool.query(`
            SELECT e.id, e.name, e.event_date, e.event_time, e.event_type, e.city, e.venue_address, e.stall_price, e.poster, e.status as event_status,
                   ees.status as registration_status, ees.payment_status
            FROM events e
            LEFT JOIN exhibitor_event_stalls ees ON e.id = ees.event_id AND ees.exhibitor_id = $1
            WHERE e.status IN ('live', 'upcoming', 'completed')
            ORDER BY e.event_date DESC
        `, [exhibitorId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching events:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 5. Apply for an Event Stall
router.post('/:exhibitorId/events/:eventId/register', async (req, res) => {
    const { exhibitorId, eventId } = req.params;
    try {
        const check = await pool.query("SELECT id FROM exhibitor_event_stalls WHERE exhibitor_id = $1 AND event_id = $2", [exhibitorId, eventId]);
        if (check.rows.length > 0) {
            return res.status(400).json({ success: false, message: "You have already applied for this event." });
        }

        await pool.query(
            "INSERT INTO exhibitor_event_stalls (exhibitor_id, event_id, status) VALUES ($1, $2, 'pending')",
            [exhibitorId, eventId]
        );
        res.json({ success: true, message: "Successfully applied for a stall! Pending admin approval." });
    } catch (error) {
        console.error("Error registering for event:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 6. Fetch Approved Events for Exhibitor (For assigning staff)
router.get('/:exhibitorId/approved-events', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT e.id, e.name 
            FROM events e
            JOIN exhibitor_event_stalls ees ON e.id = ees.event_id
            WHERE ees.exhibitor_id = $1 AND ees.status = 'approved'
        `, [req.params.exhibitorId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 7. Manage Representatives
router.get('/:exhibitorId/representatives', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM exhibitor_representatives WHERE exhibitor_id = $1 ORDER BY created_at DESC", 
            [req.params.exhibitorId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post('/:exhibitorId/representatives', async (req, res) => {
    const { full_name, email, phone, role, assigned_events } = req.body;
    try {
        const result = await pool.query(`
            INSERT INTO exhibitor_representatives (exhibitor_id, full_name, email, phone, role, assigned_events)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
        `, [req.params.exhibitorId, full_name, email, phone, role, JSON.stringify(assigned_events || [])]);
        
        res.json({ success: true, message: "Representative added successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("Error adding rep:", error);
        res.status(500).json({ success: false, message: "Server error adding representative" });
    }
});

router.delete('/representatives/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM exhibitor_representatives WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Representative removed." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 8. Get Exhibitor Branding for a Specific Event
router.get('/:exhibitorId/branding/:eventId', async (req, res) => {
    const { exhibitorId, eventId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM exhibitor_event_branding WHERE exhibitor_id = $1 AND event_id = $2",
            [exhibitorId, eventId]
        );
        res.json({ success: true, data: result.rows[0] || null });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 9. Update Exhibitor Branding
router.put('/:exhibitorId/branding/:eventId', async (req, res) => {
    const { exhibitorId, eventId } = req.params;
    const { brand_color, welcome_message, banner_url } = req.body;
    try {
        const result = await pool.query(`
            INSERT INTO exhibitor_event_branding (exhibitor_id, event_id, brand_color, welcome_message, banner_url)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (exhibitor_id, event_id) 
            DO UPDATE SET brand_color = EXCLUDED.brand_color, welcome_message = EXCLUDED.welcome_message, banner_url = EXCLUDED.banner_url
            RETURNING *;
        `, [exhibitorId, eventId, brand_color, welcome_message, banner_url]);
        
        res.json({ success: true, message: "Branding updated successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("Error updating branding:", error);
        res.status(500).json({ success: false, message: "Server error updating branding" });
    }
});

// 10. Get Materials for an Event
router.get('/:exhibitorId/materials/:eventId', async (req, res) => {
    const { exhibitorId, eventId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM exhibitor_event_materials WHERE exhibitor_id = $1 AND event_id = $2 ORDER BY created_at DESC",
            [exhibitorId, eventId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 11. Add Material
router.post('/:exhibitorId/materials/:eventId', async (req, res) => {
    const { exhibitorId, eventId } = req.params;
    const { title, file_type, file_url } = req.body;
    try {
        const result = await pool.query(`
            INSERT INTO exhibitor_event_materials (exhibitor_id, event_id, title, file_type, file_url)
            VALUES ($1, $2, $3, $4, $5) RETURNING *
        `, [exhibitorId, eventId, title, file_type, file_url]);
        
        res.json({ success: true, message: "Material uploaded successfully!", data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error uploading material" });
    }
});

// 12. Delete Material
router.delete('/materials/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM exhibitor_event_materials WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Material removed." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 13. Fetch Captured Leads
router.get('/:exhibitorId/leads', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT el.*, e.name as event_name 
            FROM exhibitor_leads el
            LEFT JOIN events e ON el.event_id = e.id
            WHERE el.exhibitor_id = $1 
            ORDER BY el.scanned_at DESC
        `, [req.params.exhibitorId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching leads." });
    }
});

// 14. Capture New Lead (QR Scan Simulator)
router.post('/:exhibitorId/leads/scan', async (req, res) => {
    const { exhibitorId } = req.params;
    const { event_id, candidate_id } = req.body;
    
    try {
        // Mocking candidate data retrieval based on the scanned ID
        // In production, this would SELECT from your candidates table
        const mockCandidateName = "Scanned Candidate";
        const mockCandidateEmail = "candidate@example.com";
        const mockCandidatePhone = "9876543210";
        const mockSkills = "Java, React, SQL";

        const result = await pool.query(`
            INSERT INTO exhibitor_leads (exhibitor_id, event_id, candidate_id, candidate_name, candidate_email, candidate_phone, candidate_skills, lead_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'Warm')
            ON CONFLICT (exhibitor_id, event_id, candidate_id) DO NOTHING
            RETURNING *;
        `, [exhibitorId, event_id, candidate_id, mockCandidateName, mockCandidateEmail, mockCandidatePhone, mockSkills]);
        
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: "Lead already captured for this event." });
        }
        
        res.json({ success: true, message: "Lead captured successfully!", data: result.rows[0] });
    } catch (error) {
        console.error("Error capturing lead:", error);
        res.status(500).json({ success: false, message: "Server error capturing lead." });
    }
});

// 15. Update Lead Status and Notes
router.put('/leads/:leadId', async (req, res) => {
    const { lead_status, notes } = req.body;
    try {
        const result = await pool.query(`
            UPDATE exhibitor_leads 
            SET lead_status = $1, notes = $2 
            WHERE id = $3 RETURNING *
        `, [lead_status, notes, req.params.leadId]);
        
        res.json({ success: true, message: "Lead updated successfully", data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error updating lead." });
    }
});

// 16. Fetch Notifications (Specific to Exhibitor + Global Broadcasts)
router.get('/:exhibitorId/notifications', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM exhibitor_notifications 
            WHERE exhibitor_id = $1 OR exhibitor_id IS NULL 
            ORDER BY created_at DESC
        `, [req.params.exhibitorId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching notifications." });
    }
});

// 17. Mark Single Notification as Read
router.put('/notifications/:id/read', async (req, res) => {
    try {
        await pool.query("UPDATE exhibitor_notifications SET is_read = TRUE WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 18. Mark All Notifications as Read
router.put('/:exhibitorId/notifications/read-all', async (req, res) => {
    try {
        await pool.query("UPDATE exhibitor_notifications SET is_read = TRUE WHERE exhibitor_id = $1 OR exhibitor_id IS NULL", [req.params.exhibitorId]);
        res.json({ success: true, message: "All notifications marked as read." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});



module.exports = router;
