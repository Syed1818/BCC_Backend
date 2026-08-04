const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// ==========================================
// EXHIBITOR PANEL ROUTES
// ==========================================

// 1. Dashboard Data (Skeleton)
router.get('/dashboard/:id', async (req, res) => {
    try {
        // We will add the actual dashboard stats query here later
        res.json({ success: true, message: "Exhibitor dashboard connected" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

module.exports = router;
