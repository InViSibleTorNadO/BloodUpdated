const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { OpenAI } = require('openai');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const puppeteer = require('puppeteer');
require('dotenv').config();
const ejs = require('ejs');
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
  - If abnormal, include it in the result JSON.
  - If normal, skip it.

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
`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.3
    });

    return response.choices[0].message.content;
}
function extractRelevantLines(text, maxLength = 2000) {
    const lines = text.split('\n').filter(line => /\d/.test(line));
    const joined = lines.join('\n');
    return joined.slice(0, maxLength);
}

function extractPatientDetails(text) {
    // Try to extract name, age, gender, date, accession no from the PDF text
    const nameMatch = text.match(/Name\s*[:\-]?\s*([A-Za-z .]+)/i);
    const ageMatch = text.match(/Age\s*[:\-]?\s*(\d{1,3})/i);
    const genderMatch = text.match(/Gender\s*[:\-]?\s*([A-Za-z]+)/i);
    const dateMatch = text.match(/Date\s*[:\-]?\s*([\d\/-]{6,})/i);
    const accessionMatch = text.match(/Accession\s*No\.?\s*[:\-]?\s*([A-Za-z0-9\/-]+)/i);
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
    if (!req.files['user_pdf']) {
        return res.render('upload', { error: 'Please upload PDF.', title: 'Upload Blood Report' });
    }
    const userPdfPath = req.files['user_pdf'][0].path;
    const userPdfBuffer = fs.readFileSync(userPdfPath);
    let rawUserText;
    try {
        rawUserText = (await pdfParse(userPdfBuffer)).text;
    } catch (e) {
        return res.render('upload', { error: 'Failed to parse PDF.', title: 'Upload Blood Report' });
    }
    const userText = extractRelevantLines(rawUserText, 2000);
    // Extract patient details from the PDF text
    const patientDetails = extractPatientDetails(rawUserText);
    console.log("Extracted Patient Details:", patientDetails);
    // Log and check extracted text
    console.log("Parsed Text:\n", userText);
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
        // Pass patient details in the prompt for OpenAI
        const gptResponse = await getOpenAIReportJSON(userText, referenceText, patientDetails);
        console.log("GPT Raw Output:\n", gptResponse);

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
    // Overwrite patient/report fields with extracted details if available
    gptJson.patient = {
        name: patientDetails.name || gptJson.patient?.name || 'Unknown',
        age: patientDetails.age || gptJson.patient?.age || 'N/A',
        gender: patientDetails.gender || gptJson.patient?.gender || 'N/A',
    };
    gptJson.report = {
        date: patientDetails.date || gptJson.report?.date || 'N/A',
        accessionNo: patientDetails.accessionNo || gptJson.report?.accessionNo || 'N/A',
    };
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