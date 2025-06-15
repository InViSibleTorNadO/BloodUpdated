const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { OpenAI } = require('openai');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const puppeteer = require('puppeteer');
require('dotenv').config();

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../public/uploads'));
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

router.get('/upload', isAuthenticated, (req, res) => {
    res.render('upload', { error: null, title: 'Upload Blood Report' });
});

// Helper: Generate PDF from HTML using Puppeteer
async function htmlToPdf(htmlContent, outputPath) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.pdf({ path: outputPath, format: 'A4' });
    await browser.close();
}

// Helper: Call OpenAI API
async function getOpenAIReport(text, referenceText) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `Reference Format:\n${referenceText}\n\nUser Report:\n${text}\n\nWrite ONLY the effects, symptoms, and precautions for the user's blood report, pointwise. ONLY include items that are NOT in the normal range—do NOT mention normal findings. For each abnormal result, explain all three aspects: effects, symptoms, and precautions, in detail. Do not just compare to normal—explain what it means for the user. Prioritize findings from highest to lowest risk or urgency, and print higher priority issues first. Use all 4096 tokens, be exhaustive, and format the output as interactive, colored HTML with clear sections, paragraphs, and bullet points. Each point should be detailed and user-focused.\n\nAt the very top of the report, you must always list exactly three conditions: one as 'Severe Condition', one as 'Mid Condition', and one as 'Less Focused Condition'. For each, select the most relevant abnormal result and provide a short summary, marking them clearly with a much larger font size (minimum 30px, set with !important). Do not use bold or red color. These three must always be present and visually distinct, regardless of the findings.\n\nIMPORTANT: Use the maximum number of tokens possible (4096) and make the report as detailed, comprehensive, visually attractive, and well-maintained as possible. The report must look beautiful and professional, with clear structure, good use of color, spacing, and modern design. For every abnormal value, clearly list the test name, the user's value, and the normal reference range in a table or well-formatted list before the explanation. If you have extra space, expand on effects, symptoms, and precautions, and add more user-focused advice, context, and explanations. The report must look beautiful and professional, similar to your previous outputs.`;
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 4096,
            temperature: 0.7
        });
        return response.choices[0].message.content;
    } catch (e) {
        console.error('OpenAI API error:', e.response ? e.response.data : e.message);
        throw e;
    }
}

// Helper: Extract relevant lines from PDF text (e.g., lines with numbers)
function extractRelevantLines(text, maxLength = 2000) {
    const lines = text.split('\n').filter(line => /\d/.test(line));
    const joined = lines.join('\n');
    return joined.slice(0, maxLength);
}

router.post('/upload', isAuthenticated, upload.fields([
    { name: 'user_pdf', maxCount: 1 },
]), async (req, res) => {
    if (!req.files['user_pdf']) {
        return res.render('upload', { error: 'Please upload PDF.', title: 'Upload Blood Report' });
    }
    // Extract text from user PDF
    const userPdfPath = req.files['user_pdf'][0].path;
    const userPdfBuffer = fs.readFileSync(userPdfPath);
    const rawUserText = (await pdfParse(userPdfBuffer)).text;
    const userText = extractRelevantLines(rawUserText, 2000);
    // Get HTML report from OpenAI
    let htmlContent;
    try {
        htmlContent = await getOpenAIReport(userText);
    } catch (e) {
        return res.render('upload', { error: 'OpenAI API error: ' + e.message, title: 'Upload Blood Report' });
    }
    // Generate PDF from HTML
    const outputPath = path.join(__dirname, '../public/uploads', 'output_report.pdf');
    await htmlToPdf(htmlContent, outputPath);
    res.download(outputPath, 'report.pdf');
});

module.exports = router;
