const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// --- CANDIDATE PROFILE & DETAILS ---
router.get('/:id/saved-jobs', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id, unique_id FROM candidates WHERE unique_id = $1 OR id::text = $1", [req.params.id]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });

        const candidateDbId = candCheck.rows[0].id;

        const result = await pool.query(`
            SELECT sj.id as saved_id, sj.status, sj.updated_at, j.id as job_id, j.title, j.company_name, j.location, j.job_type, j.salary_range, j.qualification_required
            FROM candidate_saved_jobs sj
            JOIN jobs j ON sj.job_id = j.id
            WHERE sj.candidate_id = $1
            ORDER BY sj.updated_at DESC
        `, [candidateDbId]);

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching saved jobs:", error);
        res.status(500).json({ success: false, message: "Database error fetching saved jobs: " + error.message });
    }
});

router.post('/saved-jobs/toggle', async (req, res) => {
    const { candidateId, jobId, draftData } = req.body;
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [candidateId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });

        const dbCandId = candCheck.rows[0].id;

        const existing = await pool.query(
            "SELECT id FROM candidate_saved_jobs WHERE candidate_id = $1 AND job_id = $2",
            [dbCandId, jobId]
        );

        if (existing.rows.length > 0) {
            await pool.query("DELETE FROM candidate_saved_jobs WHERE id = $1", [existing.rows[0].id]);
            return res.json({ success: true, saved: false, message: "Job removed from saved list." });
        } else {
            await pool.query(
                "INSERT INTO candidate_saved_jobs (candidate_id, job_id, status, draft_data) VALUES ($1, $2, 'saved', $3)",
                [dbCandId, jobId, draftData ? JSON.stringify(draftData) : null]
            );
            return res.json({ success: true, saved: true, message: "Job saved successfully!" });
        }
    } catch (error) {
        console.error("Error toggling saved job:", error);
        res.status(500).json({ success: false, message: "Server error toggling saved job." });
    }
});

router.delete('/saved-jobs/:savedId', async (req, res) => {
    try {
        await pool.query("DELETE FROM candidate_saved_jobs WHERE id = $1", [req.params.savedId]);
        res.json({ success: true, message: "Saved job removed." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to remove saved job." });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM candidates WHERE unique_id = $1 OR id::text = $1", 
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found" });
        
        const dbUser = result.rows[0];
        res.status(200).json({ 
            success: true, 
            data: { 
                uniqueId: dbUser.unique_id, 
                fullName: dbUser.full_name, 
                email: dbUser.email, 
                phone: dbUser.phone, 
                qualification: dbUser.highest_qualification || "N/A", 
                experienceType: dbUser.experience_type || "Fresher", 
                skills: typeof dbUser.skills === 'string' ? JSON.parse(dbUser.skills) : (dbUser.skills || []), 
                completion: 95 
            } 
        });
    } catch (error) { 
        res.status(500).json({ success: false, message: error.message }); 
    }
});

router.get('/profile/:id', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM candidates WHERE unique_id = $1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });
        const dbUser = result.rows[0];
        res.json({ success: true, data: {
            uniqueId: dbUser.unique_id, fullName: dbUser.full_name, email: dbUser.email, phone: dbUser.phone, dob: dbUser.dob ? new Date(dbUser.dob).toISOString().split('T')[0] : "", gender: dbUser.gender, language: dbUser.preferred_language, category: dbUser.category,
            state: dbUser.state, district: dbUser.district, taluk: dbUser.taluk, pincode: dbUser.pincode, qualification: dbUser.highest_qualification, institution: dbUser.institution, schoolName: dbUser.school_name,
            course: dbUser.course, specialization: dbUser.specialization, yearOfPassing: dbUser.year_of_passing, percentage: dbUser.percentage_cgpa, languagesFluent: dbUser.languages_fluent || [], skills: dbUser.skills || [],
            experienceType: dbUser.experience_type, yearsOfExperience: dbUser.years_of_experience, employmentStatus: dbUser.employment_status, currentRole: dbUser.current_job_role, currentCompany: dbUser.current_company,
            resumeFileName: dbUser.resume_file_name, preferredRoles: dbUser.preferred_roles || [], preferredLocations: dbUser.preferred_locations || [],
            preferredJobType: dbUser.preferred_job_type, expectedSalary: dbUser.expected_salary, willingToRelocate: dbUser.willing_to_relocate
        }});
    } catch (e) { res.status(500).json({ success: false }); }
});

router.put('/profile/update', async (req, res) => {
    const data = req.body;
    try {
        await pool.query(`
            UPDATE candidates SET full_name=$1, email=$2, phone=$3, dob=$4, gender=$5, preferred_language=$6, category=$7, state=$8, district=$9, taluk=$10, pincode=$11,
            highest_qualification=$12, institution=$13, school_name=$14, course=$15, specialization=$16, year_of_passing=$17, percentage_cgpa=$18, languages_fluent=$19,
            skills=$20, experience_type=$21, years_of_experience=$22, employment_status=$23, current_job_role=$24, current_company=$25,
            resume_file_name=$26, preferred_roles=$27, preferred_locations=$28, willing_to_relocate=$29, preferred_job_type=$30, expected_salary=$31 WHERE unique_id=$32
        `, [
            data.fullName, data.email, data.phone, data.dob || null, data.gender, data.language, data.category, data.state, data.district, data.taluk, data.pincode, data.qualification, data.institution, data.schoolName, data.course, data.specialization, data.yearOfPassing, data.percentage, JSON.stringify(data.languagesFluent || []),
            JSON.stringify(data.skills || []), data.experienceType, data.yearsOfExperience, data.employmentStatus, data.currentRole, data.currentCompany,
            data.resumeFileName, JSON.stringify(data.preferredRoles || []), JSON.stringify(data.preferredLocations || []), data.willing_to_relocate || false, data.preferredJobType, data.expectedSalary, data.uniqueId
        ]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- WITHDRAW APPLICATION ROUTE ---
router.post('/:id/jobs/:jobId/withdraw', async (req, res) => {
    try {
        const candidateStringId = req.params.id;
        const jobId = req.params.jobId;

        const profileResult = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateStringId]);
        let candidateIntId = 0;
        if (profileResult.rows.length > 0) {
            candidateIntId = profileResult.rows[0].id;
        }

        // Delete the application securely
        await pool.query(
            "DELETE FROM job_applications WHERE job_id = $1 AND (candidate_id::text = $2 OR candidate_id::text = $3)",
            [jobId, candidateStringId, candidateIntId.toString()]
        );

        res.json({ success: true, message: "Application withdrawn successfully." });
    } catch (err) {
        console.error("❌ Withdraw error:", err);
        res.status(500).json({ success: false, message: "Server error withdrawing application." });
    }
});


// --- GLOBAL JOB BOARD (STRICTLY EVENT JOBS ONLY) ---
router.get('/:id/jobs', async (req, res) => {
    try {
        const candidateStringId = req.params.id;

        // 1. Fetch Candidate Profile 
        const profileResult = await pool.query(
            "SELECT * FROM candidates WHERE unique_id = $1 OR id::text = $1", 
            [candidateStringId]
        );
        
        let candidateProfile = null;
        let candidateIntId = 0; 
        
        if (profileResult.rows.length > 0) {
            candidateProfile = profileResult.rows[0];
            candidateIntId = candidateProfile.id; // DB expects an Integer
        }

        // 2. Fetch ONLY Jobs linked to an Event
        // INNER JOIN events completely removes normal jobs from this list.
        const jobsQuery = `
            SELECT 
                j.*, 
                e.name as event_name,
                CASE WHEN a.id IS NOT NULL THEN true ELSE false END as has_applied,
                a.status as application_status
            FROM jobs j
            INNER JOIN events e 
                ON j.event_id = e.id
            LEFT JOIN job_applications a 
                ON j.id = a.job_id AND (a.candidate_id::text = $1 OR a.candidate_id::text = $2)
            WHERE j.status = 'Open' OR j.status = 'Active' OR j.status = 'approved' OR j.status IS NULL
            ORDER BY j.created_at DESC;
        `;

        const jobsResult = await pool.query(jobsQuery, [candidateStringId, candidateIntId.toString()]);
        let jobs = jobsResult.rows;

        // 3. Fetch Saved Jobs
        let savedJobIds = new Set();
        if (candidateProfile) {
            try {
                const savedRes = await pool.query("SELECT job_id FROM candidate_saved_jobs WHERE candidate_id = $1", [candidateIntId]);
                savedJobIds = new Set(savedRes.rows.map(r => r.job_id));
            } catch(err) {}
        }

        // 4. Process jobs: Parse JSON and compute match score
        const processedJobs = jobs.map(job => {
            let jobSkills = [];
            try {
                if (typeof job.skills === 'string') jobSkills = JSON.parse(job.skills);
                else if (typeof job.skills_required === 'string') jobSkills = JSON.parse(job.skills_required);
                else if (Array.isArray(job.skills)) jobSkills = job.skills;
                else if (Array.isArray(job.skills_required)) jobSkills = job.skills_required;
            } catch(e) {}

            let matchScore = 50; 

            if (candidateProfile) {
                let matchedWeights = 0;
                let totalWeights = 4;

                // Location
                let candLocations = [];
                try { candLocations = JSON.parse(candidateProfile.preferred_locations || "[]"); } catch(e){}
                if (
                    candLocations.includes(job.location) || 
                    candLocations.includes("Remote") || 
                    job.location === "Remote" ||
                    (job.location && candLocations.some(loc => job.location.toLowerCase().includes(loc.toLowerCase())))
                ) { matchedWeights += 1; }

                // Job Type
                if (candidateProfile.preferred_job_type && job.job_type && candidateProfile.preferred_job_type.toLowerCase() === job.job_type.toLowerCase()) {
                    matchedWeights += 1;
                }

                // Education
                const jobQual = job.qualification_required || job.qualification || "";
                if (candidateProfile.highest_qualification && jobQual && candidateProfile.highest_qualification.toLowerCase() === jobQual.toLowerCase()) {
                    matchedWeights += 1;
                } else if (!jobQual || jobQual.toLowerCase() === 'any degree' || jobQual.toLowerCase() === 'any') {
                    matchedWeights += 1;
                }

                // Skills
                let candSkills = [];
                try { 
                    candSkills = JSON.parse(candidateProfile.technical_skills || "[]").concat(JSON.parse(candidateProfile.non_technical_skills || "[]")); 
                    if (candSkills.length === 0 && candidateProfile.skills) candSkills = JSON.parse(candidateProfile.skills || "[]");
                } catch(e){}

                if (jobSkills.length === 0) {
                     matchedWeights += 1; 
                } else if (candSkills.length > 0) {
                     const lowerCandSkills = candSkills.map(s => s.toLowerCase());
                     const overlap = jobSkills.filter(s => lowerCandSkills.includes(s.toLowerCase()));
                     if (overlap.length > 0) matchedWeights += (overlap.length / jobSkills.length);
                }

                matchScore = Math.round((matchedWeights / totalWeights) * 100);
            }

            return {
                id: job.id,
                company: job.company_name || job.company,
                title: job.title,
                type: job.job_type || job.type,
                location: job.location,
                qualification: job.qualification_required || job.qualification,
                experience: job.experience_required || job.experience,
                salary: job.salary_range || job.salary,
                skills: jobSkills,
                event_name: job.event_name,
                hasApplied: job.has_applied,
                status: job.application_status || job.status,
                matchScore: matchScore > 0 ? matchScore : 15,
                isSaved: savedJobIds.has(job.id)
            };
        }).sort((a, b) => b.matchScore - a.matchScore);

        res.json({ success: true, data: processedJobs });
    } catch (error) {
        console.error("❌ Exact SQL Error Fetching Jobs:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching jobs." });
    }
});

// --- APPLICATIONS & EVENTS (CRASH-PROOF & FIXED) ---
router.get('/:id/applications', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.params.id]);
        const candidateIntId = candCheck.rows.length > 0 ? candCheck.rows[0].id : 0;
        
        const result = await pool.query(`
            SELECT 
                ja.id as application_id, 
                j.title as job_title, 
                j.company_name as company, 
                ja.applied_at, 
                ja.status, 
                j.employer_id, 
                j.id as job_id, 
                CASE WHEN j.event_id::text = '0' THEN NULL ELSE j.event_id END as event_id, 
                COALESCE(e.name, e.event_name) as event_name,
                e.event_date,
                e.venue_address,
                e.city,
                e.start_time,
                e.end_time
            FROM job_applications ja 
            JOIN jobs j ON ja.job_id = j.id 
            LEFT JOIN events e ON j.event_id = e.id
            WHERE ja.candidate_id::text = $1 OR ja.candidate_id::text = $2 
            ORDER BY ja.applied_at DESC
        `, [req.params.id, candidateIntId.toString()]);
        
        res.json({ success: true, data: result.rows });
    } catch (error) { 
        console.error("❌ Error fetching candidate applications:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching applications." }); 
    }
});

router.get('/:id/events', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.params.id]);
        const candidateIntId = candCheck.rows.length > 0 ? candCheck.rows[0].id : 0;
        const result = await pool.query(`
            SELECT e.*, r.entry_pass_id, r.queue_token, r.attendance_status, r.registered_at FROM events e
            LEFT JOIN event_candidate_registrations r ON e.id = r.event_id AND (r.candidate_id::text = $1 OR r.candidate_id::text = $2)
            WHERE (e.status IS NULL OR e.status != 'Deleted') OR r.id IS NOT NULL ORDER BY e.id DESC
        `, [req.params.id, candidateIntId.toString()]);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.get('/:id/interviews', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.params.id]);
        const candidateIntId = candCheck.rows.length > 0 ? candCheck.rows[0].id : 0;
        const result = await pool.query(`
            SELECT i.id as interview_id, i.interview_type, i.interview_date, i.interview_time, i.location_or_link, i.status as interview_status, ja.id as application_id, j.title as job_title, j.company_name
            FROM interviews i JOIN job_applications ja ON i.application_id = ja.id JOIN jobs j ON ja.job_id = j.id
            WHERE (ja.candidate_id::text = $1 OR ja.candidate_id::text = $2) ORDER BY i.interview_date ASC, i.interview_time ASC
        `, [req.params.id, candidateIntId.toString()]);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.get('/:id/history', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.params.id]);
        if (candCheck.rows.length === 0) return res.json({ success: true, data: [] });
        const result = await pool.query("SELECT * FROM candidate_activity_logs WHERE candidate_id = $1 ORDER BY created_at DESC", [candCheck.rows[0].id]);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.post('/history/log', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.body.candidateId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false });
        await pool.query("INSERT INTO candidate_activity_logs (candidate_id, action_type, title, description) VALUES ($1, $2, $3, $4)", [candCheck.rows[0].id, req.body.actionType, req.body.title, req.body.description]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.delete('/:id/history', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.params.id]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false });
        await pool.query("DELETE FROM candidate_activity_logs WHERE candidate_id = $1", [candCheck.rows[0].id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.post('/feedback', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.body.candidateId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false });
        await pool.query("INSERT INTO candidate_feedback (candidate_id, overall_rating, registration_exp, interview_quality, event_management, video_url) VALUES ($1, $2, $3, $4, $5, $6)", 
        [candCheck.rows[0].id, req.body.rating, req.body.registrationExp, req.body.interviewQuality, req.body.eventManagement, req.body.videoUrl]);
        res.json({ success: true, message: "Feedback submitted successfully!" });
    } catch (error) { res.status(500).json({ success: false }); }
});

module.exports = router;
