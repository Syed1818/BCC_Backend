const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// --- SAVED JOBS ---
router.get('/:id/saved-jobs', async (req, res) => {
    try {
        const candidateStringId = req.params.id;
        const candCheck = await pool.query("SELECT id, unique_id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateStringId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });

        const candidateDbId = candCheck.rows[0].id;
        
        const result = await pool.query(`
            SELECT 
                sj.id as saved_id, sj.status as save_status, sj.updated_at, 
                j.id as job_id, j.title, j.company_name as company, j.location, j.job_type as type, j.salary_range as salary, j.qualification_required as qualification,
                j.status as job_status, e.status as event_status, e.name as event_name, j.employer_id,
                CASE WHEN a.id IS NOT NULL THEN true ELSE false END as has_applied
            FROM candidate_saved_jobs sj
            JOIN jobs j ON sj.job_id = j.id
            LEFT JOIN events e ON j.event_id = e.id
            LEFT JOIN job_applications a ON j.id = a.job_id AND (a.candidate_id::text = $1 OR a.candidate_id::text = $2)
            WHERE sj.candidate_id = $2
            ORDER BY sj.updated_at DESC
        `, [candidateStringId, candidateDbId]);

        const formattedJobs = [];
        for (let job of result.rows) {
            const rawJStat = (job.job_status || '').toLowerCase().replace(/[^a-z]/g, '');
            const rawEStat = (job.event_status || '').toLowerCase().replace(/[^a-z]/g, '');

            if (['closed', 'inactive', 'deleted', 'filled', 'expired'].includes(rawJStat)) continue;
            if (['completed', 'closed', 'past', 'ended'].includes(rawEStat)) continue;

            formattedJobs.push({
                ...job,
                id: job.job_id 
            });
        }

        res.json({ success: true, data: formattedJobs });
    } catch (error) {
        console.error("❌ Error fetching saved jobs:", error);
        res.status(500).json({ success: false, message: "Database error fetching saved jobs: " + error.message });
    }
});

router.post('/saved-jobs/toggle', async (req, res) => {
    const { candidateId, jobId, draftData } = req.body;
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateId]);
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

// --- PROFILE ROUTES ---
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM candidates WHERE unique_id = $1 OR id::text = $1", [req.params.id]);
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
        const result = await pool.query("SELECT * FROM candidates WHERE unique_id = $1 OR id::text = $1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });
        const dbUser = result.rows[0];

        const parseJSON = (val, fallback) => {
            if (!val) return fallback;
            if (typeof val === 'object') return val;
            try { return JSON.parse(val); } catch(e) { return fallback; }
        };

        res.json({ success: true, data: {
            uniqueId: dbUser.unique_id, 
            fullName: dbUser.full_name, 
            fatherName: dbUser.father_name,
            motherName: dbUser.mother_name,
            email: dbUser.email, 
            phone: dbUser.phone, 
            aadhaar: dbUser.aadhaar,
            dob: dbUser.dob ? new Date(dbUser.dob).toISOString().split('T')[0] : "", 
            gender: dbUser.gender, 
            religion: dbUser.religion,
            category: dbUser.category,
            linkedinUrl: dbUser.linkedin_url,
            githubUrl: dbUser.github_url,
            hasDisability: dbUser.has_disability,
            udid: dbUser.udid,
            disabilities: parseJSON(dbUser.disabilities, []),
            currentAddress: parseJSON(dbUser.current_address, {}),
            permanentAddress: parseJSON(dbUser.permanent_address, {}),
            state: dbUser.state, 
            district: dbUser.district, 
            taluk: dbUser.taluk, 
            pincode: dbUser.pincode, 
            qualification: dbUser.highest_qualification, 
            institution: dbUser.institution, 
            boardUniversity: dbUser.board_university,
            schoolName: dbUser.school_name,
            course: dbUser.course, 
            specialization: dbUser.specialization, 
            yearOfPassing: dbUser.year_of_passing, 
            percentage: dbUser.percentage_cgpa, 
            languagesFluent: parseJSON(dbUser.languages_fluent, []), 
            skills: parseJSON(dbUser.skills, []),
            technicalSkills: parseJSON(dbUser.technical_skills, []),
            nonTechnicalSkills: parseJSON(dbUser.non_technical_skills, []),
            skillProficiencies: parseJSON(dbUser.skill_proficiencies, {}),
            experienceType: dbUser.experience_type, 
            yearsOfExperience: dbUser.years_of_experience, 
            employmentStatus: dbUser.employment_status, 
            currentRole: dbUser.current_job_role, 
            currentCompany: dbUser.current_company,
            resumeFileName: dbUser.resume_file_name, 
            profilePhoto: dbUser.profile_photo,
            backgroundImage: dbUser.background_image,
            opportunities: parseJSON(dbUser.opportunities, []),
            aspirantType: dbUser.aspirant_type,
            preferredSectors: parseJSON(dbUser.preferred_sectors, []),
            preferredRoles: parseJSON(dbUser.preferred_roles || [], []), 
            preferredLocations: parseJSON(dbUser.preferred_locations || [], []),
            preferredJobType: dbUser.preferred_job_type, 
            expectedSalary: dbUser.expected_salary, 
            willingToRelocate: dbUser.willing_to_relocate
        }});
    } catch (e) { 
        console.error("Profile GET error:", e);
        res.status(500).json({ success: false }); 
    }
});

router.put('/profile/update', async (req, res) => {
    const data = req.body;
    try {
        await pool.query(`
            UPDATE candidates SET 
                full_name=$1, father_name=$2, mother_name=$3, email=$4, phone=$5, aadhaar=$6, dob=$7, gender=$8, religion=$9, category=$10, 
                linkedin_url=$11, github_url=$12, has_disability=$13, udid=$14, disabilities=$15, current_address=$16, permanent_address=$17,
                highest_qualification=$18, institution=$19, board_university=$20, school_name=$21, course=$22, specialization=$23, year_of_passing=$24, percentage_cgpa=$25, 
                languages_fluent=$26, skills=$27, technical_skills=$28, non_technical_skills=$29, skill_proficiencies=$30, 
                experience_type=$31, years_of_experience=$32, employment_status=$33, current_job_role=$34, current_company=$35,
                resume_file_name=$36, profile_photo=$37, background_image=$38, opportunities=$39, aspirant_type=$40, 
                preferred_sectors=$41, preferred_roles=$42, preferred_locations=$43, willing_to_relocate=$44, preferred_job_type=$45, expected_salary=$46 
            WHERE unique_id=$47 OR id::text=$47
        `, [
            data.fullName, data.fatherName || null, data.motherName || null, data.email, data.phone, data.aadhaar || null, data.dob || null, data.gender, data.religion || null, data.category,
            data.linkedinUrl || null, data.githubUrl || null, data.hasDisability || 'No', data.udid || null, JSON.stringify(data.disabilities || []), JSON.stringify(data.currentAddress || {}), JSON.stringify(data.permanentAddress || {}),
            data.qualification, data.institution, data.boardUniversity || null, data.schoolName || null, data.course || null, data.specialization || null, data.yearOfPassing, data.percentage,
            JSON.stringify(data.languagesFluent || []), JSON.stringify(data.skills || []), JSON.stringify(data.technicalSkills || []), JSON.stringify(data.nonTechnicalSkills || []), JSON.stringify(data.skillProficiencies || {}),
            data.experienceType, data.yearsOfExperience || null, data.employmentStatus || null, data.currentRole || null, data.currentCompany || null,
            data.resumeFileName, data.profilePhoto || null, data.backgroundImage || null, JSON.stringify(data.opportunities || []), data.aspirantType || null,
            JSON.stringify(data.preferredSectors || []), JSON.stringify(data.preferredRoles || []), JSON.stringify(data.preferredLocations || []), data.willing_to_relocate || false, data.preferredJobType || null, data.expectedSalary || null, data.uniqueId
        ]);
        res.json({ success: true, message: "Profile updated successfully" });
    } catch (e) { 
        console.error("Profile PUT error:", e);
        res.status(500).json({ success: false, message: e.message }); 
    }
});

router.post('/:id/jobs/:jobId/withdraw', async (req, res) => {
    try {
        const candidateStringId = req.params.id;
        const jobId = req.params.jobId;

        const profileResult = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateStringId]);
        let candidateIntId = 0;
        if (profileResult.rows.length > 0) {
            candidateIntId = profileResult.rows[0].id;
        }

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

// --- GLOBAL JOB BOARD ---
router.get('/:id/jobs', async (req, res) => {
    try {
        const candidateStringId = req.params.id;
        const profileResult = await pool.query("SELECT * FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateStringId]);
        
        let candidateProfile = null;
        let candidateIntId = 0; 
        if (profileResult.rows.length > 0) {
            candidateProfile = profileResult.rows[0];
            candidateIntId = candidateProfile.id;
        }

        const jobsQuery = `
            SELECT j.*, j.status as job_status, e.name as event_name, e.status as event_status,
                CASE WHEN a.id IS NOT NULL THEN true ELSE false END as has_applied,
                a.status as application_status
            FROM jobs j
            LEFT JOIN events e ON j.event_id = e.id
            LEFT JOIN job_applications a ON j.id = a.job_id AND (a.candidate_id::text = $1 OR a.candidate_id::text = $2)
            ORDER BY j.created_at DESC;
        `;

        const jobsResult = await pool.query(jobsQuery, [candidateStringId, candidateIntId.toString()]);
        let jobs = jobsResult.rows;

        let savedJobIds = new Set();
        if (candidateProfile) {
            try {
                const savedRes = await pool.query("SELECT job_id FROM candidate_saved_jobs WHERE candidate_id = $1", [candidateIntId]);
                savedJobIds = new Set(savedRes.rows.map(r => r.job_id));
            } catch(err) {}
        }

        let processedJobs = [];
        
        for (let job of jobs) {
            const rawJStat = (job.job_status || job.status || '').toLowerCase().replace(/[^a-z]/g, '');
            const rawEStat = (job.event_status || '').toLowerCase().replace(/[^a-z]/g, '');

            if (['closed', 'inactive', 'deleted', 'filled', 'expired'].includes(rawJStat)) continue;
            if (['completed', 'closed', 'past', 'ended'].includes(rawEStat)) continue;

            let jobSkills = [];
            try {
                if (typeof job.skills === 'string') jobSkills = JSON.parse(job.skills);
                else if (typeof job.skills_required === 'string') jobSkills = JSON.parse(job.skills_required);
                else if (Array.isArray(job.skills)) jobSkills = job.skills;
                else if (Array.isArray(job.skills_required)) jobSkills = job.skills_required;
            } catch(e) {}

            processedJobs.push({
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
                event_status: job.event_status || 'upcoming',
                job_status: job.job_status || job.status || 'Open',
                hasApplied: job.has_applied,
                status: job.application_status || job.status,
                application_status: job.application_status,
                matchScore: 85,
                isSaved: savedJobIds.has(job.id)
            });
        }

        res.json({ success: true, data: processedJobs });
    } catch (error) {
        console.error("❌ Exact SQL Error Fetching Jobs:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching jobs." });
    }
});

// --- APPLICATIONS ---
router.get('/:id/applications', async (req, res) => {
    try {
        const candidateStringId = req.params.id;
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateStringId]);
        const candidateIntId = candCheck.rows.length > 0 ? candCheck.rows[0].id : 0;
        
        const result = await pool.query(`
            SELECT 
                ja.id as application_id, 
                j.title as job_title, 
                j.company_name as company, 
                j.status as job_status, 
                ja.applied_at, 
                COALESCE(ja.status, 'Applied') as status, 
                j.employer_id, 
                j.id as job_id, 
                CASE WHEN j.event_id::text = '0' THEN NULL ELSE j.event_id END as event_id, 
                e.name as event_name,
                e.status as event_status, 
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
        `, [candidateStringId, candidateIntId.toString()]);
        
        res.json({ success: true, data: result.rows });
    } catch (error) { 
        console.error("❌ Error fetching candidate applications:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching applications." }); 
    }
});

// --- EVENTS ---
router.get('/:id/events', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [req.params.id]);
        const candidateIntId = candCheck.rows.length > 0 ? candCheck.rows[0].id : 0;
        const result = await pool.query(`
            SELECT e.*, r.entry_pass_id, r.queue_token, r.attendance_status, r.registered_at FROM events e
            LEFT JOIN event_candidate_registrations r ON e.id = r.event_id AND (r.candidate_id::text = $1 OR r.candidate_id::text = $2)
            WHERE (e.status IS NULL OR e.status != 'Deleted') OR r.id IS NOT NULL ORDER BY e.id DESC
        `, [req.params.id, candidateIntId.toString()]);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

// --- INTERVIEWS & QUEUE ---
router.get('/:id/interviews', async (req, res) => {
    try {
        const candidateStringId = req.params.id;
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateStringId]);
        const candidateIntId = candCheck.rows.length > 0 ? candCheck.rows[0].id : 0;
        
        // 🚨 ADDED: i.queue_number AND j.live_queue_number 🚨
        const result = await pool.query(`
            SELECT 
                i.id as interview_id, 
                i.interview_type, 
                i.interview_date, 
                i.interview_time, 
                i.location_or_link,
                i.queue_number,
                j.live_queue_number as live_token,
                COALESCE(i.status, 'Scheduled') as interview_status, 
                ja.id as application_id, 
                j.title as job_title, 
                j.company_name,
                e.name as event_name,
                e.venue_address,
                e.city
            FROM interviews i 
            JOIN job_applications ja ON i.application_id = ja.id 
            JOIN jobs j ON ja.job_id = j.id 
            LEFT JOIN events e ON j.event_id = e.id
            WHERE (ja.candidate_id::text = $1 OR ja.candidate_id::text = $2) 
            ORDER BY i.interview_date ASC, i.interview_time ASC
        `, [candidateStringId, candidateIntId.toString()]);
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching interviews:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching interviews." });
    }
});

router.post('/:id/interviews/:interviewId/join-queue', async (req, res) => {
    try {
        const { interviewId } = req.params;
        
        // 1. Find the job associated with this interview
        const jobCheck = await pool.query(`
            SELECT ja.job_id FROM interviews i
            JOIN job_applications ja ON i.application_id = ja.id
            WHERE i.id = $1
        `, [interviewId]);

        if (jobCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Interview not found" });
        const jobId = jobCheck.rows[0].job_id;

        // 2. Find the highest token number currently issued for this specific job stall
        const maxToken = await pool.query(`
            SELECT MAX(i.queue_number) as max_q FROM interviews i
            JOIN job_applications ja ON i.application_id = ja.id
            WHERE ja.job_id = $1
        `, [jobId]);

        // 3. Assign the next available token (If max is 14, they get 15)
        let nextToken = (maxToken.rows[0].max_q || 0) + 1;

        // 4. Save to database
        await pool.query("UPDATE interviews SET queue_number = $1 WHERE id = $2", [nextToken, interviewId]);

        res.json({ success: true, token: nextToken, message: `Successfully joined queue! Your token is ${nextToken}` });
    } catch (error) {
        console.error("❌ Queue error:", error);
        res.status(500).json({ success: false, message: "Failed to join queue." });
    }
});

// --- ACTIVITY HISTORY ---
router.get('/:id/history', async (req, res) => {
    try {
        const candidateStringId = req.params.id;
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateStringId]);
        
        if (candCheck.rows.length === 0) {
            return res.json({ success: true, data: [] });
        }
        
        const candidateDbId = candCheck.rows[0].id;
        const logs = [];

        const apps = await pool.query(`
            SELECT ja.id, j.title, j.company_name, ja.applied_at as created_at 
            FROM job_applications ja 
            JOIN jobs j ON ja.job_id = j.id 
            WHERE ja.candidate_id::text = $1 OR ja.candidate_id::text = $2
        `, [candidateStringId, candidateDbId.toString()]);

        apps.rows.forEach(app => {
            logs.push({
                id: 1000 + app.id,
                action_type: 'Application',
                title: `Applied for ${app.title}`,
                description: `Submitted application to ${app.company_name}`,
                created_at: app.created_at
            });
        });

        const events = await pool.query(`
            SELECT r.id, e.name as event_name, r.registered_at as created_at
            FROM event_candidate_registrations r
            JOIN events e ON r.event_id = e.id
            WHERE r.candidate_id::text = $1 OR r.candidate_id::text = $2
        `, [candidateStringId, candidateDbId.toString()]);

        events.rows.forEach(ev => {
            logs.push({
                id: 5000 + ev.id,
                action_type: 'Event',
                title: `Registered for ${ev.event_name}`,
                description: `Secured entry pass for the job fair event`,
                created_at: ev.created_at
            });
        });

        logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ success: true, data: logs });
    } catch (error) {
        console.error("❌ Error fetching activity history:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching history." });
    }
});

router.delete('/:id/history', async (req, res) => {
    try {
        res.json({ success: true, message: "History cleared successfully." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error clearing history." });
    }
});

// --- CANDIDATE FEEDBACK ROUTE ---
router.post('/feedback', async (req, res) => {
    try {
        const { candidateId, rating, companyName, registrationExp, interviewQuality, eventManagement, messageCategory, optionalComments, videoUrl } = req.body;
        
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateId]);
        if (candCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Candidate not found." });
        }
        
        const dbCandId = candCheck.rows[0].id;

        await pool.query(`
            INSERT INTO candidate_feedback 
            (candidate_id, overall_rating, registration_exp, interview_quality, event_management, company_name, message_category, optional_comments, video_url, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Pending')
        `, [
            dbCandId, 
            rating, 
            registrationExp, 
            interviewQuality, 
            eventManagement, 
            companyName || null, 
            messageCategory || 'general', 
            optionalComments || null, 
            videoUrl || null
        ]);

        res.json({ 
            success: true, 
            message: "Feedback submitted successfully! Sent to employer for verification before publishing." 
        });
    } catch (error) {
        console.error("❌ Feedback submission error:", error.message);
        res.status(500).json({ success: false, message: "Server error submitting feedback: " + error.message });
    }
});
// --- CANDIDATE NOTIFICATIONS ROUTES ---
router.get('/:id/notifications', async (req, res) => {
    try {
        const candidateStringId = req.params.id;
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [candidateStringId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate not found." });
        const candidateDbId = candCheck.rows[0].id;

        const result = await pool.query(`
            SELECT id, title, message, type, is_read, created_at 
            FROM notifications 
            WHERE recipient_id = $1 OR recipient_type = 'all_candidates' OR recipient_type = 'all'
            ORDER BY created_at DESC
        `, [candidateDbId]);

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching candidate notifications:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching notifications." });
    }
});

router.post('/notifications/:id/read', async (req, res) => {
    try {
        const notifId = req.params.id;
        await pool.query("UPDATE notifications SET is_read = true WHERE id = $1", [notifId]);
        res.json({ success: true, message: "Notification marked as read." });
    } catch (error) {
        console.error("❌ Error updating notification:", error.message);
        res.status(500).json({ success: false, message: "Failed to update notification." });
    }
});
module.exports = router;
