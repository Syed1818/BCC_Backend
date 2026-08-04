const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// ==========================================
// EXHIBITOR PANEL ROUTES
// ==========================================

// 1. Dashboard Stats Endpoint
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

module.exports = router;
