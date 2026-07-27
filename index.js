const express = require('express');
const bcrypt = require('bcrypt');
const cors = require('cors');

const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); 

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// 1. MIDDLEWARE (CORS & Body Parsers)
// ==========================================
app.use(cors({ origin: '*' })); 
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==========================================
// 2. DATABASE CONNECTION
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) console.error('❌ Database connection error:', err.stack);
    else console.log('✅ Successfully connected to the PostgreSQL database.');
});

// ==========================================
// 3. HEALTH CHECK ROUTE
// ==========================================
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: "online", db: "connected", timestamp: new Date() });
    } catch (err) {
        res.status(500).json({ status: "online", db: "error", error: err.message });
    }
});

// ==========================================
// 4. AUTHENTICATION & REGISTRATION APIS
// ==========================================

// --- CANDIDATE REGISTRATION ---
app.post('/api/auth/candidate/register', async (req, res) => {
    const data = req.body;
    try {
        if (!data.fullName || (!data.email && !data.phone)) {
            return res.status(400).json({ success: false, message: "Full Name and Email or Mobile Number are required." });
        }

        const cleanEmail = data.email ? data.email.trim().toLowerCase() : null;
        const cleanPhone = data.phone ? data.phone.replace(/\D/g, "").trim() : null;

        if (cleanEmail) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(cleanEmail)) {
                return res.status(400).json({ success: false, message: "Invalid email address format." });
            }
        }

        const userExists = await pool.query(
            "SELECT id FROM candidates WHERE (email IS NOT NULL AND email != '' AND LOWER(email) = $1) OR (phone IS NOT NULL AND phone != '' AND phone = $2)",
            [cleanEmail, cleanPhone]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: "An account with this Email or Mobile Number is already registered!" });
        }

        let parsedDob = null;
        if (data.dob && typeof data.dob === 'string' && data.dob.trim() !== '' && !isNaN(Date.parse(data.dob))) {
            parsedDob = new Date(data.dob);
            const ageDiff = new Date().getFullYear() - parsedDob.getFullYear();
            if (ageDiff < 15) {
                return res.status(400).json({ success: false, message: "You must be at least 15 years old to register." });
            }
        }

        if (data.resumeFileName) {
            const ext = data.resumeFileName.split('.').pop().toLowerCase();
            if (!['pdf', 'doc', 'docx'].includes(ext)) {
                return res.status(400).json({ success: false, message: "Only PDF and Word documents (.pdf, .doc, .docx) are allowed." });
            }
        }

        const unique_id = 'BCC-CAN-' + Math.floor(100000 + Math.random() * 900000);

        const insertQuery = `
            INSERT INTO candidates (
                unique_id, full_name, email, phone, password, dob, gender, preferred_language, category,
                pincode, state, district, taluk, mla_constituency, mp_constituency, gram_panchayat,
                highest_qualification, year_of_passing, institution, school_name, course, specialization, percentage_cgpa, languages_fluent,
                skills, experience_type, years_of_experience, employment_status, current_job_role, current_company,
                resume_file_name, certifications, preferred_roles, preferred_locations, willing_to_relocate, preferred_job_type, expected_salary, status, account_status, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, 'Pending', 'Verified', NOW()
            ) RETURNING unique_id;
        `;

        const values = [
            unique_id,
            data.fullName ? data.fullName.trim() : "",
            cleanEmail,
            cleanPhone,
            data.password || "BccPass@123",
            parsedDob,
            data.gender || null,
            data.language || 'English',
            data.category || 'General Merit (GM)',
            data.pincode || null,
            data.state || null,
            data.district || null,
            data.taluk || null,
            data.mla || null,
            data.mp || null,
            data.gramPanchayat || null,
            data.qualification || null,
            data.yearOfPassing || null,
            data.institution || null,
            data.schoolName || null,
            data.course || null,
            data.specialization || null,
            data.percentage || null,
            JSON.stringify(data.languagesFluent || []),
            JSON.stringify(data.skills || []),
            data.experienceType || 'Fresher',
            data.yearsOfExperience || null,
            data.employmentStatus || null,
            data.currentRole || null,
            data.currentCompany || null,
            data.resumeFileName || null,
            JSON.stringify(data.certifications || []),
            JSON.stringify(data.preferredRoles || []),
            JSON.stringify(data.preferredLocations || []),
            Boolean(data.willingToRelocate),
            data.preferredJobType || 'Full-time',
            data.expectedSalary || null
        ];

        const result = await pool.query(insertQuery, values);
        console.log(`✅ Candidate registered: ${result.rows[0].unique_id}`);
        res.status(201).json({ success: true, message: "Candidate registered successfully", uniqueId: result.rows[0].unique_id });
    } catch (error) {
        console.error("❌ Candidate Register DB Error:", error);
        res.status(500).json({ success: false, message: "Database Error: " + (error.detail || error.message || "Server error during registration.") });
    }
});

// --- EMPLOYER REGISTRATION ---
app.post('/api/auth/employer/register', async (req, res) => {
    const { company_name, email_domain, gst_cin, industry, sector, company_size, website, hq_city, about_company, hr_name, hr_phone, email, password } = req.body;
    try {
        const cleanEmail = email ? email.trim().toLowerCase() : "";
        const userExists = await pool.query("SELECT * FROM employers WHERE LOWER(email) = $1", [cleanEmail]);
        if (userExists.rows.length > 0) return res.status(400).json({ success: false, message: "Email already registered." });
        
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        
        await pool.query(`
            INSERT INTO employers (company_name, email_domain, gst_cin, industry, sector, company_size, website, hq_city, about_company, hr_name, hr_phone, email, password_hash, password, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending')
        `, [company_name, email_domain, gst_cin, industry, sector, company_size, website, hq_city, about_company, hr_name, hr_phone, cleanEmail, password_hash, password]);
        
        res.status(201).json({ success: true, message: "Registration submitted successfully." });
    } catch (error) { 
        res.status(500).json({ success: false, message: "Server error during registration." }); 
    }
});

// --- MASTER AUTHENTICATION (LOGIN) ---
app.post('/api/auth/login', async (req, res) => {
    const { role, password, company_name } = req.body; 
    const emailInput = req.body.email || req.body.identifier || "";

    try {
        const rawInput = emailInput.trim();
        const digitsOnly = rawInput.replace(/\D/g, "");
        const last10Digits = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;

        if (role === 'admin') {
            const adminResult = await pool.query("SELECT * FROM admins WHERE LOWER(TRIM(email)) = LOWER($1)", [rawInput]);
            if (adminResult.rows.length === 0) return res.status(401).json({ success: false, message: 'Admin account not found.' });

            const admin = adminResult.rows[0];
            let isMatch = admin.password && admin.password.startsWith('$2') 
                ? await bcrypt.compare(password, admin.password) 
                : (password === admin.password);

            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Admin Credentials.' });

            return res.json({ 
                success: true, 
                data: { id: admin.unique_id || admin.id, name: admin.full_name || 'Admin', email: admin.email, role: 'admin' } 
            });
        }

        if (role === 'employer') {
            const cleanInput = rawInput.toLowerCase();
            const cleanCompany = company_name ? company_name.trim().toLowerCase() : "";

            const empResult = await pool.query(
                "SELECT * FROM employers WHERE LOWER(TRIM(email)) = $1 OR LOWER(TRIM(company_name)) = $2", 
                [cleanInput, cleanCompany]
            );

            if (empResult.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Employer account not found.' });
            }

            const employer = empResult.rows[0];
            const currentStatus = (employer.status || 'pending').toLowerCase().trim();

            if (currentStatus === 'pending') {
                return res.status(403).json({ success: false, message: 'Your company registration is currently PENDING admin approval.' });
            }
            if (currentStatus === 'rejected' || currentStatus === 'blacklisted') {
                return res.status(403).json({ success: false, message: 'Your company registration has been restricted by the admin.' });
            }
            if (currentStatus !== 'approved') {
                return res.status(403).json({ success: false, message: 'Account not approved for login.' });
            }

            let isMatch = employer.password && employer.password.startsWith('$2') 
                ? await bcrypt.compare(password, employer.password) 
                : (password === employer.password || password === employer.password_hash);

            if (!isMatch) {
                return res.status(401).json({ success: false, message: 'Invalid Password.' });
            }

            return res.json({ 
                success: true, 
                data: { 
                    id: employer.id, 
                    name: employer.company_name, 
                    email: employer.email, 
                    role: 'employer' 
                } 
            });
        }

        if (role === 'candidate' || !role) {
            const queryText = `
                SELECT * FROM candidates 
                WHERE LOWER(TRIM(email)) = LOWER($1) 
                   OR LOWER(TRIM(unique_id)) = LOWER($1)
                   OR TRIM(phone) = $1
                   OR ($2 != '' AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $2)
            `;

            const candResult = await pool.query(queryText, [rawInput, last10Digits]);

            if (candResult.rows.length === 0) {
                return res.status(401).json({ 
                    success: false, 
                    message: 'Candidate account not found. Please check your Email, Mobile Number, or Candidate ID.' 
                });
            }

            const candidate = candResult.rows[0];

            if (candidate.account_status === 'Blocked') {
                return res.status(403).json({ success: false, message: 'Your candidate account has been blocked by administrators.' });
            }

            let isMatch = candidate.password && candidate.password.startsWith('$2') 
                ? await bcrypt.compare(password, candidate.password) 
                : (password === candidate.password);

            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Password. Please try again.' });

            console.log(`🔑 LOGIN SUCCESS: ${candidate.full_name} (${candidate.unique_id})`);
            return res.json({ 
                success: true, 
                data: { id: candidate.unique_id, name: candidate.full_name, email: candidate.email, phone: candidate.phone, role: 'candidate' } 
            });
        }

        return res.status(400).json({ success: false, message: 'Invalid role selected.' });
    } catch (error) {
        console.error("❌ Login Server Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});

// --- FORGOT & RESET PASSWORD ---
app.post('/api/auth/forgot-password', async (req, res) => {
    const { identifier } = req.body;
    const rawInput = identifier ? identifier.trim() : "";
    const digitsOnly = rawInput.replace(/\D/g, "");
    const last10Digits = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;

    try {
        const queryText = `
            SELECT id FROM candidates 
            WHERE LOWER(TRIM(email)) = LOWER($1) 
               OR LOWER(TRIM(unique_id)) = LOWER($1)
               OR TRIM(phone) = $1
               OR ($2 != '' AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $2)
        `;
        const result = await pool.query(queryText, [rawInput, last10Digits]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "No registered account found with these details." });
        }

        return res.json({ success: true, message: "OTP sent successfully! Use 1234 to verify." });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Server error checking account." });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { identifier, otp, newPassword } = req.body;
    
    if (otp !== "1234" && otp !== "123456") {
        return res.status(400).json({ success: false, message: "Invalid OTP code." });
    }

    const rawInput = identifier ? identifier.trim() : "";
    const digitsOnly = rawInput.replace(/\D/g, "");
    const last10Digits = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;

    try {
        const updateQuery = `
            UPDATE candidates 
            SET password = $1 
            WHERE LOWER(TRIM(email)) = LOWER($2) 
               OR LOWER(TRIM(unique_id)) = LOWER($2)
               OR TRIM(phone) = $2
               OR ($3 != '' AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $3)
            RETURNING unique_id;
        `;
        const result = await pool.query(updateQuery, [newPassword, rawInput, last10Digits]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Account update failed. User not found." });
        }

        return res.json({ success: true, message: "Password updated successfully! You can now log in." });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Database error updating password." });
    }
});

// --- MARK VENUE ATTENDANCE (CANDIDATE & EMPLOYER) ---
app.post('/api/events/attendance/mark', async (req, res) => {
    const { eventId, userId, userType, code } = req.body;

    // 1. Strict Null Checks
    if (!eventId || !userId) {
        return res.status(400).json({ success: false, message: "Missing eventId or userId in request." });
    }

    if (code !== '1234' && code !== '123456') {
        return res.status(400).json({ success: false, message: "Invalid verification code." });
    }

    try {
        let dbUserId = userId;

        // 2. Safe Candidate Resolution
        if (userType === 'candidate') {
            const candLookup = await pool.query("SELECT id FROM candidates WHERE unique_id = $1 OR id::text = $1", [userId.toString()]);
            if (candLookup.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate account not found." });
            dbUserId = candLookup.rows[0].id;
        } 
        // 3. Safe Employer Resolution
        else if (userType === 'employer') {
             const empLookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [userId.toString()]);
             if (empLookup.rows.length === 0) return res.status(404).json({ success: false, message: "Employer account not found." });
             dbUserId = empLookup.rows[0].id;
        }

        // 4. Prevent Duplicate Check-ins
        const duplicateCheck = await pool.query(
            "SELECT id FROM event_attendance WHERE event_id = $1 AND user_id = $2 AND user_type = $3", 
            [eventId, dbUserId, userType]
        );
        if (duplicateCheck.rows.length > 0) {
            // Already checked in? Just return success to gracefully unlock the UI!
            return res.json({ success: true, message: "Already checked in! Event unlocked." });
        }

        // 5. Insert Attendance matching DB Schema (checked_in_at)
        await pool.query(
            `INSERT INTO event_attendance (event_id, user_id, user_type, checked_in_at) 
             VALUES ($1, $2, $3, NOW())`,
            [eventId, dbUserId, userType]
        );

        // 6. Update Registration Status (Unlocks Jobs)
        if (userType === 'candidate') {
            await pool.query(
                `UPDATE event_candidate_registrations 
                 SET attendance_status = 'Present' 
                 WHERE event_id = $1 AND candidate_id = $2`,
                [eventId, dbUserId]
            );
        }

        res.json({ success: true, message: "Attendance verified! Event unlocked." });
    } catch (error) {
        console.error("❌ Error marking attendance:", error);
        res.status(500).json({ success: false, message: "Server error marking attendance." });
    }
});


// ==========================================
// 5. CANDIDATE PORTAL & SAVED JOBS APIS
// ==========================================
app.get('/api/candidate/:id/saved-jobs', async (req, res) => {
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

app.post('/api/candidate/saved-jobs/toggle', async (req, res) => {
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

app.delete('/api/candidate/saved-jobs/:savedId', async (req, res) => {
    try {
        await pool.query("DELETE FROM candidate_saved_jobs WHERE id = $1", [req.params.savedId]);
        res.json({ success: true, message: "Saved job removed." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to remove saved job." });
    }
});

app.get('/api/candidate/:id', async (req, res) => {
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

app.get('/api/candidate/profile/:id', async (req, res) => {
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

app.put('/api/candidate/profile/update', async (req, res) => {
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

app.get('/api/candidate/:id/jobs', async (req, res) => {
    try {
        const candidateRes = await pool.query("SELECT * FROM candidates WHERE unique_id = $1", [req.params.id]);
        if (candidateRes.rows.length === 0) return res.status(404).json({ success: false });
        const candidate = candidateRes.rows[0];
        const jobsRes = await pool.query("SELECT * FROM jobs WHERE status = 'approved'");
        
        const savedRes = await pool.query("SELECT job_id FROM candidate_saved_jobs WHERE candidate_id = $1", [candidate.id]);
        const savedJobIds = new Set(savedRes.rows.map(r => r.job_id));

        const matchedJobs = jobsRes.rows.map(job => {
            let score = 0;
            let jobSkills = []; try { jobSkills = typeof job.skills_required === 'string' ? JSON.parse(job.skills_required) : (job.skills_required || []); } catch(e){}
            let candidateSkills = []; try { candidateSkills = typeof candidate.skills === 'string' ? JSON.parse(candidate.skills) : (candidate.skills || []); } catch(e){}
            
            if (jobSkills.length > 0) {
                const matchedSkills = jobSkills.filter(js => candidateSkills.some(cs => cs.toLowerCase() === js.toLowerCase()));
                score += (matchedSkills.length / jobSkills.length) * 50;
            } else { score += 50; }
            
            let preferredLocs = []; try { preferredLocs = typeof candidate.preferred_locations === 'string' ? JSON.parse(candidate.preferred_locations) : []; } catch(e){}
            if ((job.location || "").toLowerCase() === (candidate.district || "").toLowerCase() || preferredLocs.some(loc => loc.toLowerCase() === (job.location || "").toLowerCase()) || candidate.willing_to_relocate) score += 20;
            
            if (!job.qualification_required || job.qualification_required === "Any Degree" || job.qualification_required === candidate.highest_qualification || candidate.highest_qualification === "PG Degree" || candidate.highest_qualification === "BE/B-Tech") score += 15;
            
            let prefRoles = []; try { prefRoles = typeof candidate.preferred_roles === 'string' ? JSON.parse(candidate.preferred_roles) : []; } catch(e){}
            if (prefRoles.some(role => (job.title || "").toLowerCase().includes(role.toLowerCase()))) score += 15;
            
            return { 
                id: job.id, 
                company: job.company_name, 
                title: job.title, 
                type: job.job_type, 
                location: job.location, 
                qualification: job.qualification_required, 
                experience: job.experience_required, 
                salary: job.salary_range, 
                skills: jobSkills, 
                matchScore: Math.round(score),
                isSaved: savedJobIds.has(job.id)
            };
        }).sort((a, b) => b.matchScore - a.matchScore);

        res.json({ success: true, data: matchedJobs });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/applications/apply', async (req, res) => {
    try {
        const checkDuplicate = await pool.query("SELECT * FROM job_applications WHERE job_id = $1 AND candidate_id = $2", [req.body.jobId, req.body.candidateId]);
        if (checkDuplicate.rows.length > 0) return res.status(400).json({ success: false, message: "You have already applied for this job." });
        await pool.query("INSERT INTO job_applications (job_id, candidate_id, employer_id, status) VALUES ($1, $2, $3, 'Applied')", [req.body.jobId, req.body.candidateId, req.body.employerId]);
        res.status(200).json({ success: true, message: "Application submitted successfully!" });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/candidate/:id/applications', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.params.id]);
        const candidateIntId = candCheck.rows.length > 0 ? candCheck.rows[0].id : 0;
        const result = await pool.query(`
            SELECT ja.id as application_id, j.title as job_title, j.company_name as company, ja.applied_at, ja.status, j.employer_id, j.id as job_id, j.event_id, e.name as event_name
            FROM job_applications ja JOIN jobs j ON ja.job_id = j.id LEFT JOIN events e ON j.event_id = e.id
            WHERE ja.candidate_id::text = $1 OR ja.candidate_id::text = $2 ORDER BY ja.applied_at DESC
        `, [req.params.id, candidateIntId.toString()]);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/candidate/:id/events', async (req, res) => {
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

app.post('/api/events/apply', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.body.candidateId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Candidate account not found." });
        const eventCheck = await pool.query("SELECT status FROM events WHERE id = $1", [req.body.eventId]);
        if (eventCheck.rows.length > 0 && eventCheck.rows[0].status === 'Hold') return res.status(400).json({ success: false, message: "This event is currently on hold." });
        const duplicateCheck = await pool.query("SELECT id FROM event_candidate_registrations WHERE event_id = $1 AND (candidate_id::text = $2 OR candidate_id::text = $3)", [req.body.eventId, req.body.candidateId, candCheck.rows[0].id.toString()]);
        if (duplicateCheck.rows.length > 0) return res.status(400).json({ success: false, message: "You have already registered for this event." });
        
        const passId = `BCC-evt-${req.body.eventId}-${Date.now().toString().slice(-5)}`;
        const queueToken = `A-${Math.floor(100 + Math.random() * 900)}`;
        try {
            await pool.query("INSERT INTO event_candidate_registrations (event_id, candidate_id, entry_pass_id, queue_token, attendance_status) VALUES ($1, $2, $3, $4, 'Pending')", [req.body.eventId, req.body.candidateId, passId, queueToken]);
        } catch (insertError) {
            if (insertError.code === '22P02') await pool.query("INSERT INTO event_candidate_registrations (event_id, candidate_id, entry_pass_id, queue_token, attendance_status) VALUES ($1, $2, $3, $4, 'Pending')", [req.body.eventId, candCheck.rows[0].id, passId, queueToken]);
            else throw insertError;
        }
        res.json({ success: true, message: "Successfully registered!", passId, queueToken });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/candidate/:id/interviews', async (req, res) => {
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

app.get('/api/candidate/:id/history', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.params.id]);
        if (candCheck.rows.length === 0) return res.json({ success: true, data: [] });
        const result = await pool.query("SELECT * FROM candidate_activity_logs WHERE candidate_id = $1 ORDER BY created_at DESC", [candCheck.rows[0].id]);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/candidate/history/log', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.body.candidateId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false });
        await pool.query("INSERT INTO candidate_activity_logs (candidate_id, action_type, title, description) VALUES ($1, $2, $3, $4)", [candCheck.rows[0].id, req.body.actionType, req.body.title, req.body.description]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/candidate/:id/history', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.params.id]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false });
        await pool.query("DELETE FROM candidate_activity_logs WHERE candidate_id = $1", [candCheck.rows[0].id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/candidate/feedback', async (req, res) => {
    try {
        const candCheck = await pool.query("SELECT id FROM candidates WHERE unique_id = $1", [req.body.candidateId]);
        if (candCheck.rows.length === 0) return res.status(404).json({ success: false });
        await pool.query("INSERT INTO candidate_feedback (candidate_id, overall_rating, registration_exp, interview_quality, event_management, video_url) VALUES ($1, $2, $3, $4, $5, $6)", 
        [candCheck.rows[0].id, req.body.rating, req.body.registrationExp, req.body.interviewQuality, req.body.eventManagement, req.body.videoUrl]);
        res.json({ success: true, message: "Feedback submitted successfully!" });
    } catch (error) { res.status(500).json({ success: false }); }
});


// ==========================================
// 6. ADMIN DASHBOARD & MANAGEMENT APIS
// ==========================================
app.get('/api/admin/attendance-history', async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id,
                a.checked_in_at as time,
                a.user_type as role,
                'Main Gate' as gate,
                'Checked In' as status,
                e.name as event_name,
                CASE 
                    WHEN a.user_type = 'candidate' THEN c.unique_id
                    WHEN a.user_type = 'employer' THEN CONCAT('EMP-', LPAD(emp.id::text, 3, '0'))
                END as user_id,
                CASE 
                    WHEN a.user_type = 'candidate' THEN c.full_name
                    WHEN a.user_type = 'employer' THEN emp.company_name
                END as name
            FROM event_attendance a
            JOIN events e ON a.event_id = e.id
            LEFT JOIN candidates c ON a.user_id = c.id AND a.user_type = 'candidate'
            LEFT JOIN employers emp ON a.user_id = emp.id AND a.user_type = 'employer'
            ORDER BY a.checked_in_at DESC
            LIMIT 100
        `;
        
        const result = await pool.query(query);
        res.status(200).json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching attendance history:", error);
        res.status(500).json({ success: false, message: "Server error fetching attendance" });
    }
});


app.get('/api/admin/live-events', async (req, res) => {
    try {
        const eventsResult = await pool.query('SELECT * FROM events WHERE is_live = TRUE ORDER BY created_at DESC');
        const liveEvents = eventsResult.rows;
        if (liveEvents.length === 0) return res.json({ success: true, data: [] });

        const dashboardData = await Promise.all(liveEvents.map(async (event) => {
            const regCount = await pool.query('SELECT COUNT(*) FROM event_candidate_registrations WHERE event_id = $1', [event.id]);
            const candidateAtt = await pool.query("SELECT COUNT(*) FROM event_attendance WHERE event_id = $1 AND user_type = 'candidate'", [event.id]);
            const employerAtt = await pool.query("SELECT COUNT(*) FROM event_attendance WHERE event_id = $1 AND user_type = 'employer'", [event.id]);
            const interviews = await pool.query("SELECT COUNT(*) FROM event_interviews WHERE event_id = $1 AND status = 'interviewed'", [event.id]);
            const offers = await pool.query("SELECT COUNT(*) FROM event_interviews WHERE event_id = $1 AND status = 'hired'", [event.id]);

            return {
                id: event.id, name: event.name, location: event.location,
                registrations: parseInt(regCount.rows[0].count),
                attendance: { candidates: parseInt(candidateAtt.rows[0].count), employers: parseInt(employerAtt.rows[0].count) },
                interviews: parseInt(interviews.rows[0].count),
                offers: parseInt(offers.rows[0].count)
            };
        }));
        res.status(200).json({ success: true, data: dashboardData });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/admin/events', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, event_date, event_type, city, employer_capacity, status, stall_price,
            (SELECT COUNT(*) FROM employer_event_stalls WHERE event_id = events.id) as registered_count
            FROM events ORDER BY event_date DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/events', async (req, res) => {
    const { name, date, type, city, venue, maps_link, capacity, price, desc } = req.body;
    try {
        const qrString = `GATE_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
        await pool.query(`
            INSERT INTO events (name, event_date, event_type, city, venue_address, google_maps_link, employer_capacity, stall_price, qr_code_string, status, description) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'upcoming', $10)
        `, [name, date, type, city, venue, maps_link, parseInt(capacity), parseFloat(price), qrString, desc]);
        res.status(201).json({ success: true, message: 'Event created' });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/events/:id', async (req, res) => {
    const { name, event_date, event_type, city, venue_address, employer_capacity, stall_price, description } = req.body;
    try {
        await pool.query(`UPDATE events SET name = $1, event_date = $2, event_type = $3, city = $4, venue_address = $5, employer_capacity = $6, stall_price = $7, description = $8 WHERE id = $9`, 
        [name, event_date, event_type, city, venue_address, parseInt(employer_capacity), parseFloat(stall_price), description, req.params.id]);
        res.json({ success: true, message: 'Event details updated successfully' });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/events/:id/hold', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'hold' WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: 'Event placed on hold' });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/events/:id/live', async (req, res) => {
    try {
        await pool.query("UPDATE events SET status = 'live' WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Event is now live!" });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/admin/events/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM event_interviews WHERE event_id = $1", [id]);
        await pool.query("DELETE FROM employer_event_stalls WHERE event_id = $1", [id]);
        await pool.query("DELETE FROM event_attendance WHERE event_id = $1", [id]);
        await pool.query("DELETE FROM event_candidate_registrations WHERE event_id = $1", [id]);
        await pool.query("DELETE FROM events WHERE id = $1", [id]);
        res.json({ success: true, message: 'Event deleted' });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/events/:eventId/venue', async (req, res) => {
    try {
        const blocks = await pool.query("SELECT * FROM venue_blocks WHERE event_id = $1 ORDER BY id ASC", [req.params.eventId]);
        const rooms = await pool.query("SELECT * FROM venue_rooms WHERE block_id IN (SELECT id FROM venue_blocks WHERE event_id = $1)", [req.params.eventId]);
        const stalls = await pool.query(`
            SELECT s.*, e.company_name as allocated_name 
            FROM venue_stalls s LEFT JOIN employers e ON s.employer_id = e.id 
            WHERE s.event_id = $1 ORDER BY s.code ASC
        `, [req.params.eventId]);

        const venueStructure = blocks.rows.map(block => {
            const blockRooms = rooms.rows.filter(r => r.block_id === block.id).map(room => ({
                id: room.id.toString(), name: room.name, code: room.code,
                stalls: stalls.rows.filter(s => s.room_id === room.id).map(s => ({
                    id: s.id.toString(), code: s.code, allocatedToAppId: s.employer_id ? s.employer_id.toString() : null, allocatedName: s.allocated_name
                }))
            }));
            const blockStalls = stalls.rows.filter(s => s.block_id === block.id && s.room_id === null).map(s => ({
                id: s.id.toString(), code: s.code, allocatedToAppId: s.employer_id ? s.employer_id.toString() : null, allocatedName: s.allocated_name
            }));
            return { id: block.id.toString(), kind: block.type, name: block.name, code: block.code, sections: blockRooms, stalls: blockStalls };
        });
        res.json({ success: true, data: venueStructure });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/stall-applications', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT es.id, es.status, es.payment_status, es.applied_at, es.roles_to_hire as "rolesToHire", es.vacancies_count as "vacanciesCount",
                   e.company_name as "employerName", e.email as "contactEmail", ev.id as "eventId", ev.name as "eventName", s.code as "allocatedStall"
            FROM employer_event_stalls es
            JOIN employers e ON es.employer_id = e.id JOIN events ev ON es.event_id = ev.id
            LEFT JOIN venue_stalls s ON s.employer_id = e.id AND s.event_id = ev.id ORDER BY es.applied_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

// --- ADMIN JOB APPROVAL APIS ---
app.get('/api/admin/jobs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, title, company_name, job_type, location, status, created_at 
            FROM jobs 
            ORDER BY created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { 
        res.status(500).json({ success: false }); 
    }
});

// --- ADMIN: VIEW JOBS FOR SPECIFIC EVENT ---
app.get('/api/admin/events/:eventId/jobs', async (req, res) => {
    const { eventId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM jobs WHERE event_id = $1 ORDER BY created_at DESC",
            [eventId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching admin event jobs:", error);
        res.status(500).json({ success: false, message: "Server error fetching event jobs" });
    }
});

// --- PUBLIC EVENT JOBS PREVIEW ROUTE ---
app.get('/api/events/:eventId/jobs', async (req, res) => {
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

// --- ADMIN: APPROVE / REJECT / UPDATE JOB STATUS ---
app.put('/api/admin/jobs/:jobId/status', async (req, res) => {
    const { jobId } = req.params;
    const { status } = req.body; 

    try {
        const updatedJob = await pool.query(
            `UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *`,
            [status, jobId]
        );

        if (updatedJob.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Job not found" });
        }
        
        res.json({ success: true, message: `Job marked as ${status}`, data: updatedJob.rows[0] });
    } catch (error) {
        console.error("❌ Error updating job status:", error);
        res.status(500).json({ success: false, message: "Server error updating job status" });
    }
});

app.get('/api/admin/employers', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT e.id, e.company_name AS name, COALESCE(e.gst_cin, 'Pending') AS gst_status, e.status,
                   COALESCE(AVG(ef.overall_rating), 4.0)::numeric(2,1) AS rating,
                   (SELECT COUNT(*) FROM jobs j WHERE j.employer_id = e.id AND j.status = 'approved') AS jobs
            FROM employers e LEFT JOIN employer_feedback ef ON e.id = ef.employer_id GROUP BY e.id ORDER BY e.created_at DESC
        `);
        const formattedData = result.rows.map(e => ({
            id: `EMP-${String(e.id).padStart(3, '0')}`, dbId: e.id, name: e.name,
            gst: e.gst_status !== 'Pending' ? 'Verified' : 'Pending', jobs: parseInt(e.jobs) || 0,
            rating: parseFloat(e.rating), status: e.status === 'approved' ? 'Active' : e.status === 'blacklisted' ? 'Blacklisted' : 'Pending'
        }));
        res.json({ success: true, data: formattedData });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/candidates', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.unique_id AS id, c.full_name AS name, COALESCE(c.highest_qualification, 'N/A') AS qual,
                   COALESCE(c.district, 'N/A') AS district, COALESCE(c.account_status, 'Pending') AS status,
                   EXISTS (SELECT 1 FROM event_candidate_registrations ecr WHERE ecr.candidate_id::text = c.unique_id AND LOWER(ecr.attendance_status) = 'present') AS attended
            FROM candidates c ORDER BY c.created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});


// ==========================================
// 7. EMPLOYER PORTAL APIS (WITH SMART ID / EMAIL RESOLUTION)
// ==========================================
app.get('/api/employer/:employerId/dashboard', async (req, res) => {
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

        const activeJobs = await pool.query("SELECT COUNT(*) FROM jobs WHERE employer_id = $1 AND status = 'approved'", [dbEmpId]);
        const totalApps = await pool.query("SELECT COUNT(*) FROM job_applications WHERE employer_id = $1", [dbEmpId]);
        const interviews = await pool.query("SELECT COUNT(*) FROM job_applications WHERE employer_id = $1 AND status IN ('Interview', 'Interviewed', 'Interview Scheduled')", [dbEmpId]);
        const offers = await pool.query("SELECT COUNT(*) FROM job_applications WHERE employer_id = $1 AND status IN ('Offered', 'Hired')", [dbEmpId]);

        const funnelRes = await pool.query("SELECT status, COUNT(*) as count FROM job_applications WHERE employer_id = $1 GROUP BY status", [dbEmpId]);
        const funnel = { Applied: 0, Shortlisted: 0, Interview: 0, Offer: 0, Hired: 0 };
        funnelRes.rows.forEach(row => {
            if (row.status === 'Applied') funnel.Applied = parseInt(row.count);
            if (row.status === 'Shortlisted') funnel.Shortlisted = parseInt(row.count);
            if (row.status.includes('Interview')) funnel.Interview += parseInt(row.count);
            if (row.status === 'Offered' || row.status === 'Offer') funnel.Offer += parseInt(row.count);
            if (row.status === 'Hired') funnel.Hired += parseInt(row.count);
        });

        const recentApps = await pool.query(`
            SELECT ja.id as application_id, ja.status, ja.applied_at, COALESCE(c.full_name, 'Candidate') as candidate_name, ja.candidate_id, j.title as job_title, FLOOR(RANDOM() * (98 - 75 + 1) + 75) as match_score
            FROM job_applications ja LEFT JOIN candidates c ON ja.candidate_id = c.unique_id JOIN jobs j ON ja.job_id = j.id
            WHERE ja.employer_id = $1 ORDER BY ja.applied_at DESC LIMIT 5
        `, [dbEmpId]);

        res.json({ success: true, data: {
            kpis: { activeJobs: parseInt(activeJobs.rows[0].count), applications: parseInt(totalApps.rows[0].count), interviews: parseInt(interviews.rows[0].count), offersMade: parseInt(offers.rows[0].count) },
            funnelData: funnel, recentApplicants: recentApps.rows
        }});
    } catch (error) { 
        console.error("Dashboard Error:", error);
        res.status(500).json({ success: false, message: error.message }); 
    }
});
// --- APPLY FOR EMPLOYER EVENT STALL ---
app.post('/api/employer/event-stalls/apply', async (req, res) => {
    const { employerId, eventId } = req.body;
    
    if (!employerId || !eventId) {
        return res.status(400).json({ success: false, message: "Missing employerId or eventId" });
    }

    try {
        let dbEmpId = employerId;
        // If local storage saved an email or string instead of numeric ID:
        if (typeof employerId === 'string' && (employerId.includes('@') || isNaN(Number(employerId)))) {
            const lookup = await pool.query(
                "SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", 
                [employerId]
            );
            if (lookup.rows.length > 0) {
                dbEmpId = lookup.rows[0].id;
            } else {
                return res.status(404).json({ success: false, message: "Employer account not found." });
            }
        }

        // Check if already applied
        const duplicate = await pool.query(
            "SELECT id FROM employer_event_stalls WHERE employer_id = $1 AND event_id = $2",
            [dbEmpId, eventId]
        );

        if (duplicate.rows.length > 0) {
            return res.status(400).json({ success: false, message: "You have already applied for a stall at this event." });
        }

        // Insert new application
        await pool.query(
            `INSERT INTO employer_event_stalls (employer_id, event_id, status, payment_status, applied_at) 
             VALUES ($1, $2, 'pending', 'pending', NOW())`,
            [dbEmpId, eventId]
        );

        return res.json({ success: true, message: "Stall application submitted successfully." });
    } catch (error) {
        console.error("❌ Error applying for stall:", error);
        return res.status(500).json({ success: false, message: "Database Error: " + error.message });
    }
});
app.get('/api/employer/:employerId/analytics', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) {
                dbEmpId = lookup.rows[0].id;
            } else {
                return res.status(404).json({ success: false, message: "Employer analytics not found." });
            }
        }

        const appsRes = await pool.query("SELECT COUNT(*) FROM job_applications WHERE employer_id::text = $1::text", [dbEmpId]);
        const hiresRes = await pool.query("SELECT COUNT(*) FROM job_applications WHERE employer_id::text = $1::text AND status = 'Hired'", [dbEmpId]);
        const totalApps = parseInt(appsRes.rows[0].count) || 0;
        const totalHires = parseInt(hiresRes.rows[0].count) || 0;

        const historyRes = await pool.query(`
            SELECT ja.applied_at as date, COALESCE(c.full_name, 'Candidate') as candidate_name, 
                   j.title as job_title, ja.status as action_type, j.event_id, e.name as event_name
            FROM job_applications ja 
            LEFT JOIN candidates c ON ja.candidate_id::text = c.unique_id OR ja.candidate_id::text = c.id::text
            JOIN jobs j ON ja.job_id::text = j.id::text 
            LEFT JOIN events e ON j.event_id::text = e.id::text
            WHERE ja.employer_id::text = $1::text 
            ORDER BY ja.applied_at DESC
        `, [dbEmpId]);

        const monthlyData = [
            { month: "Jan", apps: Math.floor(totalApps * 0.2), hires: Math.floor(totalHires * 0.2) },
            { month: "Feb", apps: Math.floor(totalApps * 0.3), hires: Math.floor(totalHires * 0.3) },
            { month: "Mar", apps: Math.floor(totalApps * 0.5), hires: totalHires - Math.floor(totalHires * 0.5) },
        ];

        res.json({
            success: true,
            data: {
                kpis: { 
                    conversionRate: totalApps > 0 ? ((totalHires / totalApps) * 100).toFixed(1) : "0.0", 
                    avgTime: totalHires > 0 ? "6 days" : "N/A", 
                    totalHires, 
                    talentPool: totalApps 
                },
                monthlyData,
                history: historyRes.rows
            }
        });
    } catch (error) {
        console.error("❌ Analytics Error:", error);
        res.status(500).json({ success: false, message: "Server error fetching analytics: " + error.message });
    }
});

// --- GET EMPLOYER PROFILE ---
// --- GET EMPLOYER PROFILE ---
app.get('/api/employer/profile/:employerId', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
        }

        const result = await pool.query(
            `SELECT id, company_name as "companyName", hr_name as "fullName", designation, email, 
                    hr_phone as mobile, department, language, about_company as about, photo_url as "photoUrl" 
             FROM employers WHERE id = $1`, 
            [dbEmpId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employer profile not found." });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("❌ Profile Fetch Error:", error);
        res.status(500).json({ success: false, message: "Server error fetching profile." });
    }
});
// --- UPDATE EMPLOYER PROFILE PHOTO ---
app.put('/api/employer/profile/:employerId/photo', async (req, res) => {
    const { employerId } = req.params;
    const { photoUrl } = req.body;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) dbEmpId = lookup.rows[0].id;
        }

        await pool.query(
            "UPDATE employers SET photo_url = $1 WHERE id = $2",
            [photoUrl, dbEmpId]
        );

        res.json({ success: true, message: "Profile photo saved successfully!" });
    } catch (error) {
        console.error("❌ Error updating employer photo:", error);
        res.status(500).json({ success: false, message: "Server error saving photo." });
    }
});
// --- GET EMPLOYER EVENT STALL APPLICATIONS ---
app.get('/api/employer/:employerId/event-stalls', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) {
                dbEmpId = lookup.rows[0].id;
            } else {
                 return res.status(404).json({ success: false, message: "Employer event stalls not found." });
            }
        }

        const result = await pool.query(
            "SELECT id, event_id as \"eventId\", status, payment_status as \"paymentStatus\", applied_at as \"appliedAt\" FROM employer_event_stalls WHERE employer_id = $1",
            [dbEmpId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("❌ Error fetching employer event stalls:", error);
        res.status(500).json({ success: false, message: "Server error fetching event stalls." });
    }
});
// ==========================================
// 8. EMPLOYER JOBS MANAGEMENT
// ==========================================

// --- EMPLOYER: GET ALL JOBS POSTED BY EMPLOYER ---
app.get('/api/employer/:employerId/jobs-list', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) {
                dbEmpId = lookup.rows[0].id;
            } else {
                return res.status(404).json({ success: false, message: "Employer jobs not found." });
            }
        }

        const result = await pool.query("SELECT * FROM jobs WHERE employer_id = $1 ORDER BY created_at DESC", [dbEmpId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching jobs." });
    }
});

// --- EMPLOYER: POST A NEW JOB ---
app.post('/api/employer/:employerId/jobs', async (req, res) => {
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

        // Feature 14: Auto-approve if it is tied to an event
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
            dbEmpId, companyName, title, jobType || 'Full-time', location, 
            qualification, experience, salary, 
            JSON.stringify(skills || []), vacancies || 1, description || '', 
            event_id || null, initialStatus
        ];

        const result = await pool.query(insertQuery, values);
        res.status(201).json({ success: true, message: "Job posted successfully", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error posting job:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- EMPLOYER: EDIT EXISTING JOB ---
app.put('/api/employer/jobs/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const { title, jobType, location, qualification, experience, salary, skills, vacancies, description, event_id } = req.body;

    try {
        const updateQuery = `
            UPDATE jobs SET 
                title = $1, job_type = $2, location = $3, 
                qualification_required = $4, experience_required = $5, 
                salary_range = $6, skills_required = $7, 
                vacancies = $8, description = $9, event_id = $10, status = 'pending'
            WHERE id = $11 RETURNING *;
        `;
        
        const values = [
            title, jobType, location, qualification, experience, salary, 
            JSON.stringify(skills || []), vacancies || 1, description || '', 
            event_id || null, jobId
        ];

        const result = await pool.query(updateQuery, values);
        res.json({ success: true, message: "Job updated", data: result.rows[0] });
    } catch (error) {
        console.error("❌ Error updating job:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- EMPLOYER: DELETE JOB ---
app.delete('/api/employer/jobs/:jobId', async (req, res) => {
    try {
        await pool.query("DELETE FROM jobs WHERE id = $1", [req.params.jobId]);
        res.json({ success: true, message: "Job deleted successfully." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to delete job." });
    }
});

// --- GET CANDIDATES REVIEWED COUNT FOR SPECIFIC EMPLOYER ---
app.get('/api/employer/:employerId/candidates-reviewed-count', async (req, res) => {
    const { employerId } = req.params;
    try {
        let dbEmpId = employerId;
        if (employerId.includes('@') || isNaN(employerId)) {
            const lookup = await pool.query("SELECT id FROM employers WHERE id::text = $1 OR LOWER(email) = LOWER($1)", [employerId]);
            if (lookup.rows.length > 0) {
                dbEmpId = lookup.rows[0].id;
            } else {
                return res.status(404).json({ success: false, count: 0 });
            }
        }

        const countRes = await pool.query(
            "SELECT COUNT(*) FROM job_applications WHERE employer_id = $1", 
            [dbEmpId]
        );
        const count = parseInt(countRes.rows[0].count) || 0;
        res.json({ success: true, count });
    } catch (error) {
        console.error("❌ Count Fetch Error:", error);
        res.status(500).json({ success: false, count: 0 });
    }
});

// --- 1-CLICK JOB REACTIVATION ---
app.put('/api/employer/jobs/:jobId/reactivate', async (req, res) => {
    const { jobId } = req.params;
    const { employerId } = req.body;
    try {
        const result = await pool.query(
            "UPDATE jobs SET status = 'approved', created_at = CURRENT_TIMESTAMP WHERE id = $1 AND employer_id = $2 RETURNING id, title",
            [jobId, employerId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Job not found or unauthorized." });
        }

        res.json({ success: true, message: `Job "${result.rows[0].title}" reactivated successfully.` });
    } catch (error) {
        console.error("❌ Job Reactivation Error:", error);
        res.status(500).json({ success: false, message: "Server error reactivating job." });
    }
});

// ==========================================
// SERVER STARTUP
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Backend server running on port ${PORT}`);
});
