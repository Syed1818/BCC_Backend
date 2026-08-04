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

module.exports = router;
