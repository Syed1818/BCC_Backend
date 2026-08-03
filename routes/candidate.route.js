// --- GLOBAL JOB BOARD & MATCHING ALGORITHM (FIXED & CRASH-PROOF) ---
router.get('/:id/jobs', async (req, res) => {
    try {
        const candidateStringId = req.params.id;

        // 1. Fetch Candidate Profile (to get Integer ID and logic matching)
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

        // 2. Fetch all Active Jobs. 
        // FIXED: Changed e.name to e.event_name to match your database schema
        const jobsQuery = `
            SELECT 
                j.*, 
                e.event_name, 
                CASE WHEN a.id IS NOT NULL THEN true ELSE false END as has_applied,
                a.status as application_status
            FROM jobs j
            LEFT JOIN job_applications a 
                ON j.id = a.job_id AND (a.candidate_id::text = $1 OR a.candidate_id::text = $2)
            LEFT JOIN events e 
                ON j.event_id = e.id AND j.event_id IS NOT NULL AND j.event_id::text != '0'
            WHERE j.status = 'Open' OR j.status = 'Active' OR j.status = 'approved' OR j.status IS NULL
            ORDER BY j.created_at DESC;
        `;

        const jobsResult = await pool.query(jobsQuery, [candidateStringId, candidateIntId.toString()]);
        let jobs = jobsResult.rows;

        // Fetch saved jobs for bookmark toggles
        let savedJobIds = new Set();
        if (candidateProfile) {
            const savedRes = await pool.query("SELECT job_id FROM candidate_saved_jobs WHERE candidate_id = $1", [candidateIntId]);
            savedJobIds = new Set(savedRes.rows.map(r => r.job_id));
        }

        // 3. Process jobs: Parse JSON and compute deterministic match score
        const processedJobs = jobs.map(job => {
            let jobSkills = [];
            try {
                if (typeof job.skills === 'string') {
                    jobSkills = JSON.parse(job.skills);
                } else if (typeof job.skills_required === 'string') {
                    jobSkills = JSON.parse(job.skills_required);
                } else if (Array.isArray(job.skills)) {
                    jobSkills = job.skills;
                } else if (Array.isArray(job.skills_required)) {
                    jobSkills = job.skills_required;
                }
            } catch(e) {}

            let matchScore = 50; // Default base

            if (candidateProfile) {
                let matchedWeights = 0;
                let totalWeights = 4; // Location, Job Type, Education, Skills

                // Weight 1: Location
                let candLocations = [];
                try { candLocations = JSON.parse(candidateProfile.preferred_locations || "[]"); } catch(e){}
                if (
                    candLocations.includes(job.location) || 
                    candLocations.includes("Remote") || 
                    job.location === "Remote" ||
                    (job.location && candLocations.some(loc => job.location.toLowerCase().includes(loc.toLowerCase())))
                ) {
                    matchedWeights += 1;
                }

                // Weight 2: Job Type
                if (
                    candidateProfile.preferred_job_type && 
                    job.job_type && 
                    candidateProfile.preferred_job_type.toLowerCase() === job.job_type.toLowerCase()
                ) {
                    matchedWeights += 1;
                }

                // Weight 3: Education
                const jobQual = job.qualification_required || job.qualification || "";
                if (
                    candidateProfile.highest_qualification && 
                    jobQual && 
                    candidateProfile.highest_qualification.toLowerCase() === jobQual.toLowerCase()
                ) {
                    matchedWeights += 1;
                } else if (!jobQual || jobQual.toLowerCase() === 'any degree' || jobQual.toLowerCase() === 'any') {
                    matchedWeights += 1;
                }

                // Weight 4: Skills
                let candSkills = [];
                try { 
                    candSkills = JSON.parse(candidateProfile.technical_skills || "[]").concat(JSON.parse(candidateProfile.non_technical_skills || "[]")); 
                    if (candSkills.length === 0 && candidateProfile.skills) {
                        candSkills = JSON.parse(candidateProfile.skills || "[]");
                    }
                } catch(e){}

                if (jobSkills.length === 0) {
                     matchedWeights += 1; 
                } else if (candSkills.length > 0) {
                     const lowerCandSkills = candSkills.map(s => s.toLowerCase());
                     const overlap = jobSkills.filter(s => lowerCandSkills.includes(s.toLowerCase()));
                     if (overlap.length > 0) {
                         matchedWeights += (overlap.length / jobSkills.length);
                     }
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
