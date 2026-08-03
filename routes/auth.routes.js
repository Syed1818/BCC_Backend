const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../uploads/logos');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'org-logo-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 }, 
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'));
        }
    }
});


// =====================================================================
// --- CANDIDATE REGISTRATION ---
// =====================================================================
router.post('/candidate/register', async (req, res) => {
    const data = req.body;
    
    try {
        if (!data.fullName || (!data.email && !data.phone)) {
            return res.status(400).json({ success: false, message: "Full Name and Email or Mobile Number are required." });
        }

        const cleanEmail = data.email ? data.email.trim().toLowerCase() : null;
        const cleanPhone = data.phone ? data.phone.replace(/\D/g, "").trim() : null;

        const userExists = await pool.query(
            "SELECT id FROM candidates WHERE (email IS NOT NULL AND email != '' AND LOWER(email) = $1) OR (phone IS NOT NULL AND phone != '' AND phone = $2)",
            [cleanEmail, cleanPhone]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: "An account with this Email or Mobile Number is already registered!" });
        }

        let parsedDob = null;
        if (data.dob && !isNaN(Date.parse(data.dob))) {
            parsedDob = new Date(data.dob);
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(data.password, salt);

        const min = 100000000;
        const max = 999999999;
        const random9Digit = Math.floor(Math.random() * (max - min + 1)) + min;
        const unique_id = 'BCC-UMP-CAN-' + random9Digit;

        const insertQuery = `
            INSERT INTO candidates (
                unique_id, full_name, email, phone, password, dob, gender, preferred_language, category,
                current_address, permanent_address, highest_qualification, year_of_passing, institution, 
                school_name, course, specialization, percentage_cgpa, languages_fluent, skills, 
                experience_type, years_of_experience, employment_status, current_job_role, current_company,
                resume_file_name, certifications, preferred_roles, preferred_locations, willing_to_relocate, 
                preferred_job_type, expected_salary, aadhaar_number, has_disability, disabilities_list, 
                education_status, opportunities, hear_about_us, referral_code, tnc_accepted, declaration_accepted,
                status, account_status, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 
                $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, 
                'Pending', 'Verified', NOW()
            ) RETURNING *;
        `;

        const values = [
            unique_id, data.fullName, cleanEmail, cleanPhone, hashedPassword, parsedDob, data.gender || null, 
            data.language || 'English', data.socialCategory || 'General Merit (GM)',
            JSON.stringify(data.currentAddress || {}), JSON.stringify(data.permanentAddress || {}),
            data.qualification || null, data.yearOfPassing || null, data.institution || null, data.schoolName || null,
            data.course || null, data.specialization || null, data.percentage || null,
            data.languagesFluent, 
            JSON.stringify(data.skills || []),
            data.experienceType || 'Fresher', data.experience || null, data.employmentStatus || null,
            data.currentRole || null, data.currentCompany || null, data.resumeFileName || null,
            JSON.stringify(data.certifications || []), JSON.stringify(data.preferredRoles || []),
            JSON.stringify(data.preferredLocations || []), Boolean(data.willingToRelocate),
            data.preferredJobType || 'Full-time', data.expectedSalary || null, data.aadhaar || null,
            data.hasDisability || 'No', JSON.stringify(data.disabilities || []), data.educationStatus || null,
            JSON.stringify(data.opportunities || []), data.hearAboutUs || null, data.referralCode || null,
            Boolean(data.tncAccepted), Boolean(data.declarationAccepted)
        ];

        try {
            const result = await pool.query(insertQuery, values);
            return res.status(201).json({ success: true, message: "Candidate registered successfully", uniqueId: result.rows[0].unique_id });
        } catch (dbError) {
            const fallbackQuery = `
                INSERT INTO candidates (unique_id, full_name, email, phone, password, status, account_status, created_at)
                VALUES ($1, $2, $3, $4, $5, 'Pending', 'Verified', NOW()) RETURNING *;
            `;
            const fallbackValues = [unique_id, data.fullName, cleanEmail, cleanPhone, hashedPassword];
            const fallbackResult = await pool.query(fallbackQuery, fallbackValues);
            return res.status(201).json({ success: true, message: "Candidate registered (via Fallback)", uniqueId: fallbackResult.rows[0].unique_id });
        }

    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during registration." });
    }
});


// =====================================================================
// --- EMPLOYER REGISTRATION (NEW ENTERPRISE ONBOARDING) ---
// =====================================================================

// NEW: Wrapped in Multer error handler to prevent silent 400 Bad Request crashes
router.post('/employer/register', function (req, res, next) {
    upload.single('org_logo')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ success: false, message: `File Upload Error: ${err.message}. Try uploading a smaller file.` });
        } else if (err) {
            return res.status(400).json({ success: false, message: `File Upload Error: ${err.message}` });
        }
        next();
    });
}, async (req, res) => {
    const data = req.body;

    try {
        if (!data || Object.keys(data).length === 0) {
            return res.status(400).json({ success: false, message: "Data payload is empty. Please ensure you are filling out all required fields." });
        }

        const emailInput = data.poc1_email || data.email;
        const cleanEmail = emailInput ? emailInput.trim().toLowerCase() : "";
        
        if (!cleanEmail) {
            return res.status(400).json({ success: false, message: "Error: Official Email ID is required." });
        }

        const userExists = await pool.query("SELECT * FROM employers WHERE LOWER(email) = $1", [cleanEmail]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: "This Official Email ID is already registered to another company. Please log in instead." });
        }
        
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(data.password, salt);

        const logoUrl = req.file ? `/uploads/logos/${req.file.filename}` : null;

        const parseArray = (input) => {
            if (!input) return [];
            if (Array.isArray(input)) return input;
            try { return JSON.parse(input); } catch (e) { return [input]; }
        };

        const query = `
            INSERT INTO employers (
                company_name, email, password_hash, password, status,
                website, org_type, legal_structure, core_sectors, pincode, state, district, taluk,
                mla_constituency, mp_constituency, resident_type, local_body_details, locality_area,
                current_address, map_link, org_presence, multiple_branches,
                poc1_title, poc1_name, poc1_designation, poc1_email, poc1_phone,
                poc2_title, poc2_name, poc2_designation, poc2_email, poc2_phone,
                employee_strength, hiring_for, hire_pwds, accepted_disabilities,
                org_logo_url, digital_onboarding, source_of_discovery, gst_number, is_gst_verified
            ) VALUES (
                $1, $2, $3, $4, 'pending',
                $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17,
                $18, $19, $20, $21,
                $22, $23, $24, $25, $26,
                $27, $28, $29, $30, $31,
                $32, $33, $34, $35,
                $36, $37, $38, $39, $40
            ) RETURNING id;
        `;

        const values = [
            data.company_name || "", 
            cleanEmail, 
            password_hash, 
            data.password, 
            data.website || "", 
            data.org_type || "", 
            data.legal_structure || "", 
            JSON.stringify(parseArray(data.core_sectors)), 
            data.pincode || "", 
            data.state || "", 
            data.district || "", 
            data.taluk || "",
            data.mla_constituency || "", 
            data.mp_constituency || "", 
            data.resident_type || "", 
            data.local_body_details || "", 
            data.locality_area || "",
            data.current_address || "", 
            data.map_link || "", 
            data.org_presence || "", 
            data.multiple_branches === 'true' || data.multiple_branches === true,
            data.poc1_title || "", 
            data.poc1_name || "", 
            data.poc1_designation || "", 
            cleanEmail, 
            data.poc1_phone || "",
            data.poc2_title || "", 
            data.poc2_name || "", 
            data.poc2_designation || "", 
            data.poc2_email || "", 
            data.poc2_phone || "",
            data.employee_strength || "", 
            data.hiring_for || "", 
            data.hire_pwds || "", 
            JSON.stringify(parseArray(data.accepted_disabilities)), 
            logoUrl, 
            data.digital_onboarding === 'true' || data.digital_onboarding === true, 
            data.source_of_discovery || "", 
            data.gst_number || "", 
            data.is_gst_verified === 'true' || data.is_gst_verified === true
        ];

        const result = await pool.query(query, values);
        
        const employerId = result.rows[0].id;

        res.status(201).json({ 
            success: true, 
            message: "Employer registration submitted successfully.",
            uniqueId: `EMP-${employerId}` 
        });

    } catch (error) { 
        console.error("❌ Employer Registration Database Error:", error);
        
        // This will STRICTLY catch missing DB fields or array errors and push it to the bright red UI box
        if (error.code) { 
            return res.status(400).json({ success: false, message: `Database Setup Error: ${error.detail || error.message}. Please check that your Postgres columns match exactly.` }); 
        }
        res.status(500).json({ success: false, message: "Server error during registration." }); 
    }
});


// =====================================================================
// --- MASTER AUTHENTICATION (LOGIN) ---
// =====================================================================
router.post('/login', async (req, res) => {
    const { role, password, company_name } = req.body; 
    const emailInput = req.body.email || req.body.identifier || "";

    try {
        const rawInput = emailInput.trim();
        const digitsOnly = rawInput.replace(/\D/g, "");
        const last10Digits = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;

        if (role === 'admin') {
            let adminResult = await pool.query("SELECT * FROM admins WHERE LOWER(TRIM(email)) = LOWER($1)", [rawInput]);
            let admin = null;
            let teamMember = false;

            if (adminResult.rows.length > 0) {
                admin = adminResult.rows[0];
            } else {
                const teamResult = await pool.query("SELECT * FROM admin_team WHERE LOWER(TRIM(email)) = LOWER($1)", [rawInput]);
                if (teamResult.rows.length > 0) {
                    admin = teamResult.rows[0];
                    teamMember = true;
                }
            }

            if (!admin) return res.status(401).json({ success: false, message: 'Admin account not found.' });

            let isMatch = admin.password && admin.password.startsWith('$2') 
                ? await bcrypt.compare(password, admin.password) 
                : (password === admin.password);

            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Admin Credentials.' });

            return res.json({ 
                success: true, 
                data: { id: admin.unique_id || admin.id, name: admin.full_name || 'Admin', email: admin.email, role: teamMember ? admin.role : 'admin', permissions: teamMember ? admin.permissions : {} } 
            });
        }
        
        if (role === 'employer') {
            const cleanInput = rawInput.toLowerCase();
            const cleanCompany = company_name ? company_name.trim().toLowerCase() : "";

            let employer = null;
            let loggedInId = null;
            let isHrAccount = false;

            const empResult = await pool.query("SELECT * FROM employers WHERE LOWER(TRIM(email)) = $1 OR LOWER(TRIM(company_name)) = $2", [cleanInput, cleanCompany]);

            if (empResult.rows.length > 0) {
                employer = empResult.rows[0];
                loggedInId = employer.id;
            } else {
                const hrResult = await pool.query(`
                    SELECT h.*, e.company_name, e.status as employer_status, e.id as master_employer_id
                    FROM employer_hrs h
                    JOIN employers e ON h.employer_id = e.id
                    WHERE LOWER(TRIM(h.email)) = $1 AND LOWER(TRIM(e.company_name)) = $2
                `, [cleanInput, cleanCompany]);

                if (hrResult.rows.length > 0) {
                    const hrData = hrResult.rows[0];
                    employer = { ...hrData, status: hrData.employer_status, password: hrData.password_hash };
                    loggedInId = hrData.master_employer_id;
                    isHrAccount = true;
                }
            }

            if (!employer) return res.status(401).json({ success: false, message: 'Employer or HR account not found for this company name.' });

            const currentStatus = (employer.status || 'pending').toLowerCase().trim();
            if (currentStatus === 'pending') return res.status(403).json({ success: false, message: 'Your company registration is currently PENDING admin approval.' });
            if (currentStatus === 'rejected' || currentStatus === 'blacklisted') return res.status(403).json({ success: false, message: 'Your company registration has been restricted by the admin.' });
            if (currentStatus !== 'approved') return res.status(403).json({ success: false, message: 'Account not approved for login.' });

            let isMatch = employer.password && employer.password.startsWith('$2') ? await bcrypt.compare(password, employer.password) : (password === employer.password || password === employer.password_hash);
            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Password.' });

            return res.json({ success: true, data: { id: loggedInId, name: employer.company_name, email: employer.email, role: 'employer', isHr: isHrAccount, hrName: isHrAccount ? employer.full_name : null } });
        }

        if (role === 'candidate' || !role) {
            const queryText = `
                SELECT * FROM candidates 
                WHERE LOWER(TRIM(email)) = LOWER($1) OR LOWER(TRIM(unique_id)) = LOWER($1) OR TRIM(phone) = $1 OR ($2 != '' AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $2)
            `;

            const candResult = await pool.query(queryText, [rawInput, last10Digits]);

            if (candResult.rows.length === 0) return res.status(401).json({ success: false, message: 'Candidate account not found. Please check your Email, Mobile Number, or Candidate ID.' });

            const candidate = candResult.rows[0];
            if (candidate.account_status === 'Blocked') return res.status(403).json({ success: false, message: 'Your candidate account has been blocked by administrators.' });

            let isMatch = candidate.password && candidate.password.startsWith('$2') ? await bcrypt.compare(password, candidate.password) : (password === candidate.password);
            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Password. Please try again.' });

            return res.json({ success: true, data: { id: candidate.unique_id, name: candidate.full_name, email: candidate.email, phone: candidate.phone, role: 'candidate' } });
        }
        return res.status(400).json({ success: false, message: 'Invalid role selected.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});


// =====================================================================
// --- CANDIDATE PROFILE: FETCH & UPDATE ---
// =====================================================================
router.get('/candidate/profile/:id', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM candidates WHERE unique_id = $1", [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Profile not found" });
        }
        
        const db = result.rows[0];
        
        const profileData = {
            uniqueId: db.unique_id,
            fullName: db.full_name,
            fatherName: db.father_name,
            motherName: db.mother_name,
            profilePhoto: db.profile_photo,
            backgroundImage: db.background_image,
            email: db.email,
            phone: db.phone,
            dob: db.dob ? new Date(db.dob).toISOString().split('T')[0] : "",
            gender: db.gender,
            language: db.preferred_language,
            category: db.category,
            religion: db.religion,
            aadhaar: db.aadhaar_number,
            hasDisability: db.has_disability,
            disabilities: (db.disabilities_list) ? JSON.parse(db.disabilities_list) : [],
            udid: db.udid,
            linkedinUrl: db.linkedin_url,
            githubUrl: db.github_url,

            currentAddress: db.current_address ? JSON.parse(db.current_address) : {},
            permanentAddress: db.permanent_address ? JSON.parse(db.permanent_address) : {},

            qualification: db.highest_qualification,
            institution: db.institution,
            boardUniversity: db.board_university,
            schoolName: db.school_name,
            course: db.course,
            specialization: db.specialization,
            yearOfPassing: db.year_of_passing,
            percentage: db.percentage_cgpa,

            languagesFluent: db.languages_fluent ? JSON.parse(db.languages_fluent) : [],
            technicalSkills: db.technical_skills ? JSON.parse(db.technical_skills) : [],
            nonTechnicalSkills: db.non_technical_skills ? JSON.parse(db.non_technical_skills) : [],
            skillProficiencies: db.skill_proficiencies ? JSON.parse(db.skill_proficiencies) : {},
            
            experienceType: db.experience_type,
            opportunities: db.opportunities ? JSON.parse(db.opportunities) : [],
            aspirantType: db.aspirant_type,
            preferredSectors: db.preferred_sectors ? JSON.parse(db.preferred_sectors) : [],
            preferredRoles: db.preferred_roles ? JSON.parse(db.preferred_roles) : [],
            preferredLocations: db.preferred_locations ? JSON.parse(db.preferred_locations) : [],
            willingToRelocate: db.willing_to_relocate,
            resumeFileName: db.resume_file_name
        };

        res.json({ success: true, data: profileData });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching profile." });
    }
});

router.put('/candidate/profile/update', async (req, res) => {
    const d = req.body;
    try {
        const updateQuery = `
            UPDATE candidates SET 
                full_name = $1, father_name = $2, mother_name = $3, profile_photo = $4, background_image = $5,
                dob = $6, gender = $7, preferred_language = $8, category = $9, religion = $10,
                aadhaar_number = $11, has_disability = $12, disabilities_list = $13, udid = $14,
                linkedin_url = $15, github_url = $16, current_address = $17, permanent_address = $18,
                highest_qualification = $19, institution = $20, board_university = $21, school_name = $22,
                course = $23, specialization = $24, year_of_passing = $25, percentage_cgpa = $26,
                languages_fluent = $27, technical_skills = $28, non_technical_skills = $29, skill_proficiencies = $30,
                experience_type = $31, opportunities = $32, aspirant_type = $33, preferred_sectors = $34,
                preferred_roles = $35, preferred_locations = $36, willing_to_relocate = $37, resume_file_name = $38
            WHERE unique_id = $39
        `;
        
        const safeAadhaar = (d.aadhaar && d.aadhaar.length === 12) ? "[Aadhaar Redacted]" : d.aadhaar;

        const values = [
            d.fullName, d.fatherName, d.motherName, d.profilePhoto, d.backgroundImage,
            d.dob || null, d.gender, d.language, d.category, d.religion,
            safeAadhaar, d.hasDisability, JSON.stringify(d.disabilities || []), d.udid,
            d.linkedinUrl, d.githubUrl, JSON.stringify(d.currentAddress || {}), JSON.stringify(d.permanentAddress || {}),
            d.qualification, d.institution, d.boardUniversity, d.schoolName,
            d.course, d.specialization, d.yearOfPassing, d.percentage,
            JSON.stringify(d.languagesFluent || []), JSON.stringify(d.technicalSkills || []), JSON.stringify(d.nonTechnicalSkills || []), JSON.stringify(d.skillProficiencies || {}),
            d.experienceType, JSON.stringify(d.opportunities || []), d.aspirantType, JSON.stringify(d.preferredSectors || []),
            JSON.stringify(d.preferredRoles || []), JSON.stringify(d.preferredLocations || []), Boolean(d.willingToRelocate), d.resumeFileName,
            d.uniqueId
        ];

        await pool.query(updateQuery, values);
        res.json({ success: true, message: "Profile updated successfully." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error updating profile." });
    }
});


// =====================================================================
// --- FORGOT & RESET PASSWORD ---
// =====================================================================
router.post('/forgot-password', async (req, res) => {
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

router.post('/reset-password', async (req, res) => {
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

module.exports = router;
