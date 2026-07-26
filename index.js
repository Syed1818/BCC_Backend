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
    if (err) console.error('Database connection error:', err.stack);
    else console.log('Successfully connected to the PostgreSQL database.');
});

// ==========================================
// 3. CANDIDATE REGISTRATION API
// ==========================================
app.post('/api/auth/candidate/register', async (req, res) => {
    const data = req.body;
    try {
        if (!data.fullName || (!data.email && !data.phone)) {
            return res.status(400).json({ success: false, message: "Full Name and Email/Phone are required." });
        }

        // Check for duplicates
        const userExists = await pool.query(
            "SELECT id FROM candidates WHERE (email IS NOT NULL AND email != '' AND email = $1) OR (phone IS NOT NULL AND phone != '' AND phone = $2)",
            [data.email || null, data.phone || null]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: "An account with this Email or Mobile Number already exists!" });
        }

        // Safe Date Parsing
        let parsedDob = null;
        if (data.dob && !isNaN(Date.parse(data.dob))) {
            parsedDob = new Date(data.dob);
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
            data.fullName,
            data.email || null,
            data.phone || null,
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
        res.status(201).json({ success: true, message: "Candidate registered successfully", uniqueId: result.rows[0].unique_id });
    } catch (error) {
        console.error("Candidate Register DB Error:", error);
        res.status(500).json({ success: false, message: "Database Error: " + (error.detail || error.message || "Server error during registration.") });
    }
});

// ==========================================
// 4. MASTER AUTHENTICATION (LOGIN)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { role, email, password } = req.body;

    try {
        if (role === 'candidate') {
            const candResult = await pool.query("SELECT * FROM candidates WHERE email = $1 OR unique_id = $1", [email]);
            if (candResult.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Candidate account not found.' });
            }

            const candidate = candResult.rows[0];

            if (candidate.account_status === 'Blocked') {
                return res.status(403).json({ success: false, message: 'Your candidate account has been blocked by administrators.' });
            }

            let isMatch = false;
            if (candidate.password && candidate.password.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, candidate.password);
            } else {
                isMatch = (password === candidate.password);
            }

            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid Password.' });

            return res.json({ 
                success: true, 
                data: { id: candidate.unique_id, name: candidate.full_name, email: candidate.email, role: 'candidate' } 
            });
        }

        res.status(400).json({ success: false, message: 'Invalid role selected.' });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});
