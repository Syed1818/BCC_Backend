const express = require('express');
const router = express.Router();
const pool = require('../config/db'); // Use your shared DB pool connection

// ==========================================
// 1. CANDIDATE: APPLY FOR A JOB
// POST /api/applications/apply
// ==========================================
router.post('/apply', async (req, res) => {
    const { jobId, candidateId, employerId, resumeReplaced, newResumeName } = req.body;

    // Basic validation to ensure we have the required IDs
    if (!jobId || !candidateId || !employerId) {
        return res.status(400).json({ 
            success: false, 
            message: "Missing required fields (jobId, candidateId, or employerId)." 
        });
    }

    try {
        // 1. Check if the candidate has already applied for this specific job
        const checkDuplicate = await pool.query(
            "SELECT * FROM job_applications WHERE job_id = $1 AND (candidate_id::text = $2 OR candidate_id::text = $3)", 
            [jobId, candidateId, candidateId.toString()]
        );

        if (checkDuplicate.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: "You have already applied for this job." 
            });
        }

        // 2. Insert the new job application with a default status of 'Applied'
        // If they uploaded a new resume, we can log it in the database notes (optional)
        const notes = resumeReplaced ? `Custom Resume Attached: ${newResumeName}` : null;

        await pool.query(
            "INSERT INTO job_applications (job_id, candidate_id, employer_id, status, notes) VALUES ($1, $2, $3, 'Applied', $4)", 
            [jobId, candidateId, employerId, notes]
        );

        res.status(200).json({ 
            success: true, 
            message: "Application submitted successfully!" 
        });
        
    } catch (error) { 
        console.error("❌ Error applying for job:", error);
        res.status(500).json({ 
            success: false, 
            message: "Server error during application submission." 
        }); 
    }
});

module.exports = router;
