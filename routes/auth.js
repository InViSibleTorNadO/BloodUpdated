const express = require('express');
const router = express.Router();
const User = require('../models/User');

router.get('/login', (req, res) => {
    res.render('login', { error: null, title: 'Login' });
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (user && await user.comparePassword(password)) {
        req.session.user = user._id;
        return res.redirect('/upload');
    }
    res.render('login', { error: 'Invalid credentials', title: 'Login' });
});

router.get('/register', (req, res) => {
    res.render('register', { error: null, title: 'Register' });
});

router.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        await User.create({ username, password });
        res.redirect('/login');
    } catch (e) {
        res.render('register', { error: 'User already exists', title: 'Register' });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

module.exports = router;
