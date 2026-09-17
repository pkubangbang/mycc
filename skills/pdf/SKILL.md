---
name: pdf
description: >
  Reads PDF files into text — extracting text from text-based PDFs, or
  running OCR on scanned/image-based PDFs. Use this when you need to read a
  PDF, extract its text, or convert PDF content to plain text for analysis.
  Two workflows: text-based PDFs use `unpdf` (a modern zero-dependency
  library — create an isolated work dir, install it, run `extractText` with
  `getDocumentProxy`, verify the output); scanned/image-based PDFs use
  `pdf-to-img` (scale 3.0 for recognition) + `tesseract.js` OCR with reused
  workers. OCR supports English (eng), Simplified Chinese (chi_sim),
  Traditional Chinese (chi_tra), and combined (eng+chi_sim). Always uses
  isolated temp directories (`cd <dir> && npm install`) to avoid polluting
  the project.
keywords: [pdf, document, extraction, ocr, scan, text, image, unpdf, tesseract, read, parse, convert, processing]
---

# PDF Processing Skill

When working with PDF files, use **unpdf** - a modern, zero-dependency PDF library.

## Step 1: Extract Text (Create a Script)

The `npx unpdf extract` CLI command may not work on all systems. Instead, create a script in an isolated directory:

```bash
mkdir -p /tmp/pdf-work && cd /tmp/pdf-work && npm install unpdf
```

Then create the script:

```javascript
// extract-pdf.mjs
import { readFile, writeFile } from 'fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';

const pdfPath = process.argv[2];
const outputPath = process.argv[3];

const buffer = await readFile(pdfPath);
const pdf = await getDocumentProxy(new Uint8Array(buffer));
const { text } = await extractText(pdf, { mergePages: true });

await writeFile(outputPath, text);
console.log(`Extracted text saved to ${outputPath}`);
```

Run with:
```bash
cd /tmp/pdf-work && node extract-pdf.mjs /path/to/input.pdf /path/to/output.txt
```

## Step 2: Check Extraction
Always verify the extraction worked:
```bash
head -20 output.txt
```

## Step 3: Handle Image-Based (Scanned) PDFs

If unpdf extracts empty text, the PDF is likely image-based (scanned document). Use OCR instead:

### Install Required Packages

**IMPORTANT**: Always use `cd <dir> && <command>` pattern to avoid installing packages in unintended directories. Create an isolated temporary directory:

```bash
mkdir -p /tmp/pdf-work && cd /tmp/pdf-work && npm install pdf-to-img tesseract.js
```

Then create scripts in that directory:

```bash
cd /tmp/pdf-work && node ocr-pdf.cjs /path/to/input.pdf /path/to/output.txt
```

### Create OCR Script (CommonJS)
```javascript
// ocr-pdf.cjs
const { writeFile, readFileSync } = require('fs');
const { promisify } = require('util');
const writeFileAsync = promisify(writeFile);
const { pdf: pdfToImg } = require('pdf-to-img');
const { createWorker } = require('tesseract.js');

async function main(pdfPath, outputPath) {
  const buffer = readFileSync(pdfPath);
  
  // Convert PDF to images with higher scale for better OCR
  const pages = await pdfToImg(buffer, { scale: 3.0 });
  console.log('PDF pages:', pages.length);
  
  let fullText = '';
  let pageNum = 1;
  
  // Create worker once and reuse for better performance
  // Use 'eng' for English, 'chi_sim' for Simplified Chinese, or combine: 'eng+chi_sim'
  const worker = await createWorker('eng');
  
  for await (const page of pages) {
    console.log(`Processing page ${pageNum}...`);
    const { data: { text } } = await worker.recognize(page);
    fullText += `--- Page ${pageNum} ---\n${text}\n\n`;
    pageNum++;
  }
  
  await worker.terminate();
  await writeFileAsync(outputPath, fullText);
  console.log(`OCR text saved to ${outputPath}`);
}

const pdfPath = process.argv[2];
const outputPath = process.argv[3];
main(pdfPath, outputPath);
```

Run with:
```bash
cd /tmp/pdf-work && node ocr-pdf.cjs /path/to/input.pdf /path/to/output.txt
```

## Language Support for OCR

Tesseract.js supports multiple languages. Specify them when creating the worker:
- `'eng'` - English
- `'chi_sim'` - Simplified Chinese
- `'chi_tra'` - Traditional Chinese
- `'eng+chi_sim'` - English and Simplified Chinese combined

## Example Usage

### Text-based PDF
```bash
# Create work directory and install dependencies
mkdir -p /tmp/pdf-work && cd /tmp/pdf-work && npm install unpdf

# Create the extraction script (copy from Step 1 above)
# Then run:
cd /tmp/pdf-work && node extract-pdf.mjs /path/to/input.pdf /path/to/output.txt
```

### Image-based PDF (OCR)
```bash
# Create work directory and install dependencies
mkdir -p /tmp/pdf-work && cd /tmp/pdf-work && npm install pdf-to-img tesseract.js

# Create the OCR script (copy from Step 3 above)
# Then run:
cd /tmp/pdf-work && node ocr-pdf.cjs /path/to/input.pdf /path/to/output.txt
```