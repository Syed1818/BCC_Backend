const express = require('express');
const cors = require('cors');
const pool = require('./config/db'); // Use your new DB config!

// 1. IMPORT MODULAR ROUTERS
const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const candidateRoutes = require('./routes/candidate.route');
const employerRoutes = require('./routes/employer.routes');
const exhibitorRoutes = require('./routes/exhibitor.routes'); // <-- NEW Exhibitor Routes
const eventRoutes = require('./routes/events.routes');         
const applicationRoutes = require('./routes/applications.routes'); 

const app = express();
const PORT = process.env.PORT || 5000;

// 2. MIDDLEWARE
app.use(cors({ origin: '*' })); 
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 3. HEALTH CHECK
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: "online", db: "connected", timestamp: new Date() });
    } catch (err) {
        res.status(500).json({ status: "online", db: "error", error: err.message });
    }
});

// 4. MOUNT ROUTERS
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/candidate', candidateRoutes);
app.use('/api/employer', employerRoutes);
app.use('/api/exhibitor', exhibitorRoutes);      // <-- MOUNTED Exhibitor Routes
app.use('/api/events', eventRoutes);             
app.use('/api/applications', applicationRoutes); 

// 5. SERVER STARTUP
app.listen(PORT, () => {
    console.log(`🚀 Backend server running modularly on port ${PORT}`);
});
