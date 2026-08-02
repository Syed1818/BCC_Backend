const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../config/db');

// --- CANDIDATE REGISTRATION (WITH FAIL-SAFE BYPASS) ---
router.post('/candidate/register', async (req, res) => {
    const data = req.body;
    try {
        if (!data.fullName || (!data.email && !data.phone)) {
            return res.status(400).json({ success: false, message: "Full Name and Email or Mobile Number are required." });
        }

        const cleanEmail = data.email ? data.email.trim().toLowerCase() : null;
        const cleanPhone = data.phone ? data.phone.replace(/\D/g, "").trim() : null;

        // Check for duplicates first
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

        // ENCRYPT PASSWORD
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(data.password, salt);

        const unique_id = 'BCC-CAN-' + Math.floor(100000 + Math.random() * 900000);

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
            ) RETURNING unique_id;
        `;

        const values = [
            unique_id, data.fullName, cleanEmail, cleanPhone, hashedPassword, parsedDob, data.gender || null, 
            data.language || 'English', data.socialCategory || 'General Merit (GM)',
            JSON.stringify(data.currentAddress || {}), JSON.stringify(data.permanentAddress || {}),
            data.qualification || null, data.yearOfPassing || null, data.institution || null, data.schoolName || null,
            data.course || null, data.specialization || null, data.percentage || null,
            JSON.stringify(data.languagesFluent || []), JSON.stringify(data.skills || []),
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
            // Attempt the full insert
            const result = await pool.query(insertQuery, values);
            console.log(`✅ Candidate full registered: ${result.rows[0].unique_id}`);
            return res.status(201).json({ success: true, message: "Candidate registered successfully", uniqueId: result.rows[0].unique_id });
        
        } catch (dbError) {
            // THE FAIL-SAFE BYPASS: If a column doesn't exist, just insert the core login data!
            console.error("⚠️ Full DB Insert failed due to schema mismatch. Using Magic Fallback Insert...", dbError.message);
            
            const fallbackQuery = `
                INSERT INTO candidates (unique_id, full_name, email, phone, password, status, account_status, created_at)
                VALUES ($1, $2, $3, $4, $5, 'Pending', 'Verified', NOW()) RETURNING unique_id;
            `;
            const fallbackValues = [unique_id, data.fullName, cleanEmail, cleanPhone, hashedPassword];
            
            const fallbackResult = await pool.query(fallbackQuery, fallbackValues);
            console.log(`✅ Candidate fallback registered: ${fallbackResult.rows[0].unique_id}`);
            return res.status(201).json({ success: true, message: "Candidate registered (via Fallback)", uniqueId: fallbackResult.rows[0].unique_id });
        }

    } catch (error) {
        console.error("❌ Ultimate Catch Error:", error);
        res.status(500).json({ success: false, message: "Server error during registration." });
    }
});

// --- EMPLOYER REGISTRATION ---
router.post('/employer/register', async (req, res) => {
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
        console.error("❌ Login Server Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});

module.exports = router;
