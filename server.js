const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const engine = require('ejs-mate');
const authRoutes = require('./routes/auth');
const pdfRoutes = require('./routes/pdf');
require('dotenv').config();

const app = express();

// Set ejs-mate as the rendering engine for EJS
app.engine('ejs', engine);


// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 60 * 1000 } // 30 minutes
}));

// Static files
app.use(express.static('public'));

// View engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Routes
app.get('/', (req, res) => {
    res.render('login', { error: null, title: 'Login' });
});
app.use('/', authRoutes);
app.use('/', pdfRoutes);

// MongoDB connection and server start
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/bloodrest', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('MongoDB connected');
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('MongoDB connection error:', err);
});
