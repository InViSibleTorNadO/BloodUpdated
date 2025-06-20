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


// Call OpenAI with improved prompt for strict and complete JSON output for EJS
async function getOpenAIReportJSON(text, referenceText, patientDetails) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `
You are a medical data extraction AI. Your job is to extract all possible blood test results from the following patient report text, match them to the reference ranges, and fill in as much detail as possible in the output JSON. If any field is missing in the report, use "Unknown" or "N/A". If a value is present but the unit or reference is missing, make a best guess based on the reference section. Do not skip any test you can find, even if the value or unit is unclear.

For each test, also provide:
- a brief explanation (1-2 lines) of what the test measures and what abnormal results may indicate, in simple terms for a patient.
- for each reason in the 'reasons' array, add a 'reasonDetails' array (same length) with a 1-2 line simple explanation for each reason, so even a 5th class student can understand.
- for each indication in the 'indications' array, add an 'indicationDetails' array (same length) with a 1-2 line simple explanation for each indication.

Return ONLY valid JSON in the following format (no explanation, no extra text):
{
  patient: { name: string, age: string, gender: string },
  report: { date: string, accessionNo: string },
  tests: [
    {
      name: string, // test name (e.g. Hemoglobin)
      description: string, // what is tested and what it means (4 lines)
      explanation: string, // 1-2 line summary of what the test means and what abnormal results may indicate
      value: string, // patient's value
      unit: string, // unit (e.g. g/dL)
      indicatorPosition: number, // 0-100, where value falls in reference range (0=low, 100=high, 50=mid)
      referenceRange: {
        low: number, // lower limit (start of yellow)
        normal: { low: number, high: number }, // normal range (start/end of green)
        high: number // upper limit (start of red)
      },
      reasons: [string], // common reasons for abnormal results
      reasonDetails: [string], // 1-2 line simple explanation for each reason
      reasonIcons: [string], // emoji/icon for each reason
      indications: [string], // what these results may indicate
      indicationDetails: [string], // 1-2 line simple explanation for each indication
      indicationIcons: [string] // emoji/icon for each indication
    }
  ]
}

Reference Ranges:
${referenceText}

Patient Details:
Name: ${patientDetails.name}
Age: ${patientDetails.age}
Gender: ${patientDetails.gender}
Date: ${patientDetails.date}
Accession No: ${patientDetails.accessionNo}

Patient Report Text:
${text}

IMPORTANT:
- Fill in as many fields as possible, even if you have to make a best guess.
- If a value is missing, use "N/A". If a unit is missing, use "N/A". If a reference is missing, use the closest match from the reference section.
- Do NOT include any explanation or extra text, only the JSON object.
- Use all tokens and provide as much detail as possible.
`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10000,
        temperature: 0.3
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
        throw err;
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

    console.log("RAW PDF TEXT:\n", rawUserText);
    const userText = extractRelevantLines(rawUserText, 2000);
    patientDetails = extractPatientDetails(rawUserText);
    const referenceText = `
Hemoglobin: low <13.8 g/dL (men), <12.1 g/dL (women); normal 13.8–17.2 g/dL (men), 12.1–15.1 g/dL (women); high >17.2 g/dL (men), >15.1 g/dL (women)
RBC: low <4.7 million/mcL (men), <4.2 million/mcL (women); normal 4.7–6.1 million/mcL (men), 4.2–5.4 million/mcL (women); high >6.1 million/mcL (men), >5.4 million/mcL (women)
WBC: low <4,500 cells/mcL; normal 4,500–11,000 cells/mcL; high >11,000 cells/mcL
ALT (SGPT): low <7 U/L; normal 7–56 U/L; high >56 U/L
AST (SGOT): low <10 U/L; normal 10–40 U/L; high >40 U/L
Creatinine: low <0.74 mg/dL (men), <0.59 mg/dL (women); normal 0.74–1.35 mg/dL (men), 0.59–1.04 mg/dL (women); high >1.35 mg/dL (men), >1.04 mg/dL (women)
TSH: low <0.4 mIU/L; normal 0.4–4.0 mIU/L; high >4.0 mIU/L
Calcium: low <8.6 mg/dL; normal 8.6–10.2 mg/dL; high >10.2 mg/dL
Platelets: low <150,000 /mcL; normal 150,000–450,000 /mcL; high >450,000 /mcL
`;
    console.log("Reference Text:\n", referenceText);
    if (!referenceText || !referenceText.trim()) {
        return res.render('upload', { error: 'Reference text is empty.', title: 'Upload Blood Report' });
    }
    let gptJson;
    // const cachePath = path.join(__dirname, '../gpt_response_cache.json');
    try {
        let gptResponse;
        // Check if cache exists
        /*
        if (fs.existsSync(cachePath)) {
            console.log('Using cached GPT response.');
            gptResponse = fs.readFileSync(cachePath, 'utf-8');
        } else {
        */
            gptResponse = await getOpenAIReportJSON(userText, referenceText, patientDetails);
            // Clean numbers with commas before parsing
            gptResponse = gptResponse.replace(/(\d{1,3}),(\d{3})/g, '$1$2');
        /*
            fs.writeFileSync(cachePath, gptResponse, 'utf-8');
            console.log('GPT response cached.');
        }
        */
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
    // Map each test to set indicatorPosition for static bar (low=0, high=100, normal=20-80)
    gptJson.tests = gptJson.tests.map(test => {
        // Parse patient value as number
        let value = parseFloat(test.value);
        let low = test.referenceRange && typeof test.referenceRange.low === 'number' ? test.referenceRange.low : 0;
        let normalLow = test.referenceRange && test.referenceRange.normal && typeof test.referenceRange.normal.low === 'number' ? test.referenceRange.normal.low : 0;
        let normalHigh = test.referenceRange && test.referenceRange.normal && typeof test.referenceRange.normal.high === 'number' ? test.referenceRange.normal.high : 0;
        let high = test.referenceRange && typeof test.referenceRange.high === 'number' ? test.referenceRange.high : 0;
        // For static bar: low=0-20%, normal=20-80%, high=80-100%
        let indicatorPosition = 50; // default
        if (!isNaN(value) && low < high) {
            if (value < normalLow) {
                // Low section: map [low, normalLow) to [0, 20]
                indicatorPosition = 0 + ((value - low) / (normalLow - low)) * 20;
            } else if (value <= normalHigh) {
                // Normal section: map [normalLow, normalHigh] to [20, 80]
                indicatorPosition = 20 + ((value - normalLow) / (normalHigh - normalLow)) * 60;
            } else {
                // High section: map (normalHigh, high] to [80, 100]
                indicatorPosition = 80 + ((value - normalHigh) / (high - normalHigh)) * 20;
            }
            indicatorPosition = Math.max(0, Math.min(100, Math.round(indicatorPosition)));
        }
        return {
            ...test,
            indicatorPosition
        };
    });
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