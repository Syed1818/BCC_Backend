const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// =====================================================================
// --- FILE UPLOAD SETUP FOR COMPLIANCE DOCS & BROCHURES ---
// =====================================================================
const uploadDir = path.join(__dirname, '../uploads/employer_docs');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit per file based on spreadsheet
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'));
        }
    }
});

const parseArray = (input) => {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    try { return JSON.parse(input); } catch (e) { return [input]; }
};

// --- EMPLOYER DASHBOARD & ANALYTICS ---
router.get('/:employerId/dashboard', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1) OR LOWER(company_name) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) {
                dbEmpId = lookup.rows[0].id;
            } else {
                return res.status(404).json({ success: false, message: "Employer dashboard not found." });
            }
        }

        const profileRes = await pool.query("SELECT company_name, email FROM employers WHERE id = $1", [dbEmpId]);
        const profile = profileRes.rows.length > 0 ? profileRes.rows[0] : {};

        const activeJobs = await pool.query(`
            SELECT COUNT(j.*) FROM jobs j
            LEFT JOIN events e ON j.event_id::text = e.id::text
            WHERE j.employer_id = $1 
            AND TRIM(LOWER(j.status)) IN ('approved', 'active', 'open')
            AND (e.id IS NULL OR TRIM(LOWER(e.status)) NOT IN ('completed', 'closed', 'expired'))
        `, [dbEmpId]);
        
        const totalApps = await pool.query(`
            SELECT COUNT(ja.*) FROM job_applications ja 
            JOIN jobs j ON ja.job_id = j.id 
            WHERE ja.employer_id = $1
        `, [dbEmpId]);
        
        const interviews = await pool.query(`
            SELECT COUNT(ja.*) FROM job_applications ja 
            JOIN jobs j ON ja.job_id = j.id 
            WHERE ja.employer_id = $1 
            AND TRIM(LOWER(ja.status)) IN ('interview', 'interviewed', 'interview scheduled')
        `, [dbEmpId]);
        
        const offers = await pool.query(`
            SELECT COUNT(ja.*) FROM job_applications ja 
            JOIN jobs j ON ja.job_id = j.id 
            WHERE ja.employer_id = $1 
            AND TRIM(LOWER(ja.status)) IN ('offered', 'hired')
        `, [dbEmpId]);

        const funnelRes = await pool.query(`
            SELECT ja.status, COUNT(ja.*) as count 
            FROM job_applications ja 
            JOIN jobs j ON ja.job_id = j.id 
            WHERE ja.employer_id = $1 
            GROUP BY ja.status
        `, [dbEmpId]);
        
        const funnel = { Applied: 0, Shortlisted: 0, Interview: 0, Offer: 0, Hired: 0 };
        funnelRes.rows.forEach(row => {
            const stat = (row.status || '').trim().toLowerCase();
            if (stat === 'applied') funnel.Applied = parseInt(row.count);
            if (stat === 'shortlisted') funnel.Shortlisted = parseInt(row.count);
            if (stat.includes('interview')) funnel.Interview += parseInt(row.count);
            if (stat === 'offered' || stat === 'offer') funnel.Offer += parseInt(row.count);
            if (stat === 'hired') funnel.Hired += parseInt(row.count);
        });

        const recentApps = await pool.query(`
            SELECT ja.id as application_id, ja.status, ja.applied_at, 
                   COALESCE(c.full_name, 'Candidate') as candidate_name, 
                   ja.candidate_id, j.title as job_title, 
                   FLOOR(RANDOM() * (98 - 75 + 1) + 75) as match_score
            FROM job_applications ja 
            LEFT JOIN candidates c ON ja.candidate_id::text = c.unique_id OR ja.candidate_id::text = c.id::text
            JOIN jobs j ON ja.job_id = j.id
            WHERE ja.employer_id = $1 
            ORDER BY ja.applied_at DESC LIMIT 5
        `, [dbEmpId]);

        const trendRes = await pool.query(`
            WITH dates AS (
                SELECT current_date - i AS day_date
                FROM generate_series(0, 6) i
            )
            SELECT to_char(d.day_date, 'Dy') as day, COUNT(ja.id) as applications
            FROM dates d
            LEFT JOIN job_applications ja ON DATE(ja.applied_at) = d.day_date AND ja.employer_id = $1
            GROUP BY d.day_date
            ORDER BY d.day_date ASC;
        `, [dbEmpId]);

        res.json({ success: true, data: {
            profile,
            kpis: { 
                activeJobs: parseInt(activeJobs.rows[0].count) || 0, 
                applications: parseInt(totalApps.rows[0].count) || 0, 
                interviews: parseInt(interviews.rows[0].count) || 0, 
                offersMade: parseInt(offers.rows[0].count) || 0
            },
            funnelData: funnel, 
            recentApplicants: recentApps.rows,
            chartData: trendRes.rows
        }});
    } catch (error) { 
        console.error("Dashboard Error:", error);
        res.status(500).json({ success: false, message: error.message }); 
    }
});

// --- COMPREHENSIVE PROFILE FETCH & UPDATE ---
router.get('/profile/:employerId', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1) OR LOWER(company_name) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
            else return res.status(404).json({ success: false, message: "Employer profile not found." });
        }

        const result = await pool.query("SELECT * FROM employers WHERE id = $1", [dbEmpId]);
        
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Employer profile not found." });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("❌ Profile Fetch Error:", error);
        res.status(500).json({ success: false, message: "Server error fetching profile." });
    }
});

router.put('/profile/:employerId/photo', async (req, res) => {
    const { employerId } = req.params;
    const { photoUrl } = req.body;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
        }

        await pool.query("UPDATE employers SET photo_url = $1 WHERE id = $2", [photoUrl, dbEmpId]);
        res.json({ success: true, message: "Profile photo saved successfully!" });
    } catch (error) {
        console.error("❌ Error updating employer photo:", error);
        res.status(500).json({ success: false, message: "Server error saving photo." });
    }
});

router.put('/profile/:employerId/update', upload.fields([{ name: 'compliance_doc', maxCount: 1 }, { name: 'brochure', maxCount: 1 }]), async (req, res) => {
    const { employerId } = req.params;
    const data = req.body;
    
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
            else return res.status(404).json({ success: false, message: "Employer not found." });
        }

        const complianceDocUrl = req.files && req.files['compliance_doc'] ? `/uploads/employer_docs/${req.files['compliance_doc'][0].filename}` : null;
        const brochureUrl = req.files && req.files['brochure'] ? `/uploads/employer_docs/${req.files['brochure'][0].filename}` : null;

        const updateFields = [];
        const values = [];
        let queryIndex = 1;

        const fieldsToUpdate = {
            company_name: data.company_name, org_type: data.org_type, legal_structure: data.legal_structure,
            core_sectors: parseArray(data.core_sectors), website: data.website, about_company: data.about_company,
            country: data.country || 'India', pincode: data.pincode, state: data.state, district: data.district,
            taluk: data.taluk, mla_constituency: data.mla_constituency, mp_constituency: data.mp_constituency,
            resident_type: data.resident_type, local_body_details: data.local_body_details, locality_area: data.locality_area,
            current_address: data.current_address, map_link: data.map_link, org_presence: data.org_presence,
            multiple_branches: data.multiple_branches, poc1_title: data.poc1_title, poc1_name: data.poc1_name,
            poc1_designation: data.poc1_designation, poc1_email: data.poc1_email, poc1_phone: data.poc1_phone,
            poc2_title: data.poc2_title, poc2_name: data.poc2_name, poc2_designation: data.poc2_designation,
            poc2_email: data.poc2_email, poc2_phone: data.poc2_phone, employee_strength: data.employee_strength,
            hiring_for: data.hiring_for, hire_pwds: data.hire_pwds, accepted_disabilities: parseArray(data.accepted_disabilities),
            sector_preference: data.sector_preference, preferred_opportunity_types: parseArray(data.preferred_opportunity_types),
            preferred_job_type: data.preferred_job_type, engagement_preference: data.engagement_preference,
            joining_preference: data.joining_preference, preferred_job_location: data.preferred_job_location,
            social_facebook: data.social_facebook, social_instagram: data.social_instagram, social_linkedin: data.social_linkedin,
            social_youtube: data.social_youtube, social_x: data.social_x, social_whatsapp: data.social_whatsapp,
            social_github: data.social_github, notification_preferences: parseArray(data.notification_preferences)
        };

        for (const [key, value] of Object.entries(fieldsToUpdate)) {
            if (value !== undefined) {
                updateFields.push(`${key} = $${queryIndex}`);
                values.push(value);
                queryIndex++;
            }
        }

        if (complianceDocUrl) { updateFields.push(`compliance_doc_url = $${queryIndex}`); values.push(complianceDocUrl); queryIndex++; }
        if (brochureUrl) { updateFields.push(`brochure_url = $${queryIndex}`); values.push(brochureUrl); queryIndex++; }

        if (updateFields.length > 0) {
            values.push(dbEmpId);
            const updateQuery = `UPDATE employers SET ${updateFields.join(', ')} WHERE id = $${queryIndex} RETURNING id`;
            await pool.query(updateQuery, values);
        }

        res.json({ success: true, message: "Profile updated successfully!" });
    } catch (error) {
        console.error("❌ Profile Update Error:", error);
        res.status(500).json({ success: false, message: "Server error updating profile: " + error.message });
    }
});

// --- PROFILE & STALLS ---
router.get('/:employerId/event-stalls', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
            else return res.status(404).json({ success: false, message: "Employer event stalls not found." });
        }

        const result = await pool.query("SELECT id, event_id as \"eventId\", status, payment_status as \"paymentStatus\", applied_at as \"appliedAt\" FROM employer_event_stalls WHERE employer_id = $1", [dbEmpId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching employer event stalls:", error);
        res.status(500).json({ success: false, message: "Server error fetching event stalls." });
    }
});

router.post('/event-stalls/apply', async (req, res) => {
    const { employerId, eventId } = req.body;
    if (!employerId || !eventId) return res.status(400).json({ success: false, message: "Missing employerId or eventId" });

    try {
        let dbEmpId = employerId;
        if (typeof employerId === 'string' && (employerId.includes('@') || isNaN(Number(employerId)))) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
            else return res.status(404).json({ success: false, message: "Employer account not found." });
        }

        const duplicate = await pool.query("SELECT id FROM employer_event_stalls WHERE employer_id = $1 AND event_id = $2", [dbEmpId, eventId]);
        if (duplicate.rows.length > 0) return res.status(400).json({ success: false, message: "You have already applied for a stall at this event." });

        await pool.query(
            `INSERT INTO employer_event_stalls (employer_id, event_id, status, payment_status, applied_at) VALUES ($1, $2, 'pending', 'pending', NOW())`,
            [dbEmpId, eventId]
        );

        return res.json({ success: true, message: "Stall application submitted successfully." });
    } catch (error) {
        console.error("❌ Error applying for stall:", error);
        return res.status(500).json({ success: false, message: "Database Error: " + error.message });
    }
});

// --- JOBS MANAGEMENT ---
router.get('/:employerId/jobs-list', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
            else return res.status(404).json({ success: false, message: "Employer jobs not found." });
        }

        const result = await pool.query("SELECT * FROM jobs WHERE employer_id = $1 ORDER BY created_at DESC", [dbEmpId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching jobs." });
    }
});

router.post('/:employerId/jobs', async (req, res) => {
    const { employerId } = req.params;
    const { title, jobType, location, qualification, experience, salary, skills, vacancies, description, event_id } = req.body;

    try {
        let dbEmpId = employerId;
        let companyName = "Unknown Company";
        
        const lookup = await pool.query("SELECT id, company_name FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
        if (lookup.rows.length > 0) {
            dbEmpId = lookup.rows[0].id;
            companyName = lookup.rows[0].company_name;
        } else {
            return res.status(404).json({ success: false, message: "Employer not found." });
        }

        const initialStatus = event_id ? 'approved' : 'pending';

        const insertQuery = `
            INSERT INTO jobs (
                employer_id, company_name, title, job_type, location, 
                qualification_required, experience_required, salary_range, 
                skills_required, vacancies, description, event_id, status
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) 
            RETURNING *;
        `;
        
        const values = [
            dbEmpId, companyName, title, jobType || 'Full-time', location, qualification, experience, salary, 
            JSON.stringify(skills || []), vacancies || 1, description || '', event_id || null, initialStatus
        ];

        const result = await pool.query(insertQuery, values);
        res.status(201).json({ success: true, message: "Job posted successfully", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error posting job:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/jobs/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const { title, jobType, location, qualification, experience, salary, skills, vacancies, description, event_id } = req.body;

    try {
        const updateQuery = `
            UPDATE jobs SET 
                title = $1, job_type = $2, location = $3, qualification_required = $4, experience_required = $5, 
                salary_range = $6, skills_required = $7, vacancies = $8, description = $9, event_id = $10, status = 'pending'
            WHERE id = $11 RETURNING *;
        `;
        
        const values = [
            title, jobType, location, qualification, experience, salary, 
            JSON.stringify(skills || []), vacancies || 1, description || '', event_id || null, jobId
        ];

        const result = await pool.query(updateQuery, values);
        res.json({ success: true, message: "Job updated", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error updating job:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.delete('/jobs/:jobId', async (req, res) => {
    try {
        await pool.query("DELETE FROM jobs WHERE id = $1", [req.params.jobId]);
        res.json({ success: true, message: "Job deleted successfully." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to delete job." });
    }
});

router.put('/jobs/:jobId/close', async (req, res) => {
    const { jobId } = req.params;
    const { employerId } = req.body;
    try {
        const result = await pool.query("UPDATE jobs SET status = 'closed' WHERE id = $1 AND employer_id = $2 RETURNING id, title, status", [jobId, employerId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Job not found or unauthorized." });
        res.json({ success: true, message: `Job "${result.rows[0].title}" has been closed.`, data: result.rows[0] });
    } catch (error) {
        console.error("❌ Close Job Error:", error);
        res.status(500).json({ success: false, message: "Server error closing job." });
    }
});

router.put('/jobs/:jobId/reactivate', async (req, res) => {
    const { jobId } = req.params;
    const { employerId } = req.body;
    try {
        const result = await pool.query("UPDATE jobs SET status = 'approved', created_at = CURRENT_TIMESTAMP WHERE id = $1 AND employer_id = $2 RETURNING id, title", [jobId, employerId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Job not found or unauthorized." });
        res.json({ success: true, message: `Job "${result.rows[0].title}" reactivated successfully.` });
    } catch (error) {
        console.error("❌ Job Reactivation Error:", error);
        res.status(500).json({ success: false, message: "Server error reactivating job." });
    }
});

// --- SUB-HR MANAGEMENT ---
router.get('/:employerId/hrs', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
            else return res.status(404).json({ success: false, message: "Employer not found." });
        }

        const result = await pool.query("SELECT id, full_name as \"fullName\", email, created_at as \"createdAt\" FROM employer_hrs WHERE employer_id = $1 ORDER BY created_at DESC", [dbEmpId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching HR members:", error);
        res.status(500).json({ success: false, message: "Server error fetching HR members." });
    }
});

router.post('/:employerId/hrs', async (req, res) => {
    const { employerId } = req.params;
    const { fullName, email, password } = req.body;
    if (!fullName || !email || !password) return res.status(400).json({ success: false, message: "Full Name, Email, and Password are required." });

    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
            else return res.status(404).json({ success: false, message: "Employer not found." });
        }

        const countCheck = await pool.query("SELECT COUNT(*) FROM employer_hrs WHERE employer_id = $1", [dbEmpId]);
        if (parseInt(countCheck.rows[0].count) >= 3) return res.status(400).json({ success: false, message: "Maximum limit of 3 HR members reached." });

        const cleanEmail = email.trim().toLowerCase();
        const emailCheck = await pool.query("SELECT id FROM employer_hrs WHERE LOWER(email) = $1", [cleanEmail]);
        if (emailCheck.rows.length > 0) return res.status(400).json({ success: false, message: "An HR member with this email already exists." });

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        await pool.query("INSERT INTO employer_hrs (employer_id, full_name, email, password_hash) VALUES ($1, $2, $3, $4)", [dbEmpId, fullName.trim(), cleanEmail, passwordHash]);
        res.status(201).json({ success: true, message: "HR member added successfully." });
    } catch (error) {
        console.error("❌ Error adding HR member:", error);
        res.status(500).json({ success: false, message: "Server error adding HR member." });
    }
});

router.delete('/hrs/:hrId', async (req, res) => {
    const { hrId } = req.params;
    try {
        const result = await pool.query("DELETE FROM employer_hrs WHERE id = $1 RETURNING id", [hrId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "HR member not found." });
        res.json({ success: true, message: "HR member removed successfully." });
    } catch (error) {
        console.error("❌ Error removing HR member:", error);
        res.status(500).json({ success: false, message: "Server error removing HR member." });
    }
});

// =====================================================================
// --- LIVE QUEUE & APPLICATIONS (NEW EVENT TOKEN PIPELINE) ---
// =====================================================================

// UPDATED: Filters out completed/closed events
router.get('/:employerId/job-options', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
            else return res.status(404).json({ success: false, message: "Employer not found." });
        }

        // Only select active jobs tied to active/open events
        const result = await pool.query(`
            SELECT j.id, j.title, j.location, j.company_name, j.event_id 
            FROM jobs j
            JOIN events e ON j.event_id::text = e.id::text
            WHERE j.employer_id = $1
            AND j.event_id IS NOT NULL 
            AND j.event_id::text != '' 
            AND j.event_id::text != '0'
            AND TRIM(LOWER(j.status)) IN ('approved', 'active', 'open')
            AND TRIM(LOWER(e.status)) NOT IN ('completed', 'closed', 'expired')
            ORDER BY j.created_at DESC
        `, [dbEmpId]);

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching job options:", error);
        res.status(500).json({ success: false, message: "Server error fetching jobs." });
    }
});

router.get('/jobs/:jobId/applications', async (req, res) => {
    const { jobId } = req.params;
    try {
        const result = await pool.query(`
            SELECT ja.id as application_id, ja.status as app_status, ja.applied_at,
                   c.unique_id, c.full_name, c.email, c.phone, c.highest_qualification, c.experience_type,
                   c.skills, c.resume_file_name, 85 as "matchScore"
            FROM job_applications ja
            JOIN candidates c ON ja.candidate_id::text = c.id::text OR ja.candidate_id::text = c.unique_id
            WHERE ja.job_id::text = $1::text
            ORDER BY ja.applied_at DESC
        `, [jobId]);

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching job applications:", error);
        res.status(500).json({ success: false, message: "Server error fetching applications." });
    }
});

// NEW: STATUS UPDATER & TOKEN GENERATOR
router.put('/applications/:appId/status', async (req, res) => {
    const { appId } = req.params;
    const { status } = req.body;

    try {
        // 1. Update the application status
        const updateRes = await pool.query(
            "UPDATE job_applications SET status = $1 WHERE id = $2 RETURNING candidate_id, job_id, status",
            [status, appId]
        );
        
        if (updateRes.rows.length === 0) return res.status(404).json({ success: false, message: "Application not found." });
        const app = updateRes.rows[0];

        // 2. If status is 'Interview', Auto-Generate a Queue Token
        if (status === 'Interview') {
            const jobRes = await pool.query("SELECT event_id FROM jobs WHERE id = $1", [app.job_id]);
            const eventId = jobRes.rows[0]?.event_id;
            
            if (eventId) {
                // Ensure we get the correct internal candidate ID to prevent foreign key errors
                const candRes = await pool.query("SELECT id FROM candidates WHERE id::text = $1 OR unique_id = $1", [app.candidate_id]);
                const realCandidateId = candRes.rows.length > 0 ? candRes.rows[0].id : null;

                if (realCandidateId) {
                    // Prevent duplicate tokens for the same job and candidate
                    const existing = await pool.query("SELECT id FROM event_queues WHERE candidate_id = $1 AND job_id = $2", [realCandidateId, app.job_id]);
                    
                    if (existing.rows.length === 0) {
                        // Generate next token number
                        const tokenRes = await pool.query("SELECT COALESCE(MAX(token_number), 0) + 1 as next_token FROM event_queues WHERE event_id = $1 AND job_id = $2", [eventId, app.job_id]);
                        const nextToken = tokenRes.rows[0].next_token;
                        
                        // Insert into live queue
                        await pool.query(
                            "INSERT INTO event_queues (event_id, job_id, candidate_id, token_number, status) VALUES ($1, $2, $3, $4, 'waiting')",
                            [eventId, app.job_id, realCandidateId, nextToken]
                        );
                    }
                }
            }
        }
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (error) {
        console.error("❌ Status Update Error:", error);
        res.status(500).json({ success: false, message: "Server error updating status." });
    }
});

// UPGRADED: LIVE QUEUE FETCH WITH APPLICATION DATA
router.get('/:employerId/events/:eventId/queue', async (req, res) => {
    const { eventId } = req.params;
    const { jobId } = req.query;

    try {
        let query = `
            SELECT q.id, q.token_number as "tokenNumber", q.status, q.called_at as "calledAt", 
                   q.timer_expires_at as "timerExpiresAt", c.full_name as "candidateName", 
                   c.phone, c.highest_qualification as qualification, j.title as "jobTitle",
                   ja.id as "applicationId", ja.status as "appStatus"
            FROM event_queues q
            JOIN candidates c ON q.candidate_id = c.id
            JOIN jobs j ON q.job_id = j.id
            LEFT JOIN job_applications ja ON (ja.candidate_id::text = c.id::text OR ja.candidate_id::text = c.unique_id) AND ja.job_id = j.id
            WHERE q.event_id = $1
        `;
        let params = [eventId];

        if (jobId) {
            query += ` AND q.job_id = $2`;
            params.push(jobId);
        }

        query += ` ORDER BY q.token_number ASC`;

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching employer queue:", error);
        res.status(500).json({ success: false, message: "Server error fetching queue." });
    }
});

router.post('/queue/call-next', async (req, res) => {
    const { eventId, jobId } = req.body;
    if (!eventId || !jobId) return res.status(400).json({ success: false, message: "Missing eventId or jobId." });

    try {
        const activeCalled = await pool.query("SELECT id, token_number FROM event_queues WHERE event_id = $1 AND job_id = $2 AND status = 'called'", [eventId, jobId]);
        if (activeCalled.rows.length > 0) return res.status(400).json({ success: false, message: `Token #${activeCalled.rows[0].token_number} is already active. Complete or mark them as No-Show first.` });

        const nextInLine = await pool.query("SELECT id, token_number FROM event_queues WHERE event_id = $1 AND job_id = $2 AND status = 'waiting' ORDER BY token_number ASC LIMIT 1", [eventId, jobId]);
        if (nextInLine.rows.length === 0) return res.status(404).json({ success: false, message: "No candidates currently waiting in queue." });

        const targetId = nextInLine.rows[0].id;
        const targetToken = nextInLine.rows[0].token_number;

        const updated = await pool.query(`UPDATE event_queues SET status = 'called', called_at = NOW(), timer_expires_at = NOW() + INTERVAL '5 minutes' WHERE id = $1 RETURNING id, token_number, status, timer_expires_at as "timerExpiresAt"`, [targetId]);

        res.json({ success: true, message: `Called Token #${targetToken}! 5-minute timer started.`, data: updated.rows[0] });
    } catch (error) {
        console.error("❌ Error calling next candidate:", error);
        res.status(500).json({ success: false, message: "Server error calling next candidate." });
    }
});

router.put('/queue/:queueId/status', async (req, res) => {
    const { queueId } = req.params;
    const { status } = req.body;
    if (!['completed', 'missed', 'waiting', 'called'].includes(status)) return res.status(400).json({ success: false, message: "Invalid status value." });

    try {
        const result = await pool.query("UPDATE event_queues SET status = $1 WHERE id = $2 RETURNING id, token_number, status", [status, queueId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Queue entry not found." });

        res.json({ success: true, message: `Queue status updated to ${status}.`, data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error updating queue status:", error);
        res.status(500).json({ success: false, message: "Server error updating queue status." });
    }
});

module.exports = router;
