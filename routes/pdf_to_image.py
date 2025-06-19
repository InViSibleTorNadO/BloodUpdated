import sys
from pdf2image import convert_from_path
import pytesseract

if len(sys.argv) < 3:
    print("Usage: python pdf_to_image.py <input_pdf> <output_txt>")
    sys.exit(1)

PDF_FILE = sys.argv[1]
OUTPUT_FILE = sys.argv[2]

try:
    images = convert_from_path(PDF_FILE, dpi=300)
except Exception as e:
    print(f"Error converting PDF: {e}")
    sys.exit(2)

full_text = ""
for i, image in enumerate(images):
    text = pytesseract.image_to_string(image)
    full_text += f"\n--- Page {i + 1} ---\n{text}"

try:
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(full_text)
except Exception as e:
    print(f"Error writing output: {e}")
    sys.exit(3)

print("OK")
