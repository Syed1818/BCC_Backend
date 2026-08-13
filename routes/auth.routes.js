const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// --- AWS SES Integration ---
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const sesClient = new SESClient({ region: 'ap-south-1' });
const otpStore = new Map(); // In-memory OTP storage

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
// --- OTP EMAIL VERIFICATION (AWS SES) ---
// =====================================================================

// 1. Send OTP
router.post('/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required.' });
        }

        const cleanEmail = email.toLowerCase().trim();

        // --- NEW DB CHECK: Ensure email isn't already registered ---
        const userExists = await pool.query(
            "SELECT id FROM candidates WHERE email IS NOT NULL AND email != '' AND LOWER(email) = $1",
            [cleanEmail]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: "This email is already registered. Please log in instead." 
            });
        }
        // -----------------------------------------------------------

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

        otpStore.set(cleanEmail, { otp, expiresAt });

        const mailParams = {
            Source: '"Bharat Career Connect" <noreply@nammaudyogamela.com>',
            Destination: { ToAddresses: [cleanEmail] },
            Message: {
                Subject: { Data: 'Your OTP Code — Bharat Career Connect' },
                Body: {
                    Html: {
                        Data: `
                            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; border: 1px solid #e0e0e0; border-radius: 8px;">
                                <h2 style="color: #0b1f3a; text-align: center;">Bharat Career Connect</h2>
                                <p>Hello,</p>
                                <p>Your 6-digit verification OTP for registration is:</p>
                                <div style="background-color: #f4f6f8; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #ff9933; border-radius: 6px; margin: 20px 0;">
                                    ${otp}
                                </div>
                                <p>This code is valid for <strong>10 minutes</strong>. Do not share it with anyone.</p>
                            </div>
                        `
                    }
                }
            }
        };

        await sesClient.send(new SendEmailCommand(mailParams));
        return res.json({ success: true, message: 'OTP sent successfully.' });
    } catch (error) {
        console.error('SES Send OTP Error:', error);
        return res.status(500).json({ success: false, message: 'Failed to send OTP.' });
    }
});

// 2. Verify OTP
router.post('/verify-otp', (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
        }

        const cleanEmail = email.toLowerCase().trim();
        const record = otpStore.get(cleanEmail);

        if (!record) {
            return res.status(400).json({ success: false, message: 'OTP expired or not requested.' });
        }

        if (Date.now() > record.expiresAt) {
            otpStore.delete(cleanEmail);
            return res.status(400).json({ success: false, message: 'OTP has expired.' });
        }

        if (record.otp !== otp.trim()) {
            return res.status(400).json({ success: false, message: 'Invalid OTP. Please check and try again.' });
        }

        otpStore.delete(cleanEmail);
        return res.json({ success: true, message: 'Email verified successfully!' });
    } catch (error) {
        console.error('Verify OTP Error:', error);
        return res.status(500).json({ success: false, message: 'Verification failed.' });
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

        // COMBINE SOFT SKILLS AND REGULAR SKILLS
        const allSkills = [...(data.skills || []), ...(data.softSkills || [])];

        const insertQuery = `
            INSERT INTO candidates (
                unique_id, full_name, email, phone, password, dob, gender, preferred_language, category, special_category, father_name, mother_name,
                current_address, permanent_address, highest_qualification, year_of_passing, institution, 
                school_name, course, specialization, percentage_cgpa, languages_fluent, skills, 
                experience_type, years_of_experience, employment_status, current_job_role, current_company,
                resume_file_name, certifications, preferred_roles, preferred_locations, willing_to_relocate, 
                preferred_job_type, expected_salary, aadhaar_number, has_disability, disabilities_list, 
                education_status, opportunities, hear_about_us, referral_code, tnc_accepted, declaration_accepted,
                status, account_status, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 
                $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, 
                'Pending', 'Verified', NOW()
            ) RETURNING *;
        `;

        const values = [
            unique_id, data.fullName, cleanEmail, cleanPhone, hashedPassword, parsedDob, data.gender || null, 
            data.language || 'English', data.socialCategory || null, data.specialCategory || null, data.fatherName || null, data.motherName || null,
            JSON.stringify(data.currentAddress || {}), JSON.stringify(data.permanentAddress || {}),
            data.qualification || null, data.yearOfPassing || null, data.institution || null, data.schoolName || null,
            data.course || null, data.specialization || null, data.percentage || null,
            data.languagesFluent, 
            JSON.stringify(allSkills), // Store combined skills
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
            console.error("DB Insert Error:", dbError);
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
// --- GST VERIFICATION API (SECURE BACKEND PROXY) ---
// =====================================================================
const axios = require('axios');

// We keep the API key here so the frontend never sees it
const GST_API_KEY = "gstv_2398b5affde7c36272a7798baa0c6f86a6ec2833841d8115";

// 1. Fetch Captcha from GSTVerify
router.get('/employer/gst-captcha', async (req, res) => {
    try {
        const response = await axios.get('https://api.gstverify.co.in/v1/captcha', {
            headers: {
                'Authorization': `Bearer ${GST_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return res.json(response.data);
    } catch (error) {
        console.error("GST Captcha Fetch Error:", error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: "Failed to load GST Captcha" });
    }
});

// 2. Verify GST number using the solved Captcha
router.post('/employer/gst-verify', async (req, res) => {
    const { gst_number, captcha_text, captcha_id } = req.body;
    
    if (!gst_number) {
        return res.status(400).json({ success: false, message: "GST Number is required." });
    }

    try {
        const response = await axios.post('https://api.gstverify.co.in/v1/verify', {
            gstin: gst_number,
            captcha: captcha_text,
            captcha_id: captcha_id
        }, {
            headers: {
                'Authorization': `Bearer ${GST_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        return res.json(response.data);
    } catch (error) {
        console.error("GST Verify Error:", error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: "Failed to verify GST number. Please try again." });
    }
});

// =====================================================================
// --- EMPLOYER REGISTRATION (NEW ENTERPRISE ONBOARDING) ---
// =====================================================================

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
            parseArray(data.core_sectors),
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
            parseArray(data.accepted_disabilities),
            logoUrl, 
            data.digital_onboarding === 'true' || data.digital_onboarding === true, 
            data.source_of_discovery || "", 
            data.gst_number || "", 
            data.is_gst_verified === 'true' || data.is_gst_verified === true
        ];

        const result = await pool.query(query, values);
        
        // --- 9-DIGIT FORMATTING AND SAVING TO DATABASE ---
        const employerId = result.rows[0].id;
        const formattedId = String(employerId).padStart(9, '0');
        const uniqueId = `BCC-UMP-EMP-${formattedId}`;

        // Save the unique_id back into the employers table
        await pool.query("UPDATE employers SET unique_id = $1 WHERE id = $2", [uniqueId, employerId]);

        res.status(201).json({ 
            success: true, 
            message: "Employer registration submitted successfully.",
            uniqueId: uniqueId 
        });

    } catch (error) { 
        console.error("❌ Employer Registration Database Error:", error);
        
        if (error.code) { 
            return res.status(400).json({ success: false, message: `Database Setup Error: ${error.detail || error.message}. Please check that your Postgres columns match exactly.` }); 
        }
        res.status(500).json({ success: false, message: "Server error during registration." }); 
    }
});


// =====================================================================
// --- EMPLOYER PROFILE & PoC MANAGEMENT ---
// =====================================================================

// 1. Fetch Company Profile Data
router.get('/employer/profile/:id', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM employers WHERE id = $1", [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employer profile not found" });
        }
        
        const db = result.rows[0];
        const profileData = {
            id: db.id,
            uniqueId: db.unique_id || `BCC-UMP-EMP-${String(db.id).padStart(9, '0')}`,
            company_name: db.company_name,
            email: db.email,
            website: db.website,
            org_type: db.org_type,
            legal_structure: db.legal_structure,
            core_sectors: db.core_sectors || [],
            pincode: db.pincode,
            state: db.state,
            district: db.district,
            taluk: db.taluk,
            mla_constituency: db.mla_constituency,
            mp_constituency: db.mp_constituency,
            resident_type: db.resident_type,
            local_body_details: db.local_body_details,
            locality_area: db.locality_area,
            current_address: db.current_address,
            map_link: db.map_link,
            org_presence: db.org_presence,
            multiple_branches: db.multiple_branches,
            poc1_title: db.poc1_title,
            poc1_name: db.poc1_name,
            poc1_designation: db.poc1_designation,
            poc1_email: db.poc1_email,
            poc1_phone: db.poc1_phone,
            poc2_title: db.poc2_title,
            poc2_name: db.poc2_name,
            poc2_designation: db.poc2_designation,
            poc2_email: db.poc2_email,
            poc2_phone: db.poc2_phone,
            employee_strength: db.employee_strength,
            hiring_for: db.hiring_for,
            hire_pwds: db.hire_pwds,
            accepted_disabilities: db.accepted_disabilities || [],
            org_logo_url: db.org_logo_url,
            gst_number: db.gst_number,
            is_gst_verified: db.is_gst_verified,
            status: db.status,
            about_us: db.about_us || ""
        };

        res.json({ success: true, data: profileData });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching employer profile." });
    }
});

// 2. Update Company Profile Data
router.put('/employer/profile/update', upload.single('org_logo'), async (req, res) => {
    const d = req.body;
    try {
        const parseArray = (input) => {
            if (!input) return [];
            if (Array.isArray(input)) return input;
            try { return JSON.parse(input); } catch (e) { return [input]; }
        };

        let logoUpdateQuery = "";
        let logoValue = [];
        let valCount = 36;

        if (req.file) {
            const logoUrl = `/uploads/logos/${req.file.filename}`;
            logoUpdateQuery = `, org_logo_url = $${valCount}`;
            logoValue.push(logoUrl);
            valCount++;
        }

        const updateQuery = `
            UPDATE employers SET 
                company_name = $1, website = $2, org_type = $3, legal_structure = $4, core_sectors = $5,
                pincode = $6, state = $7, district = $8, taluk = $9, mla_constituency = $10,
                mp_constituency = $11, resident_type = $12, local_body_details = $13, locality_area = $14,
                current_address = $15, map_link = $16, org_presence = $17, multiple_branches = $18,
                poc1_title = $19, poc1_name = $20, poc1_designation = $21, poc1_phone = $22,
                poc2_title = $23, poc2_name = $24, poc2_designation = $25, poc2_email = $26, poc2_phone = $27,
                employee_strength = $28, hiring_for = $29, hire_pwds = $30, accepted_disabilities = $31,
                gst_number = $32, is_gst_verified = $33, about_us = $34
                ${logoUpdateQuery}
            WHERE id = $35
        `;

        const values = [
            d.company_name, d.website, d.org_type, d.legal_structure, parseArray(d.core_sectors),
            d.pincode, d.state, d.district, d.taluk, d.mla_constituency,
            d.mp_constituency, d.resident_type, d.local_body_details, d.locality_area,
            d.current_address, d.map_link, d.org_presence, d.multiple_branches === 'true',
            d.poc1_title, d.poc1_name, d.poc1_designation, d.poc1_phone,
            d.poc2_title, d.poc2_name, d.poc2_designation, d.poc2_email, d.poc2_phone,
            d.employee_strength, d.hiring_for, d.hire_pwds, parseArray(d.accepted_disabilities),
            d.gst_number, d.is_gst_verified === 'true', d.about_us || null,
            d.id, ...logoValue
        ];

        await pool.query(updateQuery, values);
        res.json({ success: true, message: "Company profile updated successfully." });
    } catch (error) {
        console.error("Profile Update Error:", error);
        res.status(500).json({ success: false, message: "Server error updating profile." });
    }
});

// 3. Fetch Added PoCs (Sub-Accounts)
router.get('/employer/:id/hrs', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, full_name, email, phone, designation, status FROM employer_hrs WHERE employer_id = $1", [req.params.id]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error fetching PoC details." });
    }
});

// 4. Add a new PoC (Max 3 Allowed)
router.post('/employer/:id/hrs', async (req, res) => {
    const employerId = req.params.id;
    const { full_name, email, phone, designation, password } = req.body;
    
    try {
        const countRes = await pool.query("SELECT COUNT(*) FROM employer_hrs WHERE employer_id = $1", [employerId]);
        if (parseInt(countRes.rows[0].count) >= 3) {
            return res.status(400).json({ success: false, message: "Maximum of 3 additional PoC accounts allowed." });
        }

        const emailCheck = await pool.query("SELECT email FROM employers WHERE email = $1 UNION SELECT email FROM employer_hrs WHERE email = $1", [email]);
        if (emailCheck.rows.length > 0) return res.status(400).json({ success: false, message: "This Email is already associated with an account." });

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        await pool.query(
            "INSERT INTO employer_hrs (employer_id, full_name, email, phone, designation, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, 'active')",
            [employerId, full_name, email, phone, designation, password_hash]
        );

        res.json({ success: true, message: "PoC account created successfully. They can now log in!" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error creating PoC account." });
    }
});

// 5. Delete a PoC Sub-Account
router.delete('/employer/hrs/:hrId', async (req, res) => {
    try {
        await pool.query("DELETE FROM employer_hrs WHERE id = $1", [req.params.hrId]);
        res.json({ success: true, message: "PoC account removed." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error removing PoC account." });
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
                    SELECT h.*, e.company_name, e.status as employer_status, e.id as master_employer_id, e.unique_id as master_unique_id
                    FROM employer_hrs h
                    JOIN employers e ON h.employer_id = e.id
                    WHERE LOWER(TRIM(h.email)) = $1 AND LOWER(TRIM(e.company_name)) = $2
                `, [cleanInput, cleanCompany]);

                if (hrResult.rows.length > 0) {
                    const hrData = hrResult.rows[0];
                    employer = { ...hrData, status: hrData.employer_status, password: hrData.password_hash, unique_id: hrData.master_unique_id };
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

            return res.json({ 
                success: true, 
                data: { 
                    id: employer.unique_id || `BCC-UMP-EMP-${String(loggedInId).padStart(9, '0')}`, 
                    dbId: loggedInId, 
                    name: employer.company_name, 
                    email: employer.email, 
                    role: 'employer', 
                    isHr: isHrAccount, 
                    hrName: isHrAccount ? employer.full_name : null 
                } 
            });
        }

        if (role === 'exhibitor') {
            const cleanInput = rawInput.toLowerCase();
            const cleanCompany = company_name ? company_name.trim().toLowerCase() : "";

            const exhResult = await pool.query(
                "SELECT * FROM exhibitors WHERE LOWER(TRIM(email)) = $1 OR LOWER(TRIM(company_name)) = $2", 
                [cleanInput, cleanCompany]
            );

            if (exhResult.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Exhibitor account not found for this company name.' });
            }

            const exhibitor = exhResult.rows[0];
            const currentStatus = (exhibitor.status || 'pending').toLowerCase().trim();

            if (currentStatus === 'pending') return res.status(403).json({ success: false, message: 'Your exhibitor registration is currently PENDING admin approval.' });
            if (currentStatus === 'rejected' || currentStatus === 'blacklisted') return res.status(403).json({ success: false, message: 'Your exhibitor registration has been restricted by the admin.' });
            if (currentStatus !== 'approved') return res.status(403).json({ success: false, message: 'Account not approved for login.' });

            let isMatch = exhibitor.password && exhibitor.password.startsWith('$2') 
                ? await bcrypt.compare(password, exhibitor.password) 
                : (password === exhibitor.password);

            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Password.' });

            return res.json({ 
                success: true, 
                data: { 
                    id: exhibitor.unique_id || `BCC-UMP-EXH-${String(exhibitor.id).padStart(9, '0')}`, 
                    dbId: exhibitor.id,
                    name: exhibitor.company_name, 
                    email: exhibitor.email, 
                    role: 'exhibitor' 
                } 
            });
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
        const param = req.params.id ? req.params.id.trim() : "";

        // Flexible lookup: search by unique_id, email, or phone number
        const result = await pool.query(
            `SELECT * FROM candidates 
             WHERE LOWER(TRIM(unique_id)) = LOWER($1) 
                OR LOWER(TRIM(email)) = LOWER($1) 
                OR TRIM(phone) = $1`, 
            [param]
        );

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
            
            // Map categories correctly for frontend component matching
            socialCategory: db.category,
            category: db.category, 
            specialCategory: db.special_category,
            
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
        console.error("Fetch profile error:", error);
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
                preferred_roles = $35, preferred_locations = $36, willing_to_relocate = $37, resume_file_name = $38,
                special_category = $39
            WHERE unique_id = $40
        `;
        
        const safeAadhaar = (d.aadhaar && d.aadhaar.length === 12) ? "[Aadhaar Redacted]" : d.aadhaar;

        const values = [
            d.fullName, d.fatherName, d.motherName, d.profilePhoto, d.backgroundImage,
            d.dob || null, d.gender, d.language, (d.socialCategory || d.category), d.religion,
            safeAadhaar, d.hasDisability, JSON.stringify(d.disabilities || []), d.udid,
            d.linkedinUrl, d.githubUrl, JSON.stringify(d.currentAddress || {}), JSON.stringify(d.permanentAddress || {}),
            d.qualification, d.institution, d.boardUniversity, d.schoolName,
            d.course, d.specialization, d.yearOfPassing, d.percentage,
            JSON.stringify(d.languagesFluent || []), JSON.stringify(d.technicalSkills || []), JSON.stringify(d.nonTechnicalSkills || []), JSON.stringify(d.skillProficiencies || {}),
            d.experienceType, JSON.stringify(d.opportunities || []), d.aspirantType, JSON.stringify(d.preferredSectors || []),
            JSON.stringify(d.preferredRoles || []), JSON.stringify(d.preferredLocations || []), Boolean(d.willingToRelocate), d.resumeFileName,
            d.specialCategory || null, d.uniqueId
        ];

        await pool.query(updateQuery, values);
        res.json({ success: true, message: "Profile updated successfully." });
    } catch (error) {
        console.error("Profile update error:", error);
        res.status(500).json({ success: false, message: "Server error updating profile." });
    }
});


// =====================================================================
// --- FORGOT & RESET PASSWORD ---
// =====================================================================
router.post('/forgot-password', async (req, res) => {
    const { identifier, role } = req.body;
    const cleanEmail = identifier ? identifier.trim().toLowerCase() : "";

    // Strictly require a valid email format for password resets
    if (!cleanEmail || !cleanEmail.includes('@')) {
        return res.status(400).json({ success: false, message: "Please provide a valid registered email address." });
    }

    try {
        let result;

        // Route the forgotten password check to the correct database table
        if (role === 'employer') {
            result = await pool.query("SELECT id FROM employers WHERE LOWER(TRIM(email)) = $1", [cleanEmail]);
        } else if (role === 'exhibitor') {
            result = await pool.query("SELECT id FROM exhibitors WHERE LOWER(TRIM(email)) = $1", [cleanEmail]);
        } else {
            result = await pool.query("SELECT id FROM candidates WHERE LOWER(TRIM(email)) = $1", [cleanEmail]);
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "No registered account found with this email." });
        }

        // --- AWS SES OTP GENERATION & SENDING ---
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

        otpStore.set(cleanEmail, { otp, expiresAt });

        const mailParams = {
            Source: '"Bharat Career Connect" <noreply@nammaudyogamela.com>',
            Destination: { ToAddresses: [cleanEmail] },
            Message: {
                Subject: { Data: 'Password Reset OTP — Bharat Career Connect' },
                Body: {
                    Html: {
                        Data: `
                            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; border: 1px solid #e0e0e0; border-radius: 8px;">
                                <h2 style="color: #0b1f3a; text-align: center;">Bharat Career Connect</h2>
                                <p>Hello,</p>
                                <p>We received a request to reset your password. Your 6-digit OTP is:</p>
                                <div style="background-color: #f4f6f8; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #ff9933; border-radius: 6px; margin: 20px 0;">
                                    ${otp}
                                </div>
                                <p>This code is valid for <strong>10 minutes</strong>. If you did not request a password reset, please ignore this email.</p>
                            </div>
                        `
                    }
                }
            }
        };

        await sesClient.send(new SendEmailCommand(mailParams));
        return res.json({ success: true, message: `6-Digit OTP sent successfully to ${cleanEmail}` });

    } catch (err) {
        console.error("Forgot Password Error:", err);
        return res.status(500).json({ success: false, message: "Server error checking account or sending email." });
    }
});

// --- NEW ENDPOINT: VERIFY OTP BEFORE RESET ---
router.post('/verify-reset-otp', (req, res) => {
    try {
        const { identifier, otp } = req.body;
        const cleanEmail = identifier ? identifier.trim().toLowerCase() : "";

        if (!cleanEmail || !otp) {
            return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
        }

        const record = otpStore.get(cleanEmail);

        if (!record) {
            return res.status(400).json({ success: false, message: 'OTP expired or not requested.' });
        }

        if (Date.now() > record.expiresAt) {
            otpStore.delete(cleanEmail);
            return res.status(400).json({ success: false, message: 'OTP has expired.' });
        }

        if (record.otp !== otp.trim()) {
            return res.status(400).json({ success: false, message: 'Invalid OTP entered. Please try again.' });
        }

        // We DO NOT delete the OTP here yet, because we need it to verify the actual password reset.
        return res.json({ success: true, message: 'OTP verified successfully!' });
    } catch (error) {
        console.error('Verify Reset OTP Error:', error);
        return res.status(500).json({ success: false, message: 'Verification failed.' });
    }
});

router.post('/reset-password', async (req, res) => {
    const { identifier, otp, newPassword, role } = req.body;
    const cleanEmail = identifier ? identifier.trim().toLowerCase() : "";

    if (!cleanEmail || !otp || !newPassword) {
        return res.status(400).json({ success: false, message: "Email, OTP, and new password are required." });
    }

    // --- VERIFY OTP AGAINST MEMORY STORE ---
    const record = otpStore.get(cleanEmail);

    if (!record) {
        return res.status(400).json({ success: false, message: 'OTP expired or not requested.' });
    }

    if (Date.now() > record.expiresAt) {
        otpStore.delete(cleanEmail);
        return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
    }

    if (record.otp !== otp.trim()) {
        return res.status(400).json({ success: false, message: 'Invalid OTP. Please check and try again.' });
    }

    // OTP is valid. Now update the password.
    try {
        let result;
        const salt = await bcrypt.genSalt(10);
        const hashed = await bcrypt.hash(newPassword, salt);

        // Route the password update to the correct database table
        if (role === 'employer') {
            result = await pool.query(
                "UPDATE employers SET password_hash = $1, password = $2 WHERE LOWER(TRIM(email)) = $3 RETURNING id",
                [hashed, newPassword, cleanEmail]
            );
        } else if (role === 'exhibitor') {
            result = await pool.query(
                "UPDATE exhibitors SET password = $1 WHERE LOWER(TRIM(email)) = $2 RETURNING id",
                [hashed, cleanEmail]
            );
        } else {
            result = await pool.query(
                "UPDATE candidates SET password = $1 WHERE LOWER(TRIM(email)) = $2 RETURNING unique_id",
                [hashed, cleanEmail] // Storing hashed password for candidates as well for top security!
            );
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Account update failed. User not found." });
        }

        // Clean up the OTP store after successful reset
        otpStore.delete(cleanEmail);

        return res.json({ success: true, message: "Password updated successfully! You can now log in." });
    } catch (err) {
        console.error("Reset Password DB Error:", err);
        return res.status(500).json({ success: false, message: "Database error updating password." });
    }
});

// =====================================================================
// --- EXHIBITOR REGISTRATION ---
// =====================================================================
router.post('/exhibitor/register', async (req, res) => {
    const data = req.body;

    try {
        if (!data.company_name || !data.email || !data.password) {
            return res.status(400).json({ success: false, message: "Company Name, Email, and Password are required." });
        }

        const cleanEmail = data.email.trim().toLowerCase();

        // Check if email already exists in exhibitors
        const userExists = await pool.query("SELECT * FROM exhibitors WHERE LOWER(email) = $1", [cleanEmail]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: "This Email is already registered as an exhibitor. Please log in." });
        }
        
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(data.password, salt);

        const query = `
            INSERT INTO exhibitors (company_name, email, phone, password, status) 
            VALUES ($1, $2, $3, $4, 'pending') RETURNING id;
        `;

        const values = [
            data.company_name.trim(), 
            cleanEmail, 
            data.phone || null, 
            password_hash
        ];

        const result = await pool.query(query, values);
        
        // --- 9-DIGIT FORMATTING AND SAVING TO DATABASE ---
        const exhibitorId = result.rows[0].id;
        const formattedId = String(exhibitorId).padStart(9, '0');
        const uniqueId = `BCC-UMP-EXH-${formattedId}`;

        // Save the unique_id back into the exhibitors table
        await pool.query("UPDATE exhibitors SET unique_id = $1 WHERE id = $2", [uniqueId, exhibitorId]);

        res.status(201).json({ 
            success: true, 
            message: "Exhibitor registration submitted successfully! Pending admin approval.",
            uniqueId: uniqueId 
        });

    } catch (error) { 
        console.error("❌ Exhibitor Registration Error:", error);
        res.status(500).json({ success: false, message: "Server error during registration." }); 
    }
});

module.exports = router;
