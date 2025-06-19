const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { OpenAI } = require('openai');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const puppeteer = require('puppeteer');
require('dotenv').config();
const ejs = require('ejs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { execSync, execFile } = require('child_process');
const Poppler = require('pdf-poppler');

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

// Generate multipage PDF with page breaks
async function htmlToPdf(htmlContent, outputPath) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    // Use only the EJS-rendered HTML (test.ejs) for PDF output
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.pdf({
        path: outputPath,
        format: 'A4',
        printBackground: true,
    });
    await browser.close();
}


// Call OpenAI with updated prompt requesting strict JSON output for EJS
async function getOpenAIReportJSON(text, referenceText, patientDetails) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `
You are an expert medical assistant AI.

You are given two things:
1. A reference format of normal blood test ranges
2. A patient's extracted blood test report

Your task:
- Go through the patient report.
- For each test found:
  - Match it with the reference.
  - Check if it is below or above the normal range.
  - If abnormal or normal, include it in the result JSON.

IMPORTANT:
- Respond ONLY with valid JSON. No explanation or extra text.
- Use the exact structure below.
- Fill in dummy values like "Unknown" or "N/A" if data is missing.
- For each test, provide:
  - name: The test name (e.g. Hemoglobin)
  - description: What is tested and what it means (1-2 lines)
  - value: The patient's value
  - unit: The unit (e.g. g/dL)
  - indicatorPosition: A number from 0-100 showing where the value falls in the reference range (0=low, 100=high, 50=mid)
  - referenceRange: { low, high, genderSpecific? }
  - reasons: Common reasons for abnormal results (array)
  - reasonIcons: Emoji or icon for each reason (array)
  - indications: What these results may indicate (array)
  - indicationIcons: Emoji or icon for each indication (array)

Return JSON:
{
  patient: { name: "Unknown", age: "N/A", gender: "N/A" },
  report: { date: "N/A", accessionNo: "N/A" },
  tests: [
    {
      name: string,
      description: string,
      value: string,
      unit: string,
      indicatorPosition: number,  // 0 to 100
      referenceRange: {
        low: number,
        high: number,
        genderSpecific?: boolean
      },
      reasons: [string],
      reasonIcons: [string],
      indications: [string],
      indicationIcons: [string]
    }
  ]
}

Reference Format:
${referenceText}

User Report:
${text}

Patient Details:
Name: ${patientDetails.name}
Age: ${patientDetails.age}
Gender: ${patientDetails.gender}
Date: ${patientDetails.date}
Accession No: ${patientDetails.accessionNo}
`;

    const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.7
    });

    return response.choices[0].message.content;
}
async function extractTextWithPdfjs(buffer) {
    try {
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        const pdf = await loadingTask.promise;

        let text = '';

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(' ');
            text += pageText + '\n';
        }

        if (!text.trim()) {
            throw new Error('PDF.js extracted no text. The PDF might be image-based or scanned.');
        }

        return text;
    } catch (err) {
        console.error('extractTextWithPdfjs error:', err.message);
        throw err; // Let the outer function handle this
    }
}
const { fromPath } = require("pdf2pic");

async function extractTextWithOCR(pdfPath) {
    // Use Python script to convert PDF to text via OCR
    const outputDir = './ocr-images';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log('Created ocr-images directory.');
    }
    const outputTextPath = path.join(outputDir, 'extracted_text.txt');
    try {
        console.log('Starting PDF to text extraction (Python)...');
        await new Promise((resolve, reject) => {
            execFile('python', [path.join(__dirname, 'pdf_to_image.py'), pdfPath, outputTextPath], (error, stdout, stderr) => {
                if (error) {
                    console.error('Python OCR error:', stderr || error.message);
                    return reject(new Error('Python PDF to text extraction failed.'));
                }
                if (!fs.existsSync(outputTextPath)) {
                    return reject(new Error('Text file was not created by Python script.'));
                }
                resolve();
            });
        });
        console.log('Text extraction complete. Text path:', outputTextPath);
        // Read the extracted text
        const text = fs.readFileSync(outputTextPath, 'utf-8');
        return text;
    } catch (err) {
        console.error('OCR failed:', err.message);
        if (err.stack) console.error(err.stack);
        return Promise.reject(err);
    }
}

function extractRelevantLines(text, maxLength = 2000) {
    const lines = text.split('\n').filter(line => /\d/.test(line));
    const joined = lines.join('\n');
    return joined.slice(0, maxLength);
}

function extractPatientDetails(text) {
    // Try to extract name, age, gender, date, accession no from the PDF text (more robust)
    const nameMatch = text.match(/Name\s*[:\-]?\s*([A-Za-z .]+)/i) || text.match(/Patient\s*Name\s*[:\-]?\s*([A-Za-z .]+)/i);
    const ageMatch = text.match(/Age\s*[:\-]?\s*(\d{1,3})/i);
    const genderMatch = text.match(/Gender\s*[:\-]?\s*([A-Za-z]+)/i);
    const dateMatch = text.match(/Date\s*[:\-]?\s*([\d\/-]{6,})/i) || text.match(/Report\s*Date\s*[:\-]?\s*([\d\/-]{6,})/i);
    const accessionMatch = text.match(/Accession\s*No\.?\s*[:\-]?\s*([A-Za-z0-9\/-]+)/i) || text.match(/Accession\s*Number\s*[:\-]?\s*([A-Za-z0-9\/-]+)/i);
    return {
        name: nameMatch ? nameMatch[1].trim() : 'Unknown',
        age: ageMatch ? ageMatch[1].trim() : 'N/A',
        gender: genderMatch ? genderMatch[1].trim() : 'N/A',
        date: dateMatch ? dateMatch[1].trim() : 'N/A',
        accessionNo: accessionMatch ? accessionMatch[1].trim() : 'N/A',
    };
}

router.get('/upload', isAuthenticated, (req, res) => {
    res.render('upload', { error: null, title: 'Upload Blood Report' });
});

router.post('/upload', isAuthenticated, upload.fields([
    { name: 'user_pdf', maxCount: 1 },
]), async (req, res) => {
    // Declare variables for file and text extraction
    let rawUserText = '';
    let userPdfBuffer = null;
    let userPdfPath = '';
    let patientDetails = {};

    // Get uploaded file
    if (req.files && req.files['user_pdf'] && req.files['user_pdf'][0]) {
        userPdfPath = req.files['user_pdf'][0].path;
        userPdfBuffer = fs.readFileSync(userPdfPath);
    } else {
        return res.render('upload', { error: 'No PDF file uploaded.', title: 'Upload Blood Report' });
    }

    // Try extracting text from PDF
    if (!rawUserText || !rawUserText.trim()) {
        try {
            rawUserText = await extractTextWithPdfjs(userPdfBuffer);
            console.log('Extracted with pdfjs-dist.');
        } catch (e1) {
            console.warn('PDF.js failed, trying OCR...');
            try {
                rawUserText = await extractTextWithOCR(userPdfPath); // OCR uses file path
                console.log('Extracted with OCR.');
            } catch (e2) {
                console.error('OCR also failed:', e2.message);
                return res.render('upload', {
                    error: 'Failed to extract text from PDF using all available methods.',
                    title: 'Upload Blood Report'
                });
            }
        }
    }

    // Log the full raw PDF text for debugging
    console.log("RAW PDF TEXT:\n", rawUserText);
    const userText = extractRelevantLines(rawUserText, 2000);
    // Extract patient details from the raw text
    patientDetails = extractPatientDetails(rawUserText);
    // You should fill this referenceText with the proper normal ranges or your reference format
    const referenceText = `
Hemoglobin: 13.8–17.2 g/dL (men), 12.1–15.1 g/dL (women)
RBC: 4.7–6.1 million/mcL (men), 4.2–5.4 million/mcL (women)
WBC: 4,500–11,000 cells/mcL
ALT (SGPT): 7–56 U/L → Liver Function
AST (SGOT): 10–40 U/L → Liver/Muscle
Creatinine: 0.74–1.35 mg/dL (men), 0.59–1.04 mg/dL (women)
TSH: 0.4–4.0 mIU/L → Thyroid
Calcium: 8.6–10.2 mg/dL
Platelets: 150,000–450,000 /mcL
`;
    console.log("Reference Text:\n", referenceText);
    if (!referenceText || !referenceText.trim()) {
        return res.render('upload', { error: 'Reference text is empty.', title: 'Upload Blood Report' });
    }
    let gptJson;
    try {
        let gptResponse = await getOpenAIReportJSON(userText, referenceText, patientDetails);
        // Clean numbers with commas before parsing
        gptResponse = gptResponse.replace(/(\d{1,3}),(\d{3})/g, '$1$2');
        console.log("GPT JSON Output:\n", gptResponse);
        // Extract JSON from GPT response
        const jsonMatch = gptResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return res.render('upload', { error: 'OpenAI output did not contain valid JSON. Output:\n' + gptResponse, title: 'Upload Blood Report' });
        }
        try {
            gptJson = JSON.parse(jsonMatch[0]);
        } catch (e) {
            return res.render('upload', { error: 'Failed to parse JSON from OpenAI output. Output:\n' + gptResponse, title: 'Upload Blood Report' });
        }
    } catch (e) {
        return res.render('upload', { error: 'OpenAI API/JSON error: ' + e.message, title: 'Upload Blood Report' });
    }
    // Fallbacks for missing fields to match EJS template
    if (!gptJson.patient) gptJson.patient = { name: 'Unknown', age: 'N/A', gender: 'N/A' };
    if (!gptJson.report) gptJson.report = { date: 'N/A', accessionNo: 'N/A' };
    if (!Array.isArray(gptJson.tests)) gptJson.tests = [];
    gptJson.tests = gptJson.tests.map(test => ({
        name: test.name || 'Unknown',
        description: test.description || 'N/A',
        value: test.value || 'N/A',
        unit: test.unit || '',
        indicatorPosition: typeof test.indicatorPosition === 'number' ? test.indicatorPosition : 50,
        referenceRange: test.referenceRange || { low: 0, high: 0 },
        reasons: Array.isArray(test.reasons) ? test.reasons : [],
        reasonIcons: Array.isArray(test.reasonIcons) ? test.reasonIcons : [],
        indications: Array.isArray(test.indications) ? test.indications : [],
        indicationIcons: Array.isArray(test.indicationIcons) ? test.indicationIcons : []
    }));
    // Render EJS template to HTML
    let htmlContent;
    try {
        htmlContent = await ejs.renderFile(path.join(__dirname, '../test.ejs'), gptJson, {async: true});
    } catch (e) {
        return res.render('upload', { error: 'EJS rendering failed: ' + e.message, title: 'Upload Blood Report' });
    }
    // Generate a unique output filename for each upload
    const outputFilename = `output_report_${Date.now()}.pdf`;
    const outputPath = path.join(__dirname, '../public/uploads', outputFilename);
    try {
        await htmlToPdf(htmlContent, outputPath);
    } catch (e) {
        return res.render('upload', { error: 'PDF generation failed: ' + e.message, title: 'Upload Blood Report' });
    }
    res.download(outputPath, 'blood_report.pdf');
});

module.exports = router;