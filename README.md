# Bloodrest

An Express.js and MongoDB web application for blood report PDF processing.

## Features
- User login page (no CSS)
- Upload endpoints for two PDFs: user blood report and OpenAI API output (reference PDF)
- Backend logic for PDF processing and integration with OpenAI API (to be implemented)

## Setup
1. Install dependencies:
   ```
   npm install
   ```
2. Start MongoDB (make sure it is running on localhost:27017).
3. Run the app:
   ```
   npm start
   ```
4. Open http://localhost:3000/ in your browser.

## Usage
- Login with username: `user`, password: `pass`
- Upload your blood report and the reference PDF.

## To Do
- Implement PDF processing and OpenAI API integration.
